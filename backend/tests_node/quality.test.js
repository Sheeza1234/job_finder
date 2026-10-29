const test = require('node:test');
const assert = require('node:assert/strict');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../src/config');
const ai = require('../src/services/ai');
const { matchJob } = require('../src/services/match');
const { normalize } = require('../src/services/profile');
const { cvPdf, cvDocx, buildCvModel } = require('../src/services/exportDocs');
const { startApp, startWithJob, SAMPLE_PROFILE, fakeAi } = require('./helpers');

const P = normalize({ skills: ['Photoshop', 'Figma'], categories: ['Graphic Designer'], yearsExperience: 4, experience: [{ id: 'e', title: 'Designer', company: 'X', bullets: [] }] });
const J = (o) => ({ title: 'Graphic Designer', description: 'Photoshop and Figma', skills: [], experience_level: 'unknown', ...o });

test('match score: documented weights (50% skills, 35% title, 15% experience) give exact results', async () => {
  assert.equal(matchJob(P, J()).score, 94);                                                     // 1.0 skills, 1.0 title, 0.6 neutral experience
  assert.equal(matchJob(P, J({ title: 'Backend Engineer' })).score, 59);                        // title match lost: -35
  assert.equal(matchJob(P, J({ description: 'Photoshop Figma Illustrator Sketch' })).score, 69); // 2 of 4 required skills
  assert.equal(matchJob(P, J({ title: 'Senior Graphic Designer', experience_level: 'senior' })).score, 96);        // 4 yrs vs 5 needed: experience 0.75
  assert.equal(matchJob({ ...P, yearsExperience: 1 }, J({ experience_level: 'senior' })).score, 85);             // 1 yr vs 5 needed: experience 0
  assert.equal(matchJob({ ...P, yearsExperience: 10 }, J({ experience_level: 'senior' })).score, 100);
  assert.equal(matchJob(P, J({ description: 'We value teamwork', title: 'Graphic Designer' })).score, Math.round(100 * (0.5 * 0.4 + 0.35 + 0.15 * 0.6)), 'no recognisable skills: neutral 0.4');
  assert.equal(matchJob(normalize({}), J()).score, null, 'empty profile: no score rather than a fake one');
});

test('match score: missing required qualifications are listed, and never counted as matched', async () => {
  const m = matchJob(P, J({ description: 'Photoshop, Figma, Illustrator, motion graphics and After Effects required' }));
  assert.deepEqual(m.matchedSkills.sort(), ['figma', 'photoshop']);
  assert.deepEqual(m.missingSkills.sort(), ['after effects', 'illustrator', 'motion graphics']);
  assert.ok(!matchJob(P, J({ description: 'Fluent English and Arabic' })).missingSkills.includes('arabic'), 'language words are not skill gaps');
});

test('AI analysis gaps flow to the dashboard as missing requirements', async () => {
  const t = await startWithJob();
  try {
    ai.setClient(fakeAi({ score: 61, verdict: 'possible_match', summary: 's', strengths: [], gaps: ['5 years of agency experience', 'Arabic copywriting'], requirements: [{ requirement: 'Arabic copywriting', status: 'gap', evidence: '' }], keywords: ['Figma'] }));
    const a = (await t.call('POST', `/api/jobs/${t.jobId}/analyze`)).body;
    assert.equal(a.score, 61); assert.equal(a.requirements[0].status, 'gap');
    await t.call('PUT', '/api/settings/search', { minMatchScore: 60 });
    const card = (await t.call('GET', '/api/dashboard')).body.recommended.find((c) => c.id === t.jobId);
    assert.deepEqual(card.missing, ['5 years of agency experience', 'Arabic copywriting']); assert.equal(card.match_method, 'ai');
  } finally { await t.close(); }
});

