const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const credentials = require('../src/services/credentials');
const providers = require('../src/providers');
const { startApp } = require('./helpers');

const KEY = 'jooble-test-key-1234567890';
const enabled = (id) => providers.all.find((p) => p.id === id).enabled();

test('a job-source key entered in the app is encrypted, write-only, and enables the source immediately', async () => {
  const old = config.appSecret; config.appSecret = 'test-secret-at-least-16-chars';
  const t = await startApp();
  try {
    assert.equal(enabled('jooble'), false);
    const st = (await t.call('GET', '/api/settings/job-sources')).body.find((s) => s.id === 'jooble');
    assert.equal(st.hasKey, false); assert.match(st.signup, /jooble\.org/); assert.equal(st.free, true);

    assert.equal((await t.call('PUT', '/api/settings/job-sources/jooble', { key: 'has spaces in it' })).status, 400);
    assert.equal((await t.call('PUT', '/api/settings/job-sources/nope', { key: KEY })).status, 404);
    const saved = await t.call('PUT', '/api/settings/job-sources/jooble', { key: KEY });
    assert.equal(saved.status, 200); assert.deepEqual(saved.body.find((s) => s.id === 'jooble'), { ...st, hasKey: true, from: 'app' });
    assert.equal(enabled('jooble'), true);
    assert.equal((await t.call('GET', '/api/integrations')).body.find((i) => i.id === 'jooble').state, 'configured');

    for (const u of ['/api/settings/job-sources', '/api/integrations', '/api/status', '/api/readiness', '/api/privacy/export', '/api/audit?limit=100']) assert.ok(!JSON.stringify((await t.call('GET', u)).body).includes(KEY), `${u} leaks the key`);
    assert.ok(!(await t.db.prepare("SELECT value FROM settings WHERE key = 'provider_keys'").get()).value.includes(KEY), 'stored encrypted');

    // the provider really uses it
    const realFetch = globalThis.fetch; let url = '';
    globalThis.fetch = async (u) => { url = String(u); return { ok: true, json: async () => ({ jobs: [] }) }; };
    try { await providers.all.find((p) => p.id === 'jooble').search({ keyword: 'developer', city: 'Riyadh' }); } finally { globalThis.fetch = realFetch; }
    assert.equal(url, `https://sa.jooble.org/api/${KEY}`);

    await credentials.load(t.db); assert.equal(enabled('jooble'), true, 'survives a restart (reloaded from the database)');
    await t.call('PUT', '/api/settings/job-sources/jooble', { key: '' }); assert.equal(enabled('jooble'), false, 'removing the key disables it');
    await t.call('PUT', '/api/settings/job-sources/jooble', { key: KEY });
    await t.call('DELETE', '/api/privacy/data', { confirm: 'DELETE MY DATA' }); assert.equal(enabled('jooble'), false, 'deleting all data also removes saved keys');
  } finally { await credentials.load(t.db); config.appSecret = old; await t.close(); }
});

test('without APP_SECRET the key is refused with a clear message, never stored in plain text', async () => {
  const old = config.appSecret; config.appSecret = '';
  const t = await startApp();
  try {
    const r = await t.call('PUT', '/api/settings/job-sources/jooble', { key: KEY });
    assert.equal(r.status, 400); assert.match(r.body.error, /APP_SECRET/); assert.equal(enabled('jooble'), false);
    assert.equal((await t.db.prepare("SELECT COUNT(*) n FROM settings WHERE key = 'provider_keys'").get()).n, 0);
  } finally { config.appSecret = old; await t.close(); }
});
