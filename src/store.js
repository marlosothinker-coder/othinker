import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS shops (
    shop TEXT PRIMARY KEY,
    installed_at INTEGER NOT NULL,
    profile_json TEXT,
    profile_fetched_at INTEGER,
    selections_json TEXT
  );
  CREATE TABLE IF NOT EXISTS connector_checks (
    connector_id TEXT PRIMARY KEY,
    ok INTEGER NOT NULL,
    detail TEXT NOT NULL,
    checked_at INTEGER NOT NULL
  );
`;

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  const parse = (json) => (json ? JSON.parse(json) : null);

  return {
    getShop(shop) {
      const row = db.prepare('SELECT * FROM shops WHERE shop = ?').get(shop);
      if (!row) return null;
      return {
        shop: row.shop,
        profile: parse(row.profile_json),
        profileFetchedAt: row.profile_fetched_at,
        selections: parse(row.selections_json),
      };
    },
    ensureShop(shop, now) {
      db.prepare('INSERT OR IGNORE INTO shops (shop, installed_at) VALUES (?, ?)').run(shop, now);
    },
    saveProfile(shop, profile, now) {
      db.prepare('UPDATE shops SET profile_json = ?, profile_fetched_at = ? WHERE shop = ?').run(
        JSON.stringify(profile),
        now,
        shop,
      );
    },
    saveSelections(shop, selections) {
      db.prepare('UPDATE shops SET selections_json = ? WHERE shop = ?').run(JSON.stringify(selections), shop);
    },
    deleteShop(shop) {
      db.prepare('DELETE FROM shops WHERE shop = ?').run(shop);
    },
    saveCheck(connectorId, { ok, detail }, now) {
      db.prepare(
        `INSERT INTO connector_checks (connector_id, ok, detail, checked_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (connector_id) DO UPDATE SET ok = excluded.ok, detail = excluded.detail, checked_at = excluded.checked_at`,
      ).run(connectorId, ok ? 1 : 0, detail, now);
    },
    getChecks() {
      const rows = db.prepare('SELECT * FROM connector_checks').all();
      return Object.fromEntries(
        rows.map((row) => [row.connector_id, { ok: row.ok === 1, detail: row.detail, checkedAt: row.checked_at }]),
      );
    },
    lastCheckAt() {
      return db.prepare('SELECT MAX(checked_at) AS latest FROM connector_checks').get().latest ?? null;
    },
    close() {
      db.close();
    },
  };
}
