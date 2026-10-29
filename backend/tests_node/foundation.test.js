const test = require('node:test');
const assert = require('node:assert/strict');
const { migrate, migrationStatus } = require('../src/db');
const { upsertJobs, listJobs } = require('../src/services/jobsStore');
const { buildJob } = require('../src/normalize');
const { assertSafeBind } = require('../src/bind');
const scheduler = require('../src/services/scheduler');
const health = require('../src/services/health');
const providers = require('../src/providers');
const config = require('../src/config');
const { startApp, SAMPLE_PROFILE, newDb } = require('./helpers');

const mk = (o) => buildJob({ source: 'a', externalId: o.id, title: 'Brand Designer', company: 'Acme', locationText: 'Riyadh, Saudi Arabia', description: 'Brand designer role. Figma.', ...o });

test('tests cannot reach the real internet (so they can never submit a real application)', async () => {
  await assert.rejects(fetch('https://example.com/'), /Network blocked in tests/);
  await assert.rejects(fetch('https://api.anthropic.com/v1/messages', { method: 'POST' }), /Network blocked/);
});

test('migrations: a fresh database is migrated once, a second run applies nothing, and the schema is locked down', async () => {
  const db = await newDb();
  const st = await migrationStatus(db);
  assert.deepEqual(st.pending, []); assert.equal(st.applied.length, 1);
  assert.deepEqual(await migrate(db), [], 'second run applies nothing');
  const open = await db.prepare('SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND NOT rowsecurity').all();
  assert.deepEqual(open, [], 'row-level security is on for every table, so the public Supabase key sees nothing');
});

test('de-duplication across sources: merged, hidden, enriched, and never double-notified', async () => {
  const db = await newDb();
  const ids = [];
  await upsertJobs(db, [mk({ id: '1', source: 'jooble' })], ids);
  await upsertJobs(db, [mk({ id: '77', source: 'jsearch', salaryMin: 9000, salaryMax: 12000, salaryCurrency: 'SAR', expiresAt: '2026-12-01T00:00:00.000Z' })], ids);
  assert.equal(ids.length, 1, 'only the first sighting counts as new');
  assert.equal((await listJobs(db, {})).total, 1);
  const canon = (await db.prepare('SELECT * FROM jobs WHERE source = ?').get('jooble'));
  assert.equal(canon.salary_min, 9000); assert.equal(canon.expires_at, '2026-12-01T00:00:00.000Z', 'details merged into the original');
  assert.equal((await db.prepare('SELECT duplicate_of FROM jobs WHERE source = ?').get('jsearch')).duplicate_of, canon.id);
  assert.equal((await require('../src/services/jobsStore').alsoListedOn(db, canon.id)).length, 1);

  await upsertJobs(db, [mk({ id: '1', source: 'jooble', description: 'Updated text' })]);           // same source refresh updates in place
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM jobs').get()).n, 2);
  assert.equal((await db.prepare('SELECT description FROM jobs WHERE id = ?').get(canon.id)).description, 'Updated text');
  await upsertJobs(db, [mk({ id: '5', source: 'x', locationText: 'Jeddah, Saudi Arabia' })]);       // different city: a different job
  await upsertJobs(db, [mk({ id: '6', source: 'manual' })]);                                          // the user's own import is never hidden
  await upsertJobs(db, [mk({ id: '7', source: 'y', company: null })]);                                // no employer: too weak to merge on
  await upsertJobs(db, [mk({ id: '8', source: 'z', company: null })]);
  assert.equal((await listJobs(db, {})).total, 5);
  const byUrl = []; await upsertJobs(db, [mk({ id: 'u1', source: 'p', company: 'Other', title: 'Unique Title', url: 'https://x.test/j/1' }), mk({ id: 'u2', source: 'q', company: 'Other2', title: 'Another', url: 'https://x.test/j/1' })], byUrl);
  assert.equal(byUrl.length, 1, 'same listing URL from two sources is one job');
});

test('the scheduler notifies once for a job found by two sources', async () => {
  const t = await startApp();
  try {
    await t.call('PUT', '/api/profile', SAMPLE_PROFILE);
    await t.call('PUT', '/api/settings/search', { titles: ['Graphic Designer'], includeRemote: false, markets: ['SA'], minMatchScore: 60 });
    const j = (source) => ({ id: source, enabled: () => true, search: async () => [buildJob({ source, externalId: 'x1', title: 'Graphic Designer', company: 'Acme', locationText: 'Riyadh, Saudi Arabia', description: 'Photoshop Figma branding', postedAt: new Date().toISOString() })] });
    const r = await scheduler.runSearchJob(t.db, { providerList: [j('jooble'), j('jsearch')] });
    assert.equal(r.fetched, 2); assert.equal(r.added, 2); assert.equal(r.matches, 1);
    assert.equal(JSON.parse((await t.db.prepare('SELECT payload FROM notifications').get()).payload).job_ids.length, 1);
  } finally { await t.close(); }
});

