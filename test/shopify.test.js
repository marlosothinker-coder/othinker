import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exchangeToken, fetchStoreProfile, verifySessionToken, verifyWebhookHmac } from '../src/shopify.js';
import { API_KEY, API_SECRET, SHOP, signSessionToken, signWebhook } from './helpers.js';

const keys = { apiKey: API_KEY, apiSecret: API_SECRET };

test('webhook HMAC accepts the signature Shopify would send', () => {
  const body = Buffer.from('{"shop_domain":"demo-store.myshopify.com"}');
  assert.equal(verifyWebhookHmac(body, signWebhook(body), API_SECRET), true);
});

test('webhook HMAC rejects a wrong, tampered or missing signature', () => {
  const body = Buffer.from('{"shop_domain":"demo-store.myshopify.com"}');
  assert.equal(verifyWebhookHmac(body, signWebhook(body, 'other-secret'), API_SECRET), false);
  assert.equal(verifyWebhookHmac(Buffer.from('{"shop_domain":"evil"}'), signWebhook(body), API_SECRET), false);
  assert.equal(verifyWebhookHmac(body, undefined, API_SECRET), false);
  assert.equal(verifyWebhookHmac(body, '', API_SECRET), false);
});

test('session token yields the shop it was issued for', () => {
  assert.deepEqual(verifySessionToken(signSessionToken(), keys), { shop: SHOP, userId: '42' });
});

test('session token is rejected when any check fails', () => {
  const past = Math.floor(Date.now() / 1000) - 3600;
  const future = Math.floor(Date.now() / 1000) + 3600;
  const rejected = {
    'wrong secret': signSessionToken({}, { secret: 'other-secret' }),
    'unsigned algorithm': signSessionToken({}, { alg: 'none' }),
    expired: signSessionToken({ exp: past }),
    'not yet valid': signSessionToken({ nbf: future }),
    'other app audience': signSessionToken({ aud: 'another-app' }),
    'non-Shopify destination': signSessionToken({ dest: 'https://evil.example.com', iss: 'https://evil.example.com/admin' }),
    'issuer and destination differ': signSessionToken({ iss: 'https://other-store.myshopify.com/admin' }),
    'lookalike domain': signSessionToken({ dest: 'https://demo.myshopify.com.evil.io', iss: 'https://demo.myshopify.com.evil.io/admin' }),
    malformed: 'not-a-token',
    missing: undefined,
  };
  for (const [reason, token] of Object.entries(rejected)) {
    assert.equal(verifySessionToken(token, keys), null, reason);
  }
});

test('session token payload cannot be swapped after signing', () => {
  const [header, , signature] = signSessionToken().split('.');
  const forged = Buffer.from(JSON.stringify({ dest: 'https://victim.myshopify.com', aud: API_KEY, exp: 9e9 })).toString('base64url');
  assert.equal(verifySessionToken(`${header}.${forged}.${signature}`, keys), null);
});

test('token exchange posts the session token to the shop and returns the access token', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return Response.json({ access_token: 'shpat_once' });
  };
  const token = await exchangeToken({ shop: SHOP, sessionToken: 'session.jwt', ...keys, fetchImpl });
  assert.equal(token, 'shpat_once');
  assert.equal(request.url, `https://${SHOP}/admin/oauth/access_token`);
  assert.equal(request.body.grant_type, 'urn:ietf:params:oauth:grant-type:token-exchange');
  assert.equal(request.body.subject_token, 'session.jwt');
  assert.equal(request.body.client_secret, API_SECRET);
});

test('token exchange surfaces a refusal', async () => {
  const fetchImpl = async () => new Response('{}', { status: 400 });
  await assert.rejects(exchangeToken({ shop: SHOP, sessionToken: 'x', ...keys, fetchImpl }), /HTTP 400/);
});

test('store profile is read from the Admin GraphQL API', async () => {
  const fetchImpl = async (url, options) => {
    assert.match(url, new RegExp(`^https://${SHOP}/admin/api/\\d{4}-\\d{2}/graphql\\.json$`));
    assert.equal(options.headers['X-Shopify-Access-Token'], 'shpat_once');
    return Response.json({ data: { shop: { name: 'Demo Store', currencyCode: 'USD' }, productsCount: { count: 214 } } });
  };
  const profile = await fetchStoreProfile({ shop: SHOP, accessToken: 'shpat_once', fetchImpl });
  assert.deepEqual(profile, { name: 'Demo Store', currency: 'USD', productCount: 214 });
});

test('store profile rejects a GraphQL error response', async () => {
  const fetchImpl = async () => Response.json({ errors: [{ message: 'Access denied' }] });
  await assert.rejects(fetchStoreProfile({ shop: SHOP, accessToken: 'x', fetchImpl }), /no shop data/);
});
