const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../src/services/ai');
const { basicExtract, mergeDraft, missingFields } = require('../src/services/cvImport');
const { normalize } = require('../src/services/profile');
const { startApp, fakeAi } = require('./helpers');

const CV = `Layla Hassan
Riyadh, Saudi Arabia | +966 50 123 4567 | layla.hassan@example.com
linkedin.com/in/laylahassan | behance.net/layla | https://laylahassan.design
Graphic Designer, Studio Nine 2019 - 2023`;

const AI_DRAFT = { fullName: 'Layla Hassan', headline: 'Graphic Designer', location: 'Riyadh, Saudi Arabia', yearsExperience: 4, skills: ['Figma', 'Photoshop', 'Branding'], languages: ['English', 'Arabic'],
  experience: [{ title: 'Graphic Designer', company: 'Studio Nine', start: '2019-01', end: '2023-06', bullets: ['Designed brand identities'] }],
  education: [{ degree: 'BA Design', institution: 'KSU', year: '2018' }] };

async function upload(t, text, name = 'cv.txt') {
  const fd = new FormData(); fd.append('kind', 'cv'); fd.append('file', new Blob([text], { type: 'text/plain' }), name);
  return (await (await fetch(t.base + '/api/documents', { method: 'POST', body: fd })).json()).id;
}

test('local extraction reads contact details and links, and ignores date ranges', async () => {
  assert.deepEqual(basicExtract(CV), { email: 'layla.hassan@example.com', phone: '+966 50 123 4567', linkedinUrl: 'https://linkedin.com/in/laylahassan',
    portfolioUrl: 'https://behance.net/layla', websiteUrl: 'https://laylahassan.design', fullName: 'Layla Hassan' });
  assert.deepEqual(basicExtract('CURRICULUM VITAE\nWorked 2019 - 2023 at Acme, ref 12345'), {}, 'no false phone, no "CURRICULUM VITAE" as a name');
  assert.deepEqual(basicExtract(''), {});
});

test('merge: fills only empty fields, never overwrites, appends non-duplicate entries, reports what is missing', async () => {
  const current = normalize({ fullName: 'My Chosen Name', skills: ['Figma'], experience: [{ id: 'mine', title: 'Graphic Designer', company: 'Studio Nine', bullets: ['my own wording'] }] });
  const { merged, filled, missing } = mergeDraft(current, { ...AI_DRAFT, fullName: 'Different Name' });
  assert.equal(merged.fullName, 'My Chosen Name'); assert.equal(merged.headline, 'Graphic Designer'); assert.equal(merged.yearsExperience, 4);
  assert.deepEqual(merged.skills, ['Figma', 'Photoshop', 'Branding']);
  assert.equal(merged.experience.length, 1, 'the same job is not duplicated'); assert.deepEqual(merged.experience[0].bullets, ['my own wording']);
  assert.equal(merged.education.length, 1);
  assert.ok(filled.includes('Headline') && filled.some((f) => /Skills \(2 added\)/.test(f)) && !filled.includes('Full name'));
  assert.deepEqual(missing.map((m) => m.key), ['email', 'phone', 'summary']);
  assert.deepEqual(missingFields(normalize({})).map((m) => m.key), ['fullName', 'email', 'phone', 'location', 'headline', 'summary', 'skills', 'experience', 'education']);
});

test('upload then auto-fill: profile filled from the CV, missing fields listed, repeat run changes nothing', async () => {
  const t = await startApp();
  try {
    await upload(t, CV);
    ai.setClient(fakeAi(AI_DRAFT));
    const r = (await t.call('POST', '/api/profile/auto-fill', {})).body;
    assert.equal(r.ai.used, true);
    assert.equal(r.profile.fullName, 'Layla Hassan'); assert.equal(r.profile.email, 'layla.hassan@example.com'); assert.equal(r.profile.phone, '+966 50 123 4567');
    assert.equal(r.profile.experience[0].company, 'Studio Nine'); assert.equal(r.profile.linkedinUrl, 'https://linkedin.com/in/laylahassan');
    assert.deepEqual(r.missing.map((m) => m.label), ['Professional summary']);
    assert.equal((await t.call('GET', '/api/profile')).body.fullName, 'Layla Hassan', 'saved');
    assert.equal((await t.call('GET', '/api/profile/status')).body.import.can_undo, true);
    const again = (await t.call('POST', '/api/profile/auto-fill', {})).body;
    assert.deepEqual(again.filled, [], 'idempotent: nothing new to fill');
    assert.ok((await t.db.prepare("SELECT 1 FROM audit_logs WHERE action = 'POST /api/profile/auto-fill'").get()));
  } finally { ai.setClient(null); await t.close(); }
});

test('manual edits survive: later auto-fill does not overwrite what the user typed', async () => {
  const t = await startApp();
  try {
    await upload(t, CV); ai.setClient(fakeAi(AI_DRAFT));
    await t.call('POST', '/api/profile/auto-fill', {});
    const p = (await t.call('GET', '/api/profile')).body;
    await t.call('PUT', '/api/profile', { ...p, headline: 'Senior Brand Designer', summary: 'Written by me.' });
    ai.setClient(fakeAi({ ...AI_DRAFT, headline: 'Graphic Designer', summary: 'AI summary' }));
    const r = (await t.call('POST', '/api/profile/auto-fill', {})).body;
    assert.equal(r.profile.headline, 'Senior Brand Designer'); assert.equal(r.profile.summary, 'Written by me.');
  } finally { ai.setClient(null); await t.close(); }
});

