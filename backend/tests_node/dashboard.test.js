const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const config = require('../src/config');
const { upsertJobs } = require('../src/services/jobsStore');
const { signLink, verifyLink } = require('../src/services/crypto');
const { buildJob } = require('../src/normalize');
const { startApp, startWithJob, SAMPLE_PROFILE } = require('./helpers');

const mk = (o) => buildJob({ source: 'd', locationText: 'Riyadh, Saudi Arabia', postedAt: new Date().toISOString(), description: 'Photoshop and Figma for branding', ...o, externalId: o.id });

test('dashboard: overview counts, recommended cards, exclusions, sponsorship only when stated', async () => {
  const t = await startApp();
  try {
    await t.call('PUT', '/api/profile', { ...SAMPLE_PROFILE });
    await t.call('PUT', '/api/settings/search', { excludedCompanies: ['BadCorp'], minMatchScore: 70 });
    await upsertJobs(t.db, [
      mk({ id: '1', title: 'Graphic Designer', company: 'Good Co', description: 'Photoshop, Figma and motion graphics. Visa sponsorship is available.', salaryMin: 9000, salaryMax: 14000, salaryCurrency: 'SAR' }),
      mk({ id: '2', title: 'Graphic Designer', company: 'BadCorp' }),
      mk({ id: '3', title: 'Graphic Designer', company: 'Quiet Co' }),
      mk({ id: '4', title: 'Backend Engineer', company: 'Tech Co', description: 'golang kubernetes' }),
    ]);
    const ids = Object.fromEntries((await t.db.prepare('SELECT external_id e, id FROM jobs').all()).map((r) => [r.e, r.id]));
    await t.call('PUT', `/api/applications/${ids['3']}`, { status: 'shortlisted' });
    const d = (await t.call('GET', '/api/dashboard')).body;
    assert.equal(d.overview.total_jobs, 4);
    assert.equal(d.overview.shortlisted, 1); assert.equal(d.overview.submitted, 0); assert.equal(d.overview.interviews, 0);
    assert.ok(d.overview.high_match >= 2); assert.equal(d.overview.new_24h, 4);
    const titles = d.recommended.map((c) => c.company);
    assert.ok(!titles.includes('BadCorp'), 'excluded employer never recommended');
    assert.equal(d.recommended[0].match_score >= d.recommended[1].match_score, true);
    assert.ok(!titles.includes('Tech Co'), 'weak matches are not recommended');
    const good = d.recommended.find((c) => c.company === 'Good Co');
    assert.equal(good.salary, '9,000–14,000 SAR'); assert.equal(good.sponsorship, 'yes'); assert.equal(good.is_new, true);
    assert.ok(good.top_skills.includes('photoshop')); assert.ok(good.missing.includes('motion graphics'));
    assert.equal(d.recommended.find((c) => c.company === 'Quiet Co').sponsorship, null, 'not specified => not shown');
    assert.equal(d.recommended.find((c) => c.company === 'Quiet Co').salary, null);

    await t.call('POST', `/api/applications/${ids['1']}/mark-submitted`, {});
    const d2 = (await t.call('GET', '/api/dashboard')).body;
    assert.equal(d2.overview.submitted, 1);
    assert.ok(!d2.recommended.some((c) => c.id === ids['1']), 'applied jobs are no longer recommended');
  } finally { await t.close(); }
});

test('dashboard: pending follow-ups and upcoming interviews', async () => {
  const t = await startApp();
  try {
    await upsertJobs(t.db, [mk({ id: '1', title: 'Web Designer', company: 'A' }), mk({ id: '2', title: 'UI Designer', company: 'B' })]);
    const [a, b] = (await t.db.prepare('SELECT id FROM jobs ORDER BY id').all()).map((r) => r.id);
    const soon = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
    await t.call('PUT', `/api/applications/${a}`, { status: 'interview', interview_dates: [soon], follow_up_date: '2020-01-01' });
    await t.call('PUT', `/api/applications/${b}`, { status: 'offer', follow_up_date: '2020-01-01' });
    const d = (await t.call('GET', '/api/dashboard')).body;
    assert.equal(d.overview.pending_followups, 1, 'closed-out applications are not chased');
    assert.equal(d.overview.interviews, 1); assert.equal(d.upcoming_interviews[0].job_id, a);
    assert.equal(d.due_followups[0].job_id, a);
  } finally { await t.close(); }
});

