// `npm run migrate`: apply pending migrations and print the schema status.
const { openDb, migrationStatus } = require('./db');
(async () => {
  const db = await openDb();
  const s = await migrationStatus(db);
  console.log(`Applied: ${s.applied.map((m) => m.id).join(', ') || 'none'}\nPending: ${s.pending.join(', ') || 'none'}`);
  await db.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
