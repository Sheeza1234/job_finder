const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const config = require('../src/config');
const scheduler = require('../src/services/scheduler');
const settings = require('../src/services/settings');
const email = require('../src/services/email');
const { buildJob } = require('../src/normalize');
const { startApp, SAMPLE_PROFILE } = require('./helpers');

const job = (o) => buildJob({ source: 'fake', externalId: o.id, title: o.title, company: o.company || 'Acme', locationText: 'Riyadh, Saudi Arabia',
  description: o.description || 'Photoshop, Figma and Illustrator for branding projects', postedAt: new Date().toISOString(), ...o });
const fakeProvider = (jobs) => ({ id: 'fake', enabled: () => true, search: async () => jobs });
const NOW = new Date('2026-11-02T08:30:00');

async function setup(searchOverrides = {}) {
  const t = await startApp();
  await t.call('PUT', '/api/profile', SAMPLE_PROFILE);
  await t.call('PUT', '/api/settings/search', { titles: ['Graphic Designer'], cities: ['Riyadh'], markets: ['SA'], includeRemote: false, minMatchScore: 75, ...searchOverrides });
  return t;
}
const notifs = async (t) => (await t.db.prepare('SELECT * FROM notifications ORDER BY id').all());

test('schedule due-ness: hourly, 6-hourly, daily with catch-up, off', async () => {
  const S = (o) => ({ frequency: 'hourly', dailyTime: '08:00', ...o });
  const iso = (s) => new Date(s).toISOString();
  assert.equal(scheduler.isDue(S({ frequency: 'off' }), null, NOW), false);
  assert.equal(scheduler.isDue(S({}), null, NOW), true);
  assert.equal(scheduler.isDue(S({}), iso('2026-11-02T07:45:00'), NOW), false);
  assert.equal(scheduler.isDue(S({}), iso('2026-11-02T07:20:00'), NOW), true);
  assert.equal(scheduler.isDue(S({ frequency: 'every_6_hours' }), iso('2026-11-02T04:00:00'), NOW), false);
  const daily = S({ frequency: 'daily', dailyTime: '08:00' });
  assert.equal(scheduler.isDue(daily, iso('2026-11-01T08:05:00'), NOW), true, 'new slot passed since last run');
  assert.equal(scheduler.isDue(daily, iso('2026-11-02T08:01:00'), NOW), false, 'already ran for today\'s slot');
  assert.equal(scheduler.isDue(daily, iso('2026-10-30T08:00:00'), new Date('2026-11-02T23:00:00')), true, 'server was down: catches up late');
  assert.equal(scheduler.isDue(daily, null, new Date('2026-11-02T07:00:00')), true);
  assert.match(scheduler.nextRun(daily, iso('2026-11-02T08:01:00'), NOW), /^2026-11-0[23]/);
  assert.equal(scheduler.nextRun(S({ frequency: 'off' }), null, NOW), null);
});

test('scheduled search notifies only for qualifying new matches and never touches applications', async () => {
  const t = await setup({ excludedCompanies: ['BadCorp'], excludedKeywords: ['unpaid'], employmentTypes: ['full_time'] });
  try {
    const jobs = [
      job({ id: '1', title: 'Graphic Designer' }),
      job({ id: '2', title: 'Graphic Designer', company: 'BadCorp' }),
      job({ id: '3', title: 'Graphic Designer', description: 'Unpaid trial. Photoshop Figma' }),
      job({ id: '4', title: 'Graphic Designer', description: 'Part-time role. Photoshop Figma Illustrator', employmentHint: 'part_time' }),
      job({ id: '5', title: 'Backend Engineer', description: 'Kubernetes golang postgres' }),
    ];
    const r = await scheduler.runSearchJob(t.db, { now: NOW, providerList: [fakeProvider(jobs)] });
    assert.equal(r.filtered_out, 1, 'the unrelated Backend Engineer job is dropped at fetch time');
    assert.equal(r.added, 4); assert.equal(r.matches, 1);
    const n = await notifs(t);
    assert.equal(n.length, 1); assert.equal(n[0].kind, 'new_matches');
    assert.deepEqual(JSON.parse(n[0].payload).job_ids.length, 1);
    assert.match(n[0].body, /Nothing has been applied to/);
    assert.equal((await t.db.prepare('SELECT COUNT(*) n FROM applications').get()).n, 0, 'discovery never creates or changes applications');

    const again = await scheduler.runSearchJob(t.db, { now: new Date(+NOW + 3600e3), providerList: [fakeProvider(jobs)] });
    assert.equal(again.added, 0); assert.equal((await notifs(t)).length, 1, 'no duplicate notification for already-known jobs');
    assert.equal((await scheduler.status(t.db)).last_result.added, 0);
    assert.ok((await t.db.prepare("SELECT 1 FROM audit_logs WHERE action = 'search_run' AND actor = 'scheduler'").get()));
  } finally { await t.close(); }
});

