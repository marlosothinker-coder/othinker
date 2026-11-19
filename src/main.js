import { createServer } from 'node:http';
import { CONNECTORS } from './catalog.js';
import { loadConfig } from './config.js';
import { checkConnectorsIfDue } from './health.js';
import { createApp } from './server.js';
import { openStore } from './store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const config = loadConfig();
const store = openStore(config.databasePath);

const runChecks = () =>
  checkConnectorsIfDue({ connectors: CONNECTORS, store }).catch((error) => console.error('Connector check failed', error));
runChecks();
setInterval(runChecks, DAY_MS).unref();

createServer(createApp({ config, store })).listen(config.port, () => {
  console.log(`Listening on port ${config.port}`);
});
