import { readFileSync } from 'node:fs';
import { ASSISTANTS, CONNECTORS, CONNECTOR_IDS, fillPrompt } from './catalog.js';
import { exchangeToken, fetchStoreProfile, isShopDomain, verifySessionToken, verifyWebhookHmac } from './shopify.js';

const PUBLIC_DIR = new URL('../public/', import.meta.url);
const MAX_BODY_BYTES = 1024 * 1024;
const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;

const readPublic = (name) => readFileSync(new URL(name, PUBLIC_DIR), 'utf8');
const escapeHtml = (value) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return undefined;
  }
}

function parseSelections(input) {
  if (!ASSISTANTS.includes(input?.assistant)) return null;
  if (input.tools === null || typeof input.tools !== 'object') return null;
  const tools = {};
  for (const id of CONNECTOR_IDS) {
    tools[id] = { uses: input.tools[id]?.uses === true, connected: input.tools[id]?.connected === true };
  }
  return { assistant: input.assistant, tools };
}

function buildState(record, checks) {
  const selections = record.selections ?? { assistant: ASSISTANTS[0], tools: {} };
  return {
    shop: { domain: record.shop, name: record.profile?.name ?? null },
    assistant: selections.assistant,
    connectors: CONNECTORS.map((connector) => {
      const check = checks[connector.id];
      return {
        id: connector.id,
        name: connector.name,
        category: connector.category,
        why: connector.why,
        required: connector.required === true,
        steps: connector.steps,
        prompts: connector.prompts.map((prompt) => fillPrompt(prompt, record.profile)),
        uses: connector.required === true || selections.tools[connector.id]?.uses === true,
        connected: selections.tools[connector.id]?.connected === true,
        health: check ? { ok: check.ok, checkedAt: check.checkedAt } : null,
      };
    }),
  };
}

export function createApp({ config, store, fetchImpl = fetch, now = Date.now }) {
  const pages = {
    index: readPublic('index.html').replace('%SHOPIFY_API_KEY%', escapeHtml(config.apiKey)),
    standalone: readPublic('standalone.html'),
    privacy: readPublic('privacy.html').replaceAll('%SUPPORT_EMAIL%', escapeHtml(config.supportEmail)),
  };
  const assets = {
    '/app.js': { body: readPublic('app.js'), type: 'text/javascript; charset=utf-8' },
    '/app.css': { body: readPublic('app.css'), type: 'text/css; charset=utf-8' },
  };
  const html = { 'Content-Type': 'text/html; charset=utf-8' };

  function authenticate(req) {
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer') return null;
    const session = verifySessionToken(token, { apiKey: config.apiKey, apiSecret: config.apiSecret, now: now() });
    return session && { ...session, token };
  }

  async function refreshProfile(session) {
    try {
      const accessToken = await exchangeToken({
        shop: session.shop,
        sessionToken: session.token,
        apiKey: config.apiKey,
        apiSecret: config.apiSecret,
        fetchImpl,
      });
      const profile = await fetchStoreProfile({ shop: session.shop, accessToken, fetchImpl });
      store.saveProfile(session.shop, profile, now());
    } catch (error) {
      // The checklist still works without store details, so a failed lookup is not fatal.
      console.error(`Store profile lookup failed for ${session.shop}: ${error.message}`);
    }
  }

  async function handleApi(req, res, url) {
    const session = authenticate(req);
    if (!session) {
      return sendJson(res, 401, { error: 'Invalid session token' }, { 'X-Shopify-Retry-Invalid-Session-Request': '1' });
    }
    store.ensureShop(session.shop, now());

    if (url.pathname === '/api/state' && req.method === 'GET') {
      const record = store.getShop(session.shop);
      if (record.profileFetchedAt === null || now() - record.profileFetchedAt > PROFILE_TTL_MS) {
        await refreshProfile(session);
      }
      return sendJson(res, 200, buildState(store.getShop(session.shop), store.getChecks()));
    }

    if (url.pathname === '/api/selections' && req.method === 'PUT') {
      const body = await readBody(req);
      const selections = body && parseSelections(parseJson(body));
      if (!selections) return sendJson(res, 400, { error: 'Invalid selections' });
      store.saveSelections(session.shop, selections);
      return sendJson(res, 200, buildState(store.getShop(session.shop), store.getChecks()));
    }

    return sendJson(res, 404, { error: 'Not found' });
  }

  async function handleWebhook(req, res, url) {
    const body = await readBody(req);
    if (!body || !verifyWebhookHmac(body, req.headers['x-shopify-hmac-sha256'], config.apiSecret)) {
      return send(res, 401, 'Invalid webhook signature');
    }
    const payload = parseJson(body);
    if (payload === undefined) return send(res, 400, 'Invalid JSON');

    if (url.pathname === '/webhooks/app/uninstalled') {
      if (isShopDomain(payload?.myshopify_domain)) store.deleteShop(payload.myshopify_domain);
      return send(res, 200, 'ok');
    }

    // The app keeps no customer records, so customers/data_request and
    // customers/redact have nothing to export or erase.
    const topic = req.headers['x-shopify-topic'];
    if (topic === 'shop/redact' && isShopDomain(payload?.shop_domain)) store.deleteShop(payload.shop_domain);
    console.log(`Compliance webhook handled: ${topic}`);
    return send(res, 200, 'ok');
  }

  function handlePage(res, url) {
    const shop = url.searchParams.get('shop');
    if (!isShopDomain(shop)) {
      return send(res, 200, pages.standalone, { ...html, 'Content-Security-Policy': "frame-ancestors 'none'" });
    }
    if (url.searchParams.get('embedded') !== '1') {
      return send(res, 302, '', { Location: `https://${shop}/admin/apps/${encodeURIComponent(config.apiKey)}` });
    }
    return send(res, 200, pages.index, {
      ...html,
      'Content-Security-Policy': `frame-ancestors https://${shop} https://admin.shopify.com`,
    });
  }

  return async function app(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method === 'POST' && (url.pathname === '/webhooks/compliance' || url.pathname === '/webhooks/app/uninstalled')) {
        return await handleWebhook(req, res, url);
      }
      if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
      if (url.pathname === '/') return handlePage(res, url);
      if (url.pathname === '/privacy') return send(res, 200, pages.privacy, html);
      const asset = assets[url.pathname];
      if (asset) return send(res, 200, asset.body, { 'Content-Type': asset.type });
      return send(res, 404, 'Not found');
    } catch (error) {
      console.error(error);
      if (!res.headersSent) send(res, 500, 'Internal error');
    }
  };
}
