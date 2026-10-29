const test = require('node:test');
const assert = require('node:assert/strict');
const mammoth = require('mammoth');
const { pdfText } = require('../src/services/extract');
const { startWithJob } = require('./helpers');

test('tailoring creates a separate version and never touches the profile', async () => {
  const t = await startWithJob();
  try {
    const before = JSON.stringify((await t.call('GET', '/api/profile')).body);
    assert.equal(t.cv.version_no, 1); assert.equal(t.cv.status, 'draft');
    assert.equal(t.cv.model.experience[0].company, 'Acme Studio'); // facts come from the profile
    assert.equal(t.cv.changes[0].reason, 'Job asks for branding');
    assert.ok(t.cv.keywords.some((k) => k.keyword === 'branding'));
    const second = (await t.call('POST', `/api/jobs/${t.jobId}/tailor`)).body;
    assert.equal(second.version_no, 2);
    assert.equal((await t.call('GET', `/api/jobs/${t.jobId}/cv-versions`)).body.length, 2);
    assert.equal(JSON.stringify((await t.call('GET', '/api/profile')).body), before, 'profile unchanged');
    assert.equal((await t.call('GET', `/api/applications/${t.jobId}`)).body.status, 'awaiting_approval');
  } finally { await t.close(); }
});

test('gaps are reported honestly: keyword scan adds unsupported job terms, unsupported skills are not claimed', async () => {
  const t = await startWithJob();
  try {
    t.cv.gaps.forEach((g) => assert.ok(g.requirement));
    const ai = require('../src/services/ai');
    ai.setClient(t.fakeAi({ ...t.GOOD, skills: ['Photoshop', 'Kubernetes'], keywords_used: [{ keyword: 'Kubernetes' }], summary: 'Expert in Figma and Shopify with 4 years of experience.' }));
    const v = (await t.call('POST', `/api/jobs/${t.jobId}/tailor`)).body;
    assert.deepEqual(v.content.skills, ['Photoshop']);
    assert.ok(v.warnings.some((w) => w.includes('Kubernetes')));
    assert.ok(v.warnings.some((w) => /shopify/i.test(w)), 'skill smuggled into free text is flagged');
    assert.equal(v.keywords.length, 0);
  } finally { await t.close(); }
});

test('approval requires acknowledgement when there are warnings; edits re-ground and approval does not carry over', async () => {
  const t = await startWithJob();
  try {
    const ai = require('../src/services/ai');
    ai.setClient(t.fakeAi({ ...t.GOOD, summary: 'Boosted sales by 300%.' }));
    const bad = (await t.call('POST', `/api/jobs/${t.jobId}/tailor`)).body;
    assert.ok(bad.warnings.length);
    assert.equal((await t.call('POST', `/api/cv-versions/${bad.id}/approve`, {})).status, 409);
    const fixed = await t.call('PUT', `/api/cv-versions/${bad.id}`, { summary: 'Designer focused on branding.' });
    assert.equal(fixed.body.warnings.length, 0); assert.equal(fixed.body.id, bad.id, 'draft edited in place');
    assert.equal((await t.call('POST', `/api/cv-versions/${bad.id}/approve`, {})).body.status, 'approved');
    const reedit = await t.call('PUT', `/api/cv-versions/${bad.id}`, { summary: 'Designer. 99 awards.' });
    assert.notEqual(reedit.body.id, bad.id, 'editing an approved version forks a new draft');
    assert.equal(reedit.body.status, 'draft'); assert.equal(reedit.body.parent_id, bad.id);
    assert.ok(reedit.body.warnings.some((w) => w.includes('99')));
    assert.equal((await t.call('GET', `/api/cv-versions/${bad.id}`)).body.status, 'approved', 'approved original untouched');
  } finally { await t.close(); }
});

test('compare shows differences against the original profile CV', async () => {
  const t = await startWithJob();
  try {
    const r = (await t.call('GET', `/api/cv-versions/${t.cv.id}/compare`)).body;
    assert.match(r.left_label, /Original/);
    const summary = r.diff.find((d) => d.section === 'Summary');
    assert.ok(summary.lines.some((l) => l.type === 'add'));
    const skills = r.diff.find((d) => d.section === 'Skills').lines;
    assert.ok(skills.some((l) => l.type === 'del' && l.text === 'Illustrator'), 'dropped skill shows as removed');
  } finally { await t.close(); }
});

