import { createHmac, timingSafeEqual } from 'node:crypto';

export const API_VERSION = '2026-10';

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const CLOCK_TOLERANCE_SECONDS = 10;
const REQUEST_TIMEOUT_MS = 10_000;

export function isShopDomain(value) {
  return typeof value === 'string' && SHOP_DOMAIN.test(value);
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyWebhookHmac(rawBody, hmacHeader, secret) {
  if (typeof hmacHeader !== 'string' || hmacHeader === '') return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
  return safeEqual(expected, hmacHeader);
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Returns { shop, userId } for a valid App Bridge session token, otherwise null. */
export function verifySessionToken(token, { apiKey, apiSecret, now = Date.now() }) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, signature] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (header?.alg !== 'HS256' || payload === null || typeof payload !== 'object') return null;

  const expected = createHmac('sha256', apiSecret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');
  if (!safeEqual(expected, signature)) return null;

  const nowSeconds = Math.floor(now / 1000);
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_TOLERANCE_SECONDS < nowSeconds) return null;
  if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_TOLERANCE_SECONDS > nowSeconds) return null;
  if (payload.aud !== apiKey) return null;

  const shop = hostnameOf(payload.dest);
  if (!isShopDomain(shop) || hostnameOf(payload.iss) !== shop) return null;

  return { shop, userId: payload.sub ?? null };
}

/** Trades a session token for a short-lived Admin API token. Nothing is stored. */
export async function exchangeToken({ shop, sessionToken, apiKey, apiSecret, fetchImpl = fetch }) {
  const response = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: apiKey,
      client_secret: apiSecret,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: sessionToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:online-access-token',
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Token exchange failed with HTTP ${response.status}`);
  const { access_token: accessToken } = await response.json();
  if (!accessToken) throw new Error('Token exchange returned no access token');
  return accessToken;
}

const PROFILE_QUERY = `{
  shop { name currencyCode }
  productsCount { count }
}`;

export async function fetchStoreProfile({ shop, accessToken, fetchImpl = fetch }) {
  const response = await fetchImpl(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify({ query: PROFILE_QUERY }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Admin API responded with HTTP ${response.status}`);
  const { data, errors } = await response.json();
  if (errors?.length || !data?.shop) throw new Error('Admin API returned no shop data');
  return {
    name: data.shop.name,
    currency: data.shop.currencyCode,
    productCount: data.productsCount?.count ?? null,
  };
}
