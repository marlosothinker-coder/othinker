import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, beforeEach, test } from 'node:test';
import { createApp } from '../src/server.js';
import { openStore } from '../src/store.js';
import { API_KEY, API_SECRET, SHOP, signSessionToken, signWebhook } from './helpers.js';

const config = { apiKey: API_KEY, apiSecret: API_SECRET, supportEmail: 'help@orbitpros.test' };

let store;
let server;
let base;
let shopifyCalls;
let shopifyUp;

function fakeShopify(url) {
  shopifyCalls.push(url);
  if (!shopifyUp) return Promise.resolve(new Response('{}', { status: 503 }));
  if (url.endsWith('/admin/oauth/access_token')) return Promise.resolve(Response.json({ access_token: 'shpat_once' }));
  return Promise.resolve(
    Response.json({ data: { shop: { name: 'Demo Store', currencyCode: 'USD' }, productsCount: { count: 214 } } }),
  );
}

beforeEach(async () => {
  store = openStore(':memory:');
  shopifyCalls = [];
  shopifyUp = true;
  server = createServer(createApp({ config, store, fetchImpl: fakeShopify }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
});

const authed = (token = signSessionToken()) => ({ Authorization: `Bearer ${token}` });

function postWebhook(path, payload, { topic, hmac } = {}) {
  const body = JSON.stringify(payload);
  return fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Topic': topic ?? '',
      'X-Shopify-Hmac-Sha256': hmac ?? signWebhook(body),
    },
    body,
  });
}

const saveSelections = (body, token) =>
  fetch(`${base}/api/selections`, {
    method: 'PUT',
    headers: { ...authed(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('API refuses requests without a valid session token', async () => {
  for (const headers of [{}, { Authorization: 'Bearer garbage' }, authed(signSessionToken({}, { secret: 'wrong' }))]) {
    const response = await fetch(`${base}/api/state`, { headers });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('x-shopify-retry-invalid-session-request'), '1');
  }
  assert.equal(shopifyCalls.length, 0);
});

test('first load reads the store profile from Shopify and tailors the prompts', async () => {
  const state = await (await fetch(`${base}/api/state`, { headers: authed() })).json();
  assert.deepEqual(state.shop, { domain: SHOP, name: 'Demo Store' });
  assert.equal(state.assistant, 'claude');

  const shopify = state.connectors.find((connector) => connector.id === 'shopify');
  assert.equal(shopify.uses, true);
  assert.equal(shopify.connected, false);
  assert.match(shopify.prompts[0], /my 214 products/);
  assert.match(state.connectors.find((connector) => connector.id === 'quickbooks').prompts[0], /Demo Store/);
});

test('store profile is cached instead of fetched on every load', async () => {
  await fetch(`${base}/api/state`, { headers: authed() });
  await fetch(`${base}/api/state`, { headers: authed() });
  assert.equal(shopifyCalls.length, 2);
});

test('checklist still loads when Shopify cannot be reached', async () => {
  shopifyUp = false;
  const response = await fetch(`${base}/api/state`, { headers: authed() });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.shop.name, null);
  assert.equal(state.connectors[0].prompts[0], 'Which of my products will run out of stock first at the current sales rate?');
});

test('selections are saved per shop and returned on the next load', async () => {
  const saved = await saveSelections({ assistant: 'chatgpt', tools: { slack: { uses: true, connected: true }, bogus: { uses: true } } });
  assert.equal(saved.status, 200);

  const state = await (await fetch(`${base}/api/state`, { headers: authed() })).json();
  assert.equal(state.assistant, 'chatgpt');
  assert.deepEqual(
    state.connectors.filter((connector) => connector.connected).map((connector) => connector.id),
    ['slack'],
  );

  const otherShop = signSessionToken({ dest: 'https://other-store.myshopify.com', iss: 'https://other-store.myshopify.com/admin' });
  const other = await (await fetch(`${base}/api/state`, { headers: authed(otherShop) })).json();
  assert.equal(other.assistant, 'claude');
  assert.equal(other.connectors.some((connector) => connector.connected), false);
});

test('invalid selections are rejected', async () => {
  for (const body of [{}, { assistant: 'gemini', tools: {} }, { assistant: 'claude' }, { assistant: 'claude', tools: null }]) {
    assert.equal((await saveSelections(body)).status, 400);
  }
  const notJson = await fetch(`${base}/api/selections`, { method: 'PUT', headers: authed(), body: '{oops' });
  assert.equal(notJson.status, 400);
});

test('compliance webhooks return 401 for a bad signature and 200 for a good one', async () => {
  const payload = { shop_id: 1, shop_domain: SHOP, customer: { id: 7 } };
  for (const topic of ['customers/data_request', 'customers/redact', 'shop/redact']) {
    assert.equal((await postWebhook('/webhooks/compliance', payload, { topic, hmac: 'bm90LXZhbGlk' })).status, 401);
    assert.equal((await postWebhook('/webhooks/compliance', payload, { topic })).status, 200);
  }
  const unsigned = await fetch(`${base}/webhooks/compliance`, { method: 'POST', body: JSON.stringify(payload) });
  assert.equal(unsigned.status, 401);
});

test('shop/redact erases everything stored for the shop', async () => {
  await saveSelections({ assistant: 'chatgpt', tools: {} });
  assert.notEqual(store.getShop(SHOP), null);

  const forged = await postWebhook('/webhooks/compliance', { shop_domain: SHOP }, { topic: 'shop/redact', hmac: 'bm90LXZhbGlk' });
  assert.equal(forged.status, 401);
  assert.notEqual(store.getShop(SHOP), null);

  await postWebhook('/webhooks/compliance', { shop_domain: SHOP }, { topic: 'shop/redact' });
  assert.equal(store.getShop(SHOP), null);
});

test('customer webhooks leave shop data alone', async () => {
  await saveSelections({ assistant: 'chatgpt', tools: {} });
  await postWebhook('/webhooks/compliance', { shop_domain: SHOP, customer: { id: 7 } }, { topic: 'customers/redact' });
  assert.notEqual(store.getShop(SHOP), null);
});

test('uninstall erases the shop', async () => {
  await saveSelections({ assistant: 'chatgpt', tools: {} });
  const response = await postWebhook('/webhooks/app/uninstalled', { id: 1, myshopify_domain: SHOP }, { topic: 'app/uninstalled' });
  assert.equal(response.status, 200);
  assert.equal(store.getShop(SHOP), null);
});

test('embedded page may only be framed by the shop admin', async () => {
  const response = await fetch(`${base}/?shop=${SHOP}&embedded=1`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-security-policy'), `frame-ancestors https://${SHOP} https://admin.shopify.com`);
  assert.match(await response.text(), new RegExp(`<meta name="shopify-api-key" content="${API_KEY}">`));
});

test('opening the app outside the admin sends the merchant back into it', async () => {
  const response = await fetch(`${base}/?shop=${SHOP}`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), `https://${SHOP}/admin/apps/${API_KEY}`);
});

test('a missing or forged shop parameter gets the standalone page, never a redirect', async () => {
  for (const query of ['', '?shop=evil.example.com', '?shop=demo.myshopify.com.evil.io&embedded=1']) {
    const response = await fetch(`${base}/${query}`, { redirect: 'manual' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'none'");
  }
});

test('privacy page shows the support contact', async () => {
  const response = await fetch(`${base}/privacy`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /help@orbitpros\.test/);
});

test('unknown paths and methods are refused', async () => {
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  assert.equal((await fetch(`${base}/src/server.js`)).status, 404);
  assert.equal((await fetch(`${base}/privacy`, { method: 'POST' })).status, 405);
});