test('demo mode: clearly labelled sample data, fully separated from production data', async () => {
  const t = await startApp();
  try {
    await t.call('POST', '/api/jobs/import', { title: 'Real Designer', company: 'Real Co', location: 'Riyadh, Saudi Arabia', text: 'A genuine job description pasted by the user, long enough to import.' });
    assert.equal((await t.call('GET', '/api/jobs')).body.total, 1);
    assert.equal((await t.call('GET', '/api/app-mode')).body.mode, 'production');

    const on = (await t.call('PUT', '/api/app-mode', { mode: 'demo' })).body;
    assert.ok(on.loaded >= 5);
    const demo = (await t.call('GET', '/api/jobs')).body.jobs;
    assert.ok(demo.length >= 5 && demo.every((j) => j.source === 'demo' && j.title.startsWith('[DEMO]') && /\(demo\)$/.test(j.company) && j.description.startsWith('DEMO LISTING') && j.url === null));
    assert.ok(!demo.some((j) => j.title === 'Real Designer'), 'real data is not shown in demo mode');
    assert.equal((await t.call('GET', '/api/status')).body.mode, 'demo');
    assert.equal((await t.call('POST', '/api/jobs/search', {})).status, 409, 'demo mode never searches real sources');
    assert.equal((await scheduler.runSearchJob(t.db, {})).skipped, true);

    await t.call('PUT', `/api/applications/${demo[0].id}`, { status: 'shortlisted', follow_up_date: '2020-01-01' });
    assert.equal(await scheduler.runReminders(t.db, new Date('2026-11-01T10:00:00')), 0, 'demo jobs never create notifications');
    assert.equal((await t.call('GET', '/api/dashboard')).body.overview.shortlisted, 1);
    assert.equal((await t.call('GET', `/api/applications/${demo[0].id}/modes`)).body.assisted.available, false, 'no apply workflow for demo jobs');

    const off = (await t.call('PUT', '/api/app-mode', { mode: 'production' })).body;
    assert.ok(off.removed >= 5);
    assert.equal((await t.db.prepare("SELECT COUNT(*) n FROM jobs WHERE source = 'demo'").get()).n, 0);
    assert.equal((await t.db.prepare('SELECT COUNT(*) n FROM applications').get()).n, 0, 'applications on demo jobs are removed too');
    assert.equal((await t.call('GET', '/api/jobs')).body.jobs[0].title, 'Real Designer');
    assert.equal((await t.call('GET', '/api/dashboard')).body.overview.shortlisted, 0);
    assert.equal((await t.call('PUT', '/api/app-mode', { mode: 'chaos' })).status, 400);
  } finally { await t.close(); }
});

test('onboarding reflects real state, not self-reported ticks', async () => {
  const t = await startApp({ consent: false });
  try {
    let o = (await t.call('GET', '/api/onboarding')).body;
    assert.equal(o.show, true); assert.equal(o.steps.find((s) => s.key === 'profile').done, false);
    assert.ok(providers.all.some((p) => p.enabled()), 'a keyless source is enabled by default');
    assert.equal(o.steps.find((s) => s.key === 'source').done, false, 'an enabled source is not the same as having real jobs');
    await t.call('PUT', '/api/profile', SAMPLE_PROFILE);
    const fd = new FormData(); fd.append('kind', 'cv'); fd.append('file', new Blob(['Test Candidate CV'], { type: 'text/plain' }), 'cv.txt'); await fetch(t.base + '/api/documents', { method: 'POST', body: fd });
    await t.call('PUT', '/api/settings/search', { titles: ['X'] });
    await t.call('POST', '/api/jobs/import', { title: 'Designer', text: 'A long enough job description for a designer role in Riyadh.' });
    o = (await t.call('GET', '/api/onboarding')).body;
    assert.deepEqual(o.steps.filter((s) => s.required).map((s) => s.done), [true, true, true, true]);
    assert.equal(o.complete, true); assert.equal(o.show, false);
    assert.equal(o.steps.find((s) => s.key === 'ai').done, false, 'optional steps do not block completion');
    assert.deepEqual(o.steps.map((s) => s.key).slice(0, 2), ['cv', 'profile'], 'the CV comes first because it fills the profile');
    // saving email settings is not the same as email working
    require('../src/config').appSecret = 'test-secret-at-least-16-chars';
    await t.call('PUT', '/api/settings/email', { provider: 'resend', from: 'a@b.co', resendApiKey: 're_abcdefgh123' });
    assert.equal((await t.call('GET', '/api/onboarding')).body.steps.find((s) => s.key === 'alerts').done, false, 'configured but never delivered');
    require('../src/services/health').record(t.db, 'email', true);
    assert.equal((await t.call('GET', '/api/onboarding')).body.steps.find((s) => s.key === 'alerts').done, true, 'done after a real delivery');
    require('../src/config').appSecret = '';
    await t.call('POST', '/api/privacy/consent', { ai: true });
    (await t.db.prepare('DELETE FROM profile').run());
    assert.equal((await t.call('GET', '/api/onboarding')).body.complete, false, 'regresses if the profile is removed');
    await t.call('POST', '/api/onboarding/dismiss'); assert.equal((await t.call('GET', '/api/onboarding')).body.show, false);
  } finally { await t.close(); }
});