test('PDF and DOCX exports are valid, readable and ATS-friendly (selectable text, standard headings)', async () => {
  const t = await startWithJob({ approve: true });
  try {
    const pdf = await t.call('GET', `/api/cv-versions/${t.cv.id}/download?format=pdf`);
    assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
    const text = await pdfText(pdf.body);
    for (const w of ['Test Candidate', 'SUMMARY', 'SKILLS', 'EXPERIENCE', 'Acme Studio', 'Photoshop', 'Designed brand identities for 12 clients']) assert.ok(text.includes(w), `pdf text has ${w}`);
    assert.ok(!text.includes('Illustrator'), 'dropped skill is not in the tailored export');
    assert.match(pdf.headers.get('content-disposition'), /v1\.pdf/); assert.ok(!/DRAFT/.test(pdf.headers.get('content-disposition')));

    const docx = await t.call('GET', `/api/cv-versions/${t.cv.id}/download?format=docx`);
    assert.equal(docx.body.subarray(0, 2).toString(), 'PK');
    const dt = (await mammoth.extractRawText({ buffer: docx.body })).value;
    for (const w of ['Test Candidate', 'Acme Studio', 'Photoshop']) assert.ok(dt.includes(w), `docx text has ${w}`);

    assert.equal((await t.call('GET', `/api/cv-versions/${t.cv.id}/download?format=exe`)).status, 400);
  } finally { await t.close(); }
});

test('draft downloads are labelled DRAFT; Arabic is refused for PDF but works in DOCX', async () => {
  const t = await startWithJob();
  try {
    assert.match((await t.call('GET', `/api/cv-versions/${t.cv.id}/download?format=docx`)).headers.get('content-disposition'), /_DRAFT\.docx/);
    const ai = require('../src/services/ai');
    ai.setClient(t.fakeAi('مرحبا، أنا Test Candidate'));
    const letter = (await t.call('POST', `/api/jobs/${t.jobId}/cover-letter`, { language: 'ar' })).body;
    const pdf = await t.call('GET', `/api/letters/${letter.id}/download?format=pdf`);
    assert.equal(pdf.status, 422); assert.match(pdf.body.error, /DOCX/);
    const docx = await t.call('GET', `/api/letters/${letter.id}/download?format=docx`);
    assert.equal(docx.status, 200);
    assert.ok((await mammoth.extractRawText({ buffer: docx.body })).value.includes('مرحبا'));
  } finally { await t.close(); }
});

test('cover letter versions: warnings, edit, approve, export', async () => {
  const t = await startWithJob();
  try {
    const ai = require('../src/services/ai');
    ai.setClient(t.fakeAi('Dear Hiring Manager, I grew revenue 400% and know Shopify well. Regards, Test Candidate'));
    const l = (await t.call('POST', `/api/jobs/${t.jobId}/cover-letter`, {})).body;
    assert.equal(l.version_no, 1); assert.ok(l.warnings.some((w) => w.includes('400%'))); assert.ok(l.warnings.some((w) => /shopify/i.test(w)));
    assert.equal((await t.call('POST', `/api/letters/${l.id}/approve`, {})).status, 409);
    const fixed = (await t.call('PUT', `/api/letters/${l.id}`, { text: 'Dear Hiring Manager, I enjoy branding work. Regards, Test Candidate' })).body;
    assert.equal(fixed.warnings.length, 0);
    assert.equal((await t.call('POST', `/api/letters/${l.id}/approve`, {})).body.status, 'approved');
    const pdf = await t.call('GET', `/api/letters/${l.id}/download?format=pdf`);
    assert.ok((await pdfText(pdf.body)).includes('branding work'));
    const list = (await t.call('GET', `/api/jobs/${t.jobId}/letters`)).body;
    assert.equal(list.length, 1);
  } finally { await t.close(); }
});

test('tailored CV follows the AI relevance order while facts stay from the profile', async () => {
  const t = await startWithJob();
  try {
    const profile = (await t.call('GET', '/api/profile')).body;
    await t.call('PUT', '/api/profile', { ...profile, experience: [...profile.experience, { id: 'exp2', title: 'Intern', company: 'Beta Ltd', start: '2019-01', end: '2020-12', bullets: ['Filed documents'] }] });
    const ai = require('../src/services/ai');
    ai.setClient(t.fakeAi({ ...t.GOOD, experience: [{ id: 'exp2', bullets: ['Filed documents'] }, { id: 'exp1', bullets: ['Designed brand identities for 12 clients'] }] }));
    const v = (await t.call('POST', `/api/jobs/${t.jobId}/tailor`)).body;
    assert.deepEqual(v.model.experience.map((e) => [e.company, e.dates]), [['Beta Ltd', '2019-01 – 2020-12'], ['Acme Studio', '2021-01 – Present']]);
  } finally { await t.close(); }
});
