import { createHmac } from 'node:crypto';

export const API_KEY = 'test-api-key';
export const API_SECRET = 'test-api-secret';
export const SHOP = 'demo-store.myshopify.com';

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function signSessionToken(claims = {}, { secret = API_SECRET, alg = 'HS256', now = Date.now() } = {}) {
  const seconds = Math.floor(now / 1000);
  const header = encode({ alg, typ: 'JWT' });
  const payload = encode({
    iss: `https://${SHOP}/admin`,
    dest: `https://${SHOP}`,
    aud: API_KEY,
    sub: '42',
    exp: seconds + 60,
    nbf: seconds,
    iat: seconds,
    ...claims,
  });
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function signWebhook(body, secret = API_SECRET) {
  return createHmac('sha256', secret).update(body).digest('base64');
}