test('integration status: not configured / ok / failing come from real outcomes; tests send no personal data', async () => {
  const t = await startApp();
  const fake = { id: 'fakesrc', label: 'Fake source', enabled: () => true, search: async () => { throw new Error('HTTP 429 from fake'); } };
  providers.all.push(fake);
  try {
    let list = (await t.call('GET', '/api/integrations')).body; const by = (id) => list.find((i) => i.id === id);
    assert.equal(by('jooble').state, 'not_configured'); assert.match(by('jooble').detail, /JOOBLE_API_KEY/);
    assert.equal(by('ai').state, 'not_configured');
    assert.equal(by('auto_submit').state, 'unavailable'); assert.match(by('auto_submit').detail, /No supported sites/);
    assert.equal(by('database').state, 'ok');
    assert.equal(by('fakesrc').state, 'configured', 'enabled but never used');

    const bad = await t.call('POST', '/api/integrations/fakesrc/test');
    assert.ok(bad.status >= 400);
    list = (await t.call('GET', '/api/integrations')).body; assert.equal(by('fakesrc').state, 'failing'); assert.match(by('fakesrc').detail, /429/);

    fake.search = async () => [1, 2, 3];
    const ok = await t.call('POST', '/api/integrations/fakesrc/test'); assert.equal(ok.status, 200); assert.match(ok.body.detail, /3 result/);
    list = (await t.call('GET', '/api/integrations')).body; assert.equal(by('fakesrc').state, 'ok');

    assert.equal((await t.call('POST', '/api/integrations/jooble/test')).status, 422);
    assert.equal((await t.call('POST', '/api/integrations/database/test')).status, 400);

    const ai = require('../src/services/ai'); let sent = null;
    ai.setClient({ messages: { create: async (a) => { sent = a; return { content: [{ type: 'text', text: 'OK' }] }; } } });
    assert.equal((await t.call('POST', '/api/integrations/ai/test')).status, 200);
    assert.ok(!JSON.stringify(sent).includes('Test Candidate'), 'the AI ping contains no profile data'); assert.equal(sent.messages[0].content, 'ping');
    ai.setClient({ messages: { create: async () => { throw new Error('401 invalid x-api-key'); } } });
    await t.call('POST', '/api/integrations/ai/test');
    assert.equal((await t.call('GET', '/api/integrations')).body.find((i) => i.id === 'ai').state, 'failing');
    ai.setClient(null);
  } finally { providers.all.pop(); await t.close(); }
});

test('a failing source recorded by a real search run shows as failing', async () => {
  const t = await startApp();
  try {
    const { runSearch } = require('../src/services/search');
    const bad = { id: 'flaky', enabled: () => true, search: async () => { throw new Error('timeout'); } };
    await runSearch(t.db, { categories: ['Brand Designer'], cities: ['Riyadh'], includeRemote: false }, [bad]);
    const h = JSON.parse((await t.db.prepare("SELECT value FROM settings WHERE key = 'integration_health'").get()).value);
    assert.match(h.flaky.last_error, /timeout/);
    assert.equal(health.outcome(h.flaky).state, 'failing');
  } finally { await t.close(); }
});

test('readiness, /healthz and safe network binding', async () => {
  const t = await startApp();
  const old = config.appPassword;
  try {
    const r = (await t.call('GET', '/api/readiness')).body;
    assert.equal(r.items.find((i) => i.id === 'auth').level, 'warn'); assert.equal(r.items.find((i) => i.id === 'storage').level, 'ok');
    const exposed = await health.readiness(t.db, { uploadDir: t.uploadDir, host: '0.0.0.0' });
    assert.equal(exposed.items.find((i) => i.id === 'auth').level, 'fail'); assert.equal(exposed.ready, false);
    config.appPassword = 'pw'; assert.equal((await health.readiness(t.db, { uploadDir: t.uploadDir, host: '0.0.0.0' })).items.find((i) => i.id === 'auth').level, 'ok');
    assert.equal((await health.readiness(t.db, { uploadDir: '/nonexistent/dir' })).ready, false);
    const hz = await fetch(t.base + '/healthz'); assert.equal(hz.status, 200); assert.deepEqual(await hz.json(), { ok: true });
    assert.equal((await fetch(t.base + '/api/profile')).status, 401, 'only /healthz is open');
  } finally { config.appPassword = old; await t.close(); }
  assert.doesNotThrow(() => assertSafeBind('127.0.0.1', ''));
  assert.doesNotThrow(() => assertSafeBind('0.0.0.0', 'pw'));
  assert.doesNotThrow(() => assertSafeBind('0.0.0.0', '', true));
  assert.throws(() => assertSafeBind('0.0.0.0', ''), /without APP_PASSWORD/);
  assert.throws(() => assertSafeBind('192.168.1.5', ''), /Refusing/);
});
