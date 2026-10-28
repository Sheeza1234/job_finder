const test = require('node:test');
const assert = require('node:assert/strict');
const auto = require('../src/services/autoSubmit');
const { startWithJob } = require('./helpers');

// A stand-in for a site that explicitly permits automated applications. Real sites ship NO adapters.
function mockAdapter(over = {}) {
  const state = { listing: { open: true, title: 'Senior Graphic Designer', company: 'Riyadh Creative Co' }, result: { confirmed: true, confirmationNumber: 'CONF-123' }, submitted: 0 };
  const adapter = {
    id: 'mock', label: 'Mock ATS', permitted: true, permissionSource: 'https://example.test/api-terms', acceptedFormats: ['pdf', 'docx'], maxFileMb: 5,
    matches: (u) => u.startsWith('https://jobs.example.test/'),
    verifyListing: async () => state.listing,
    fields: ({ profile, answer }) => [
      { key: 'email', label: 'Email', required: true, value: profile.email },
      { key: 'salary', label: 'Salary expectation', required: true, sensitive: true, value: answer('salaryExpectation') },
    ],
    submit: async () => { state.submitted++; if (state.throw) throw new Error('socket hang up'); return state.result; },
    ...over,
  };
  return { adapter, state };
}

async function setup({ approve = true, importUrl = 'https://jobs.example.test/42' } = {}) {
  const t = await startWithJob({ approve });
  (await t.db.prepare('UPDATE jobs SET url = ? WHERE id = ?').run(importUrl, t.jobId));
  const m = mockAdapter(); auto.registerAdapter(m.adapter);
  const prep = (b = {}) => t.call('POST', `/api/applications/${t.jobId}/auto-submit/prepare`, b);
  const confirm = (b) => t.call('POST', `/api/applications/${t.jobId}/auto-submit/confirm`, b);
  const saveSalary = (v) => t.call('PUT', '/api/profile', { ...t.profileBase, answers: { salaryExpectation: v } });
  t.profileBase = (await t.call('GET', '/api/profile')).body;
  return { ...t, ...m, prep, confirm, saveSalary, close: async () => { auto.clearAdapters(); await t.close(); } };
}

test('adapters must declare explicit permission', async () => {
  assert.throws(() => auto.registerAdapter({ ...mockAdapter().adapter, permissionSource: undefined }), /permitted/);
  assert.throws(() => auto.registerAdapter({ ...mockAdapter().adapter, permitted: false }), /permitted/);
});

test('no adapter (every real site by default): control returns to the user with a manual checklist', async () => {
  const t = await startWithJob({ approve: true });
  try {
    (await t.db.prepare('UPDATE jobs SET url = ? WHERE id = ?').run('https://careers.somecompany.com/job/1', t.jobId));
    const r = (await t.call('POST', `/api/applications/${t.jobId}/auto-submit/prepare`, {})).body;
    assert.equal(r.permitted, false); assert.equal(r.handBack, true); assert.ok(r.checklist.length);
    const c = await t.call('POST', `/api/applications/${t.jobId}/auto-submit/confirm`, { approvalToken: 'x' });
    assert.equal(c.body.permitted, false); assert.equal(c.body.submitted, undefined);
    assert.equal((await t.call('GET', `/api/applications/${t.jobId}`)).body.status, 'cv_ready');
  } finally { await t.close(); }
});

test('sensitive fields are never guessed: missing salary answer blocks submission', async () => {
  const t = await setup();
  try {
    const r = (await t.prep()).body;
    assert.equal(r.ready, false);
    const f = r.checks.find((c) => c.id === 'required_fields');
    assert.equal(f.ok, false); assert.match(f.detail, /Salary expectation/);
    assert.equal(r.approvalToken, null);
    assert.equal(t.state.submitted, 0);
  } finally { await t.close(); }
});