test('consent: without it nothing is sent to AI; local-only mode still fills contact details', async () => {
  const t = await startApp({ consent: false });
  try {
    await upload(t, CV); let sent = 0; ai.setClient({ messages: { create: async () => { sent++; return { content: [{ type: 'text', text: '{}' }] }; } } });
    const blocked = await t.call('POST', '/api/profile/auto-fill', {}); assert.equal(blocked.status, 403); assert.equal(blocked.body.code, 'consent_required');
    const local = (await t.call('POST', '/api/profile/auto-fill', { useAi: false })).body;
    assert.equal(sent, 0); assert.equal(local.ai.used, false); assert.match(local.ai.note, /nothing was sent/);
    assert.equal(local.profile.email, 'layla.hassan@example.com'); assert.equal(local.profile.experience.length, 0);
    assert.ok(local.missing.some((m) => m.key === 'experience'), 'the user is told what to add manually');
  } finally { ai.setClient(null); await t.close(); }
});

test('degrades gracefully: AI not configured, or AI failing, still fills what it can locally', async () => {
  const t = await startApp();
  try {
    await upload(t, CV); ai.setClient(null);
    const none = (await t.call('POST', '/api/profile/auto-fill', {})).body;
    assert.equal(none.ai.used, false); assert.match(none.ai.note, /not configured/); assert.equal(none.profile.phone, '+966 50 123 4567');
    await t.call('POST', '/api/profile/undo-import');
    ai.setClient({ messages: { create: async () => { throw new Error('gateway down'); } } });
    const quiet = console.error; console.error = () => {};
    const bad = await t.call('POST', '/api/profile/auto-fill', {}); console.error = quiet;
    assert.equal(bad.status, 200); assert.match(bad.body.ai.note, /AI reading failed.*gateway down/); assert.equal(bad.body.profile.email, 'layla.hassan@example.com');
  } finally { ai.setClient(null); await t.close(); }
});

test('undo restores the previous profile exactly', async () => {
  const t = await startApp();
  try {
    await upload(t, CV); ai.setClient(fakeAi(AI_DRAFT));
    await t.call('PUT', '/api/profile', { fullName: 'Typed Before', skills: ['Sketch'] });
    const before = (await t.call('GET', '/api/profile')).body;
    await t.call('POST', '/api/profile/auto-fill', {});
    assert.notDeepEqual((await t.call('GET', '/api/profile')).body, before);
    await t.call('POST', '/api/profile/undo-import');
    assert.deepEqual((await t.call('GET', '/api/profile')).body, before);
    assert.equal((await t.call('POST', '/api/profile/undo-import')).status, 404, 'nothing left to undo');
    assert.equal((await t.call('GET', '/api/profile/status')).body.import, null);
  } finally { ai.setClient(null); await t.close(); }
});

test('auto-fill errors: no CV, unreadable CV, picks the master CV by default', async () => {
  const t = await startApp();
  try {
    assert.equal((await t.call('POST', '/api/profile/auto-fill', {})).status, 404);
    (await t.db.prepare("INSERT INTO documents (kind, filename, mime, stored_name, text, created_at) VALUES ('cv','scan.pdf','application/pdf','x','','now')").run());
    const scan = await t.call('POST', '/api/profile/auto-fill', { documentId: 1 }); assert.equal(scan.status, 422); assert.match(scan.body.error, /scanned/);
    await upload(t, 'Old Person\nold@example.com\n+1 202 555 0143', 'old.txt'); const newer = await upload(t, CV, 'new.txt');
    await t.call('POST', `/api/documents/${newer}/master`); ai.setClient(fakeAi({}));
    const r = (await t.call('POST', '/api/profile/auto-fill', {})).body; assert.equal(r.document.filename, 'new.txt'); assert.equal(r.profile.email, 'layla.hassan@example.com');
  } finally { ai.setClient(null); await t.close(); }
});

test('auto-fill retries once when the AI returns broken output, and reports plainly when it still fails', async () => {
  const t = await startApp();
  try {
    await upload(t, CV);
    let calls = 0;
    const flaky = (failures) => ({ messages: { create: async () => { calls++; return { content: [{ type: 'text', text: calls <= failures ? '{"fullName": "Lay' : JSON.stringify(AI_DRAFT) }] }; } } });
    ai.setClient(flaky(1));
    const ok = (await t.call('POST', '/api/profile/auto-fill', {})).body;
    assert.equal(calls, 2); assert.equal(ok.ai.used, true); assert.equal(ok.ai.failed, undefined); assert.equal(ok.ai.note, '');
    assert.equal(ok.profile.experience[0].company, 'Studio Nine', 'filled after the retry');
    await t.call('POST', '/api/profile/undo-import', {});
    calls = 0; ai.setClient(flaky(5));
    const bad = (await t.call('POST', '/api/profile/auto-fill', {})).body;
    assert.equal(calls, 2, 'gives up after one retry'); assert.equal(bad.ai.used, false); assert.equal(bad.ai.failed, true); assert.match(bad.ai.note, /AI reading failed/);
    assert.equal(bad.profile.email, 'layla.hassan@example.com', 'contact details still read locally');
  } finally { ai.setClient(null); await t.close(); }
});