test('search settings validate and persist; excluded keywords hide nothing from the raw job list', async () => {
  const t = await startApp();
  try {
    assert.equal((await t.call('PUT', '/api/settings/search', { minMatchScore: 150 })).status, 400);
    assert.equal((await t.call('PUT', '/api/settings/search', { dailyTime: '25:61' })).status, 400);
    assert.equal((await t.call('PUT', '/api/settings/search', { frequency: 'every_second' })).status, 400);
    const ok = (await t.call('PUT', '/api/settings/search', { titles: ['UI/UX Designer'], cities: ['Jeddah'], minSalary: 8000, experienceLevels: ['mid', 'senior'], employmentTypes: ['full_time'], workModes: ['hybrid'], minMatchScore: 80, excludedCompanies: ['X'], excludedKeywords: ['unpaid'], frequency: 'daily', dailyTime: '07:30' })).body;
    assert.equal(ok.minMatchScore, 80);
    assert.deepEqual((await t.call('GET', '/api/settings/search')).body.cities, ['Jeddah']);
    assert.equal((await t.call('GET', '/api/settings/search')).body.dailyTime, '07:30');
    assert.equal((await t.call('GET', '/api/scheduler')).body.frequency, 'daily');
    assert.equal((await t.call('PUT', '/api/settings/notifications', { followUpDays: 0 })).status, 400);
  } finally { await t.close(); }
});

test('CV Studio: master CV, version list across jobs, and history', async () => {
  const t = await startWithJob({ approve: true });
  try {
    const up = async (name) => { const fd = new FormData(); fd.append('kind', 'cv'); fd.append('file', new Blob(['Test Candidate\nDesigner'], { type: 'text/plain' }), name); return (await (await fetch(t.base + '/api/documents', { method: 'POST', body: fd })).json()).id; };
    const first = await up('a.txt'); const second = await up('b.txt');
    let s = (await t.call('GET', '/api/cv-studio')).body;
    assert.equal(s.master.id, first, 'first uploaded CV becomes the master');
    await t.call('POST', `/api/documents/${second}/master`);
    s = (await t.call('GET', '/api/cv-studio')).body; assert.equal(s.master.id, second);
    assert.equal(s.documents.filter((d) => d.is_master).length, 1);
    assert.equal(s.versions[0].job_title, 'Senior Graphic Designer'); assert.equal(s.versions[0].status, 'approved'); assert.equal(s.versions[0].used_count, 1);

    await t.call('PUT', `/api/cv-versions/${t.cv.id}`, { summary: 'Branding designer.' }); // forks (approved)
    const h = (await t.call('GET', `/api/cv-versions/${t.cv.id}/history`)).body;
    assert.deepEqual(h.events.map((e) => e.event), ['Generated by the tailoring engine', 'Approved', 'Edited']);
    assert.ok(h.changes.length);
    const s2 = (await t.call('GET', '/api/cv-studio')).body;
    assert.equal(s2.versions.length, 2);
    assert.match((await t.call('GET', `/api/cv-versions/${s2.versions[0].id}/history`)).body.events[0].event, /edited copy of v1/);
  } finally { await t.close(); }
});

test('signed download links expire, resist tampering and serve with nosniff', async () => {
  const t = await startApp();
  try {
    const fd = new FormData(); fd.append('kind', 'cv'); fd.append('file', new Blob(['hello cv'], { type: 'text/plain' }), 'cv.txt');
    const id = (await (await fetch(t.base + '/api/documents', { method: 'POST', body: fd })).json()).id;
    const { url } = (await t.call('POST', `/api/documents/${id}/link`)).body;
    const ok = await fetch(t.base + url); assert.equal(ok.status, 200); assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await ok.text(), 'hello cv'); assert.match(ok.headers.get('content-disposition'), /attachment/);
    assert.equal((await fetch(t.base + url + 'x')).status, 410);
    assert.equal((await fetch(t.base + '/dl/' + signLink('document', id, -1))).status, 410, 'expired');
    assert.equal(verifyLink(signLink('document', id, 60000)).id, id);
    assert.equal((await t.call('POST', '/api/documents/9999/link')).status, 404);
  } finally { await t.close(); }
});

test('uploads: content must match the extension', async () => {
  const t = await startApp();
  try {
    const up = (bytes, name) => { const fd = new FormData(); fd.append('file', new Blob([bytes]), name); return fetch(t.base + '/api/documents', { method: 'POST', body: fd }); };
    assert.equal((await up('MZ\x90\x00 not a pdf', 'cv.pdf')).status, 400);
    assert.equal((await up('PK\x03\x04 but no word doc', 'cv.docx')).status, 400);
    assert.equal((await up(Buffer.from([0, 1, 2, 0]), 'notes.txt')).status, 400);
    assert.equal((await up('%PDF-1.4\n%%EOF', 'cv.pdf')).status, 201);
    assert.equal((await t.call('GET', '/api/documents')).body.length, 1, 'rejected files are not stored');
    assert.equal(fs.readdirSync(t.uploadDir).length, 1, 'rejected files are deleted from disk');
  } finally { await t.close(); }
});