test('full happy path: checks pass, explicit approval needed, success only on site confirmation', async () => {
  const t = await setup();
  try {
    await t.saveSalary('SAR 12,000');
    const r = (await t.prep()).body;
    assert.equal(r.ready, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
    assert.ok(['listing_open', 'details_match', 'cv_approved', 'letter_ok', 'attachments', 'required_fields', 'duplicate'].every((id) => r.checks.some((c) => c.id === id && c.ok)));
    assert.equal(r.summary.cv_version, 'v1'); assert.ok(r.summary.attachments[0].filename.endsWith('.pdf'));
    assert.ok(r.approvalToken);

    const noToken = await t.confirm({});
    assert.equal(noToken.status, 403); assert.equal(t.state.submitted, 0);
    const done = (await t.confirm({ approvalToken: r.approvalToken })).body;
    assert.equal(done.confirmed, true); assert.equal(done.confirmation, 'CONF-123'); assert.equal(t.state.submitted, 1);
    const a = (await t.call('GET', `/api/applications/${t.jobId}`)).body;
    assert.equal(a.status, 'applied'); assert.equal(a.submission_source, 'site_confirmed'); assert.equal(a.confirmation, 'CONF-123'); assert.ok(a.applied_at);
    assert.ok(a.submission_log.some((e) => e.event === 'submission_confirmed'));
    const replay = (await t.confirm({ approvalToken: r.approvalToken })).body;
    assert.equal(replay.submitted, false); assert.equal(t.state.submitted, 1, 'replay never re-sends');
  } finally { await t.close(); }
});

test('approval is bound to exact content: changes after approval force re-approval', async () => {
  const t = await setup();
  try {
    await t.saveSalary('SAR 12,000');
    const r = (await t.prep()).body;
    await t.saveSalary('SAR 15,000');
    const c = await t.confirm({ approvalToken: r.approvalToken });
    assert.equal(c.status, 409); assert.equal(t.state.submitted, 0);
  } finally { await t.close(); }
});

test('closed listing, mismatched employer, unapproved CV: each blocks and nothing is sent', async () => {
  let t = await setup(); await t.saveSalary('SAR 1');
  try {
    t.state.listing = { open: false };
    let r = (await t.prep()).body; assert.equal(r.ready, false); assert.equal(r.checks.find((c) => c.id === 'listing_open').ok, false);
    t.state.listing = { open: true, title: 'Barista', company: 'Other Cafe' };
    r = (await t.prep()).body; assert.equal(r.checks.find((c) => c.id === 'details_match').ok, false);
    assert.equal((await t.confirm({ approvalToken: 'whatever' })).body.submitted, false);
    assert.equal(t.state.submitted, 0);
  } finally { await t.close(); }
  t = await setup({ approve: false }); await t.saveSalary('SAR 1');
  try {
    const r = (await t.prep()).body;
    assert.equal(r.checks.find((c) => c.id === 'cv_approved').ok, false); assert.equal(r.ready, false);
  } finally { await t.close(); }
});

test('CAPTCHA / MFA / login walls hand control back and are never bypassed', async () => {
  const t = await setup(); await t.saveSalary('SAR 1');
  try {
    t.state.listing = { blocked: 'captcha' };
    const r = (await t.prep()).body;
    assert.equal(r.handBack, true); assert.match(r.message, /captcha/); assert.ok(r.checklist.length);
    assert.equal(t.state.submitted, 0);
  } finally { await t.close(); }
});

test('unconfirmed or failed submissions are NEVER recorded as applied, and retries are deliberate', async () => {
  const t = await setup(); await t.saveSalary('SAR 1');
  try {
    t.state.result = { confirmed: false, message: 'queued' };
    let r = (await t.prep()).body;
    let done = (await t.confirm({ approvalToken: r.approvalToken })).body;
    assert.equal(done.status, 'unconfirmed'); assert.match(done.message, /NOT recorded as applied/);
    let a = (await t.call('GET', `/api/applications/${t.jobId}`)).body;
    assert.notEqual(a.status, 'applied'); assert.equal(a.applied_at, null); assert.equal(a.confirmation, null);

    r = (await t.prep()).body;
    assert.equal(r.checks.find((c) => c.id === 'previous_attempt').ok, false, 'blocked until the user retries deliberately');
    assert.equal(r.ready, false);

    t.state.throw = true;
    r = (await t.prep({ retry: true })).body; assert.equal(r.ready, true);
    done = (await t.confirm({ approvalToken: r.approvalToken, retry: true })).body;
    assert.equal(done.status, 'unknown'); assert.equal(done.submitted, false);
    a = (await t.call('GET', `/api/applications/${t.jobId}`)).body;
    assert.notEqual(a.status, 'applied');
  } finally { await t.close(); }
});

test('a "confirmed" flag without any confirmation text/number is not enough', async () => {
  const t = await setup(); await t.saveSalary('SAR 1');
  try {
    t.state.result = { confirmed: true };
    const r = (await t.prep()).body;
    assert.equal((await t.confirm({ approvalToken: r.approvalToken })).body.confirmed, false);
    assert.notEqual((await t.call('GET', `/api/applications/${t.jobId}`)).body.status, 'applied');
  } finally { await t.close(); }
});

test('pre-approved adapter can submit without a token, but all checks still run', async () => {
  const t = await setup();
  try {
    await t.call('PUT', '/api/auto-submit/preapproved', { adapters: ['mock', 'ghost'] });
    assert.deepEqual((await t.call('GET', '/api/auto-submit/adapters')).body.preapproved, ['mock']);
    let c = (await t.confirm({})).body; // salary still missing
    assert.equal(c.submitted, false); assert.equal(t.state.submitted, 0);
    await t.saveSalary('SAR 1');
    c = (await t.confirm({})).body; assert.equal(c.confirmed, true);
    assert.equal(t.state.submitted, 1);
  } finally { await t.close(); }
});

test('a job already applied to cannot be auto-submitted again', async () => {
  const t = await setup(); await t.saveSalary('SAR 1');
  try {
    await t.call('POST', `/api/applications/${t.jobId}/mark-submitted`, {});
    const r = (await t.prep()).body;
    assert.equal(r.checks.find((c) => c.id === 'duplicate').ok, false); assert.equal(r.ready, false);
  } finally { await t.close(); }
});