test('application status transitions are recorded as a history and respect the rules', async () => {
  const t = await startWithJob({ approve: true });
  try {
    const put = (b) => t.call('PUT', `/api/applications/${t.jobId}`, b);
    for (const s of ['shortlisted', 'ready_to_apply']) assert.equal((await put({ status: s })).status, 200);
    assert.equal((await put({ status: 'applied' })).body.submission_source, 'user_declared');
    const appliedAt = (await t.call('GET', `/api/applications/${t.jobId}`)).body.applied_at;
    for (const s of ['assessment', 'interview', 'offer']) assert.equal((await put({ status: s })).status, 200);
    assert.equal((await put({ status: 'interview' })).body.applied_at, appliedAt, 'moving back keeps the original applied date');
    assert.equal((await put({ status: 'listing_expired' })).status, 200);
    assert.equal((await put({ status: 'bogus' })).status, 400);
    const log = (await t.call('GET', `/api/applications/${t.jobId}`)).body.submission_log.filter((e) => e.event === 'status');
    assert.deepEqual(log.map((e) => `${e.from}>${e.to}`), ['saved>awaiting_approval', 'awaiting_approval>cv_ready', 'cv_ready>shortlisted', 'shortlisted>ready_to_apply', 'ready_to_apply>applied', 'applied>assessment', 'assessment>interview', 'interview>offer', 'offer>interview', 'interview>listing_expired']);
    assert.ok(log.every((e) => e.at));
    assert.deepEqual(log.filter((e) => e.auto).length, 2, 'automatic moves are marked as such; user moves are not');
  } finally { await t.close(); }
});

test('CV parsing: AI output is normalised into a safe draft (ids, trimming, unknown fields dropped, prose around JSON tolerated)', async () => {
  const t = await startApp();
  try {
    const fd = new FormData(); fd.append('kind', 'cv'); fd.append('file', new Blob(['Jane Doe\nDesigner at Acme 2020-2024'], { type: 'text/plain' }), 'cv.txt');
    const docId = (await (await fetch(t.base + '/api/documents', { method: 'POST', body: fd })).json()).id;
    ai.setClient(fakeAi('Sure! Here is the data:\n```json\n' + JSON.stringify({ fullName: '  Jane Doe  ', yearsExperience: '4', isAdmin: true, skills: ['Figma', '', 'Photoshop'],
      experience: [{ title: 'Designer', company: 'Acme', start: '2020-01', end: '2024-01', bullets: ['Made things'], salary: 999999 }], education: [{ degree: 'BA', institution: 'U' }] }) + '\n```'));
    const { draft } = (await t.call('POST', '/api/profile/import-cv', { documentId: docId })).body;
    assert.equal(draft.fullName, 'Jane Doe'); assert.equal(draft.yearsExperience, 4); assert.deepEqual(draft.skills, ['Figma', 'Photoshop']);
    assert.match(draft.experience[0].id, /^[0-9a-f]{8}$/); assert.ok(!('salary' in draft.experience[0])); assert.ok(!('isAdmin' in draft));
    assert.equal((await t.call('GET', '/api/profile')).body.fullName, '', 'a draft is never saved automatically');
    assert.equal((await t.call('POST', '/api/profile/import-cv', { documentId: 999 })).status, 404);
  } finally { ai.setClient(null); await t.close(); }
});

test('CV text extraction from real PDF and DOCX files (including an unreadable one)', async () => {
  const t = await startApp();
  try {
    const model = buildCvModel(normalize({ fullName: 'Layla Hassan', email: 'l@x.com', skills: ['Figma'], experience: [{ id: 'e', title: 'Designer', company: 'Studio Nine', start: '2020', bullets: ['Built design systems'] }] }), null);
    const up = async (bytes, name) => { const fd = new FormData(); fd.append('kind', 'cv'); fd.append('file', new Blob([bytes]), name); return (await fetch(t.base + '/api/documents', { method: 'POST', body: fd })).json(); };
    const pdf = await up(await cvPdf(model), 'a.pdf'); const docx = await up(await cvDocx(model), 'b.docx'); const blank = await up('%PDF-1.4\n%%EOF', 'c.pdf');
    assert.ok(pdf.text_chars > 40 && docx.text_chars > 40); assert.equal(blank.text_chars, 0, 'unreadable file is stored, not parsed');
    const text = async (id) => (await t.db.prepare('SELECT text FROM documents WHERE id = ?').get(id)).text;
    for (const id of [pdf.id, docx.id]) for (const w of ['Layla Hassan', 'Studio Nine', 'Built design systems']) assert.ok((await text(id)).includes(w), `${w} in doc ${id}`);
  } finally { await t.close(); }
});

