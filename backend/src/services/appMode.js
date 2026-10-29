const settings = require('./settings');
const jobsStore = require('./jobsStore');
const { demoJobs } = require('../demo');
const { audit } = require('./audit');

// Switching to demo loads the labelled samples; switching back deletes them (and anything attached to them).
async function setMode(db, mode) {
  if (!['demo', 'production'].includes(mode)) throw Object.assign(new Error('mode must be "demo" or "production"'), { status: 400 });
  await settings.set(db, 'app_mode', mode);
  let loaded = 0; let removed = 0;
  if (mode === 'demo') loaded = await jobsStore.upsertJobs(db, demoJobs());
  else removed = (await db.prepare("DELETE FROM jobs WHERE source = 'demo'").run()).changes;
  await audit(db, `mode_${mode}`, { entity: 'app_mode', detail: { loaded, removed } });
  return { mode, loaded, removed };
}

module.exports = { setMode, getMode: jobsStore.getMode };
