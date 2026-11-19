const PROBE_TIMEOUT_MS = 10_000;
export const CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

// An auth challenge (401/403) still proves the connector is up; only a
// server error or no answer at all counts as down.
export async function probe(url, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return { ok: response.status < 500, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, detail: error.cause?.code ?? error.name };
  }
}

export async function checkConnectors({ connectors, store, fetchImpl = fetch, now = Date.now() }) {
  const probed = connectors.filter((connector) => connector.probeUrl);
  const results = await Promise.all(probed.map((connector) => probe(connector.probeUrl, fetchImpl)));
  probed.forEach((connector, index) => store.saveCheck(connector.id, results[index], now));
  return Object.fromEntries(probed.map((connector, index) => [connector.id, results[index]]));
}

export async function checkConnectorsIfDue(options) {
  const now = options.now ?? Date.now();
  const last = options.store.lastCheckAt();
  if (last !== null && now - last < CHECK_INTERVAL_MS) return null;
  return checkConnectors({ ...options, now });
}
