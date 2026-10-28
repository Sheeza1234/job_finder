const config = require('./config');
const { assertSafeBind } = require('./bind');
const { openDb } = require('./db');
const { createApp } = require('./app');

try { assertSafeBind(config.host, config.appPassword, process.env.ALLOW_INSECURE === 'true'); } catch (e) { console.error(e.message); process.exit(1); }

(async () => {
  let db;
  try { db = await openDb(); } catch (e) { console.error(`Could not connect to the database: ${e.message}`); process.exit(1); }
  if (config.schedulerEnabled) require('./services/scheduler').start(db);
  createApp(db).listen(config.port, config.host, () => {
    console.log(`Job Finder running at http://${config.host}:${config.port}`);
    if (!config.aiKey) console.log('Note: no AI key set (ANTHROPIC_API_KEY or AI_API_KEY) - AI features disabled.');
    if (!config.appPassword) console.log('Note: APP_PASSWORD not set - fine while only reachable from this computer.');
  });
})();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => require('./services/browserAssist').closeAll().finally(() => process.exit(0)));
}