test('the scheduler module has no path to the application workflows', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/scheduler.js'), 'utf8');
  assert.ok(!/autoSubmit|browserAssist|applications\.update|markSubmitted/.test(src.replace(/\/\/.*$/gm, '')), 'discovery and applying stay separate');
});

test('AI screening needs consent and a configured key; failures fall back to the keyword score', async () => {
  const ai = require('../src/services/ai');
  const t = await setup({ aiScreening: true, minMatchScore: 60 });
  try {
    let calls = 0;
    ai.setClient({ messages: { create: async () => { calls++; return { content: [{ type: 'text', text: JSON.stringify({ score: 40, verdict: 'stretch', summary: 'x', gaps: [], strengths: [] }) }] }; } } });
    await t.call('POST', '/api/privacy/consent', { ai: false });
    await scheduler.runSearchJob(t.db, { now: NOW, providerList: [fakeProvider([job({ id: 'a', title: 'Graphic Designer' })])] });
    assert.equal(calls, 0, 'no consent: nothing sent to the AI');
    await t.call('POST', '/api/privacy/consent', { ai: true });
    const r = await scheduler.runSearchJob(t.db, { now: new Date(+NOW + 7200e3), providerList: [fakeProvider([job({ id: 'b', title: 'Graphic Designer' })])] });
    assert.equal(calls, 1); assert.equal(r.matches, 0, 'AI score 40 is below the 60 threshold');
  } finally { ai.setClient(null); await t.close(); }
});

test('reminders: follow-ups, interviews, closing listings notify once each', async () => {
  const t = await startApp();
  try {
    const { upsertJobs } = require('../src/services/jobsStore');
    await upsertJobs(t.db, [job({ id: 'r1', title: 'Web Designer' }), job({ id: 'r2', title: 'Brand Designer', expiresAt: '2026-11-04T00:00:00.000Z' }), job({ id: 'r3', title: 'UI Designer' })]);
    const [a, b, c] = (await t.db.prepare('SELECT id FROM jobs ORDER BY id').all()).map((r) => r.id);
    await t.call('PUT', `/api/applications/${a}`, { status: 'shortlisted', follow_up_date: '2026-11-02', interview_dates: ['2026-11-02T18:00'] });
    await t.call('PUT', `/api/applications/${b}`, { status: 'saved' });
    (await t.db.prepare("UPDATE applications SET status = 'applied', applied_at = ? WHERE job_id = ?").run(new Date('2026-10-20T10:00:00').toISOString(), c));
    (await t.db.prepare("INSERT OR IGNORE INTO applications (job_id, status, applied_at, updated_at) VALUES (?, 'applied', ?, ?)").run(c, new Date('2026-10-20T10:00:00').toISOString(), new Date().toISOString()));

    assert.equal(await scheduler.runReminders(t.db, NOW), 4);
    const kinds = (await notifs(t)).map((n) => n.kind).sort();
    assert.deepEqual(kinds, ['expiring', 'follow_up', 'follow_up', 'interview']);
    assert.equal(await scheduler.runReminders(t.db, NOW), 0, 'deduplicated');
    assert.match((await notifs(t)).find((n) => n.kind === 'expiring').title, /Closing soon/);

    await t.call('PUT', '/api/settings/notifications', { followUps: false, interviews: false, expiring: false });
    (await t.db.prepare('DELETE FROM notifications').run());
    assert.equal(await scheduler.runReminders(t.db, NOW), 0, 'respects notification preferences');
  } finally { await t.close(); }
});

test('tick runs due searches in the background without a browser', async () => {
  const t = await setup({ frequency: 'hourly' });
  try {
    const out = await scheduler.tick(t.db, NOW, { providerList: [fakeProvider([job({ id: 't1', title: 'Graphic Designer' })])] });
    assert.equal(out.search.added, 1);
    const out2 = await scheduler.tick(t.db, new Date(+NOW + 600e3), { providerList: [fakeProvider([])] });
    assert.equal(out2.search, null, 'not due again after 10 minutes');
    assert.ok((await scheduler.status(t.db, NOW)).next_run_at);
  } finally { await t.close(); }
});