test('AI consent gate: nothing is sent to the AI provider until the user consents', async () => {
  const ai = require('../src/services/ai');
  const t = await startApp({ consent: false });
  try {
    await t.call('PUT', '/api/profile', SAMPLE_PROFILE);
    const jobId = (await t.call('POST', '/api/jobs/import', { title: 'Designer', text: 'A long enough job description for a designer role in Riyadh.' })).body.id;
    let sent = 0; ai.setClient({ messages: { create: async () => { sent++; return { content: [{ type: 'text', text: '{"score":50}' }] }; } } });
    for (const [p, b] of [[`/api/jobs/${jobId}/analyze`], [`/api/jobs/${jobId}/tailor`], [`/api/jobs/${jobId}/cover-letter`], ['/api/profile/import-cv', { documentId: 1 }]]) {
      const r = await t.call('POST', p, b || {});
      assert.equal(r.status, 403, p); assert.equal(r.body.code, 'consent_required'); assert.match(r.body.disclosure, /Anthropic/);
    }
    assert.equal(sent, 0);
    assert.equal((await t.call('GET', '/api/privacy')).body.consent.ai, false);
    await t.call('POST', '/api/privacy/consent', { ai: true });
    assert.equal((await t.call('POST', `/api/jobs/${jobId}/analyze`)).status, 200); assert.equal(sent, 1);
    await t.call('POST', '/api/privacy/consent', { ai: false });
    assert.equal((await t.call('POST', `/api/jobs/${jobId}/analyze`)).status, 403, 'consent can be withdrawn');
    assert.equal((await t.call('POST', '/api/privacy/consent', { ai: 'yes' })).status, 400);
  } finally { ai.setClient(null); await t.close(); }
});

test('privacy: export excludes credentials; deletion requires confirmation and removes everything', async () => {
  const old = config.appSecret; config.appSecret = 'test-secret-at-least-16-chars';
  const t = await startWithJob({ approve: true });
  try {
    await t.call('PUT', '/api/settings/email', { provider: 'resend', from: 'a@b.co', resendApiKey: 're_topsecret_999' });
    const fd = new FormData(); fd.append('kind', 'cv'); fd.append('file', new Blob(['cv text'], { type: 'text/plain' }), 'cv.txt');
    await fetch(t.base + '/api/documents', { method: 'POST', body: fd });
    const exp = await t.call('GET', '/api/privacy/export');
    const json = JSON.stringify(exp.body);
    assert.ok(json.includes('Test Candidate')); assert.ok(!json.includes('re_topsecret_999') && !json.includes('resendKey'));
    assert.match(exp.headers.get('content-disposition'), /my-data\.json/);

    assert.equal((await t.call('DELETE', '/api/privacy/data', {})).status, 400);
    assert.equal((await t.call('DELETE', '/api/privacy/data', { confirm: 'yes' })).status, 400);
    assert.equal((await t.call('GET', '/api/profile')).body.fullName, 'Test Candidate', 'unconfirmed request deletes nothing');
    const del = (await t.call('DELETE', '/api/privacy/data', { confirm: 'DELETE MY DATA' })).body;
    assert.ok(del.deleted_rows.jobs >= 1 && del.deleted_rows.cv_versions >= 1 && del.deleted_files === 1, JSON.stringify(del));
    for (const tbl of ['jobs', 'profile', 'cv_versions', 'cover_letters', 'applications', 'documents', 'notifications', 'settings']) assert.equal((await t.db.prepare(`SELECT COUNT(*) n FROM ${tbl}`).get()).n, 0, tbl);
    assert.equal(fs.readdirSync(t.uploadDir).length, 0);
    assert.equal((await t.call('GET', '/api/profile')).body.fullName, '');
  } finally { config.appSecret = old; await t.close(); }
});

test('audit trail records actions without bodies and ignores reads', async () => {
  const t = await startWithJob({ approve: true });
  try {
    await t.call('GET', '/api/dashboard');
    await t.call('PUT', '/api/applications/' + t.jobId, { notes: 'secret-note-content', status: 'ready_to_apply' });
    const rows = (await t.call('GET', '/api/audit?limit=200')).body;
    assert.ok(rows.some((r) => r.action === 'PUT /api/applications/:id' && r.entity === 'application' && r.entity_id === String(t.jobId)));
    assert.ok(rows.some((r) => r.action === 'POST /api/cv-versions/:id/approve'));
    assert.ok(!rows.some((r) => r.action.startsWith('GET')));
    assert.ok(!JSON.stringify(rows).includes('secret-note-content'));
    assert.ok(rows.some((r) => r.action === 'ai_consent_given'));
    assert.ok((await t.call('GET', `/api/audit?entity=cv_version&entity_id=${t.cv.id}`)).body.length >= 1);
  } finally { await t.close(); }
});

test('login throttle: repeated wrong passwords are blocked', async () => {
  config.appPassword = 'right-password';
  const t = await startApp({ consent: false });
  try {
    const bad = { Authorization: 'Basic ' + Buffer.from('u:wrong').toString('base64') };
    for (let i = 0; i < 10; i++) assert.equal((await fetch(t.base + '/api/status', { headers: bad })).status, 401);
    assert.equal((await fetch(t.base + '/api/status', { headers: bad })).status, 429);
    const good = { Authorization: 'Basic ' + Buffer.from('u:right-password').toString('base64') };
    assert.equal((await fetch(t.base + '/api/status', { headers: good })).status, 429, 'locked out even with the right password until the window passes');
  } finally { config.appPassword = ''; await t.close(); }
});
