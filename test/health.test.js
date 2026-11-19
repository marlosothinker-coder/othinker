import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHECK_INTERVAL_MS, checkConnectors, checkConnectorsIfDue, probe } from '../src/health.js';
import { openStore } from '../src/store.js';

const respondWith = (status) => async () => new Response(null, { status });
const unreachable = async () => {
  throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
};

test('an auth challenge counts as up, a server error or no answer as down', async () => {
  assert.deepEqual(await probe('https://x.test', respondWith(200)), { ok: true, detail: 'HTTP 200' });
  assert.deepEqual(await probe('https://x.test', respondWith(401)), { ok: true, detail: 'HTTP 401' });
  assert.deepEqual(await probe('https://x.test', respondWith(503)), { ok: false, detail: 'HTTP 503' });
  assert.deepEqual(await probe('https://x.test', unreachable), { ok: false, detail: 'ENOTFOUND' });
});

test('only connectors with a probe URL are checked and recorded', async () => {
  const store = openStore(':memory:');
  const connectors = [
    { id: 'up', probeUrl: 'https://up.test' },
    { id: 'down', probeUrl: 'https://down.test' },
    { id: 'unverified', probeUrl: null },
  ];
  const fetchImpl = (url) => (url.includes('down') ? unreachable() : respondWith(401)());

  await checkConnectors({ connectors, store, fetchImpl, now: 1000 });

  assert.deepEqual(store.getChecks(), {
    up: { ok: true, detail: 'HTTP 401', checkedAt: 1000 },
    down: { ok: false, detail: 'ENOTFOUND', checkedAt: 1000 },
  });
  store.close();
});

test('a later check replaces the earlier result', async () => {
  const store = openStore(':memory:');
  const connectors = [{ id: 'slack', probeUrl: 'https://slack.test' }];
  await checkConnectors({ connectors, store, fetchImpl: respondWith(503), now: 1000 });
  await checkConnectors({ connectors, store, fetchImpl: respondWith(401), now: 2000 });
  assert.deepEqual(store.getChecks().slack, { ok: true, detail: 'HTTP 401', checkedAt: 2000 });
  store.close();
});

test('checks run at most once a week', async () => {
  const store = openStore(':memory:');
  const connectors = [{ id: 'slack', probeUrl: 'https://slack.test' }];
  let probes = 0;
  const fetchImpl = async () => {
    probes += 1;
    return new Response(null, { status: 401 });
  };
  const start = 1_000_000;

  await checkConnectorsIfDue({ connectors, store, fetchImpl, now: start });
  await checkConnectorsIfDue({ connectors, store, fetchImpl, now: start + CHECK_INTERVAL_MS - 1 });
  assert.equal(probes, 1);

  await checkConnectorsIfDue({ connectors, store, fetchImpl, now: start + CHECK_INTERVAL_MS });
  assert.equal(probes, 2);
  store.close();
});