test('notification API: unread count, mark read, delete', async () => {
  const t = await setup();
  try {
    await scheduler.runSearchJob(t.db, { now: NOW, providerList: [fakeProvider([job({ id: 'n1', title: 'Graphic Designer' })])] });
    let r = (await t.call('GET', '/api/notifications')).body; assert.equal(r.unread, 1);
    await t.call('POST', `/api/notifications/${r.items[0].id}/read`);
    r = (await t.call('GET', '/api/notifications')).body; assert.equal(r.unread, 0);
    assert.equal((await t.call('GET', '/api/notifications?unread=true')).body.items.length, 0);
    await t.call('DELETE', `/api/notifications/${r.items[0].id}`);
    assert.equal((await t.call('GET', '/api/notifications')).body.items.length, 0);
  } finally { await t.close(); }
});

test('email via Resend: credentials encrypted at rest and write-only; emails carry titles, not CV content', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { seen.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.statusCode = 200; res.end('{}'); }); }).listen(0);
  process.env.RESEND_API_URL = `http://127.0.0.1:${srv.address().port}`;
  const old = config.appSecret; config.appSecret = 'test-secret-at-least-16-chars';
  const t = await setup();
  try {
    assert.equal((await t.call('PUT', '/api/settings/email', { provider: 'resend', from: 'jobs@example.com', resendApiKey: 're_secret_key_123' })).status, 200);
    const pub = (await t.call('GET', '/api/settings/email')).body;
    assert.equal(pub.hasResendKey, true); assert.ok(!JSON.stringify(pub).includes('re_secret_key_123'));
    assert.ok(!(await t.db.prepare("SELECT value FROM settings WHERE key = 'email_config'").get()).value.includes('re_secret_key_123'), 'stored encrypted');
    await t.call('PUT', '/api/settings/notifications', { email: true });

    await scheduler.runSearchJob(t.db, { now: NOW, providerList: [fakeProvider([job({ id: 'e1', title: 'Graphic Designer' })])] });
    assert.equal(seen.length, 1); assert.equal(seen[0].auth, 'Bearer re_secret_key_123');
    assert.match(seen[0].body.subject, /match at least 75%/); assert.deepEqual(seen[0].body.to, ['t@example.com']);
    assert.ok(!JSON.stringify(seen[0].body).includes('Acme Studio'), 'no profile/CV content in email');
    assert.ok((await notifs(t))[0].emailed_at);

    assert.equal((await t.call('POST', '/api/settings/email/test')).status, 200);
    const keep = await t.call('PUT', '/api/settings/email', { provider: 'resend', from: 'new@example.com' });
    assert.equal(keep.body.hasResendKey, true, 'omitting the key keeps the stored one');
  } finally { config.appSecret = old; delete process.env.RESEND_API_URL; await t.close(); srv.close(); }
});

test('email: refuses to store credentials without APP_SECRET; delivery failures never break notifications; SMTP works', async () => {
  const old = config.appSecret; config.appSecret = '';
  const t = await setup();
  try {
    const r = await t.call('PUT', '/api/settings/email', { provider: 'resend', from: 'a@b.co', resendApiKey: 'abcdefgh1234' });
    assert.equal(r.status, 400); assert.match(r.body.error, /APP_SECRET/);
    config.appSecret = 'test-secret-at-least-16-chars';
    assert.equal((await t.call('PUT', '/api/settings/email', { provider: 'smtp', from: 'a@b.co', smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'u', password: 'p4ss' } })).status, 200);
    assert.ok(!(await t.db.prepare("SELECT value FROM settings WHERE key = 'email_config'").get()).value.includes('p4ss'));
    const sent = []; email.setTransportFactory(() => ({ sendMail: async (m) => { sent.push(m); if (sent.length === 1) throw new Error('smtp down'); } }));
    await t.call('PUT', '/api/settings/notifications', { email: true });
    await t.call('PUT', '/api/profile', { ...SAMPLE_PROFILE });
    await scheduler.runSearchJob(t.db, { now: NOW, providerList: [fakeProvider([job({ id: 's1', title: 'Graphic Designer' })])] });
    const n = (await notifs(t))[0];
    assert.equal(n.emailed_at, null); assert.match(n.email_error, /smtp down/);
    assert.equal((await t.call('GET', '/api/notifications')).body.unread, 1, 'in-app notification still delivered');
    assert.equal((await t.call('POST', '/api/settings/email/test')).status, 200); assert.equal(sent.length, 2);
    assert.equal((await t.call('PUT', '/api/settings/email', { provider: 'resend' })).status, 400);
  } finally { email.setTransportFactory(null); config.appSecret = old; await t.close(); }
});
