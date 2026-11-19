import { CONNECTORS } from './catalog.js';
import { checkConnectors } from './health.js';
import { openStore } from './store.js';

const store = openStore(process.env.DATABASE_PATH ?? './data/app.sqlite');
const results = await checkConnectors({ connectors: CONNECTORS, store });
for (const [id, result] of Object.entries(results)) {
  console.log(`${result.ok ? 'up  ' : 'DOWN'} ${id} (${result.detail})`);
}
store.close();