test('API error handling: malformed JSON, unknown ids, oversize bodies and uploads, provider failures, hidden internals', async () => {
  const old = config.maxUploadMb; config.maxUploadMb = 0.0005;
  const t = await startWithJob(); config.maxUploadMb = old;
  const quiet = console.error; console.error = () => {};
  try {
    const raw = await fetch(t.base + '/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    assert.equal(raw.status, 400); assert.ok((await raw.json()).error);
    const big = await fetch(t.base + '/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: 'x'.repeat(3_000_000) }) });
    assert.equal(big.status, 413);
    for (const [m, u] of [['GET', '/api/jobs/99999'], ['GET', '/api/jobs/abc'], ['GET', '/api/cv-versions/99999'], ['GET', '/api/letters/99999'], ['GET', '/api/applications/99999'], ['POST', '/api/jobs/99999/analyze'], ['PUT', '/api/applications/99999'], ['GET', '/api/cv-versions/99999/download'], ['GET', '/api/documents/99999/download'], ['GET', '/api/nope']]) {
      const r = await t.call(m, u, m === 'GET' ? undefined : {}); assert.equal(r.status, 404, `${m} ${u}`); assert.ok(r.body.error);
    }
    const fd = new FormData(); fd.append('file', new Blob(['x'.repeat(5000)]), 'big.txt');
    assert.equal((await fetch(t.base + '/api/documents', { method: 'POST', body: fd })).status, 413);

    ai.setClient({ messages: { create: async () => { throw new Anthropic.APIError(529, { error: { message: 'overloaded' } }, 'overloaded', new Headers()); } } });
    const prov = await t.call('POST', `/api/jobs/${t.jobId}/analyze`); assert.equal(prov.status, 502); assert.match(prov.body.error, /AI provider error/);
    ai.setClient({ messages: { create: async () => { throw new Anthropic.APIError(500, { error: { message: 'upstream exploded' } }, 'upstream exploded', new Headers()); } } });
    const up500 = await t.call('POST', `/api/jobs/${t.jobId}/analyze`); assert.equal(up500.status, 502); assert.match(up500.body.error, /upstream exploded/, 'a provider 500 is reported as a provider problem');
    ai.setClient({ messages: { create: async () => { throw new Error('db password is hunter2 at /srv/internal'); } } });
    const boom = await t.call('POST', `/api/jobs/${t.jobId}/analyze`); assert.equal(boom.status, 500);
    assert.equal(boom.body.error, 'Internal server error'); assert.ok(!JSON.stringify(boom.body).includes('hunter2'), 'internal details never reach the client');
    ai.setClient(fakeAi('no json here'));
    assert.equal((await t.call('POST', `/api/jobs/${t.jobId}/analyze`)).status, 502);
  } finally { console.error = quiet; ai.setClient(null); await t.close(); }
});

test('authorization: with a password set, EVERY route except /healthz demands credentials', async () => {
  config.appPassword = 'pw-123';
  const t = await startApp({ consent: false });
  try {
    const routes = [];
    for (const layer of t.app.router.stack) if (layer.route) for (const m of Object.keys(layer.route.methods)) routes.push([m.toUpperCase(), layer.route.path]);
    assert.ok(routes.length > 70, `enumerated ${routes.length} routes`);
    const open = [];
    for (const [m, path] of routes) {
      const url = path.replace(/:[A-Za-z]+/g, '1');
      const r = await fetch(t.base + url, { method: m, headers: { 'Content-Type': 'application/json' }, body: m === 'GET' || m === 'DELETE' ? undefined : '{}' });
      if (r.status !== 401 && path !== '/healthz') open.push(`${m} ${path} -> ${r.status}`);
    }
    assert.deepEqual(open, [], 'routes reachable without credentials');
    assert.equal((await fetch(t.base + '/index.html')).status, 401, 'static UI is protected too');
    assert.equal((await fetch(t.base + '/dl/whatever')).status, 401);
  } finally { config.appPassword = ''; await t.close(); }
});

test('data isolation: a tampered file reference cannot read or delete files outside the upload directory', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const t = await startApp();
  const secret = path.join(os.tmpdir(), `jf-secret-${Date.now()}.txt`); fs.writeFileSync(secret, 'TOP SECRET');
  try {
    (await t.db.prepare("INSERT INTO documents (kind, filename, mime, stored_name, text, created_at) VALUES ('cv','x.txt','text/plain',?,'','now')").run(path.relative(t.uploadDir, secret)));
    const id = (await t.db.prepare('SELECT id FROM documents').get()).id;
    const dl = await t.call('GET', `/api/documents/${id}/download`);
    assert.equal(dl.status, 400); assert.ok(!JSON.stringify(dl.body).includes('TOP SECRET'));
    const link = (await t.call('POST', `/api/documents/${id}/link`)).body.url;
    assert.equal((await fetch(t.base + link)).status, 400);
    await t.call('DELETE', `/api/documents/${id}`).catch(() => {});
    assert.ok(fs.existsSync(secret), 'the outside file survives deletion of the record');
  } finally { fs.rmSync(secret, { force: true }); await t.close(); }
});
