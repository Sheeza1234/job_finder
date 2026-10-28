const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../src/services/ai');
const { suggestLocal, validateAi } = require('../src/services/titles');
const { normalize, targetTitles } = require('../src/services/profile');
const { startApp, fakeAi } = require('./helpers');

const CV = 'Noor Q\nUI/UX Designer at Tamkeen. Skills: Figma, prototyping, user research, design systems, Photoshop, branding. 6 years of experience. Ran Google Ads and SEO campaigns.';
const P = normalize({ headline: 'Designer', yearsExperience: 6, skills: ['Figma', 'Photoshop'] });

test('offline suggestions come only from keywords actually present, each with its evidence', async () => {
  const { keywords, suggestions } = suggestLocal(P, CV);
  const by = Object.fromEntries(suggestions.map((s) => [s.title, s]));
  assert.ok(by['UI/UX Designer'] && by['UI/UX Designer'].evidence.includes('figma') && by['UI/UX Designer'].evidence.includes('prototyping'));
  assert.ok(by['SEO Specialist']);
  assert.ok(!by['Digital Marketing Specialist'], 'one weak signal (Google Ads) is not enough; this rule needs two');
  assert.ok(by['Senior Graphic Designer'], '6 years + design tools -> senior is reasonable');
  assert.ok(!by['Shopify Developer'] && !by['Frontend Developer'], 'nothing is suggested without evidence');
  assert.match(by['UI/UX Designer'].reason, /Your CV mentions/);
  assert.ok(keywords.includes('figma') && keywords.includes('seo') && !keywords.includes('shopify'));
  assert.ok(suggestions.length <= 8);
  assert.ok(!suggestLocal(normalize({ yearsExperience: 2 }), 'Worked at Acme. Photoshop, Illustrator.').suggestions.some((s) => /Senior/.test(s.title)), 'no seniority claim without the years');
  assert.deepEqual(suggestLocal(normalize({}), 'Hello world').suggestions, []);
});

test('AI suggestions are untrusted: titles without evidence in the CV are dropped', async () => {
  const raw = { keywords: ['Figma', 'Kubernetes'], suggested_titles: [
    { title: 'Product Designer', reason: 'Designs apps', evidence: ['figma', 'prototyping'] },
    { title: 'Cloud Architect', reason: 'Because', evidence: ['kubernetes', 'terraform'] },
    { title: 'Brand Manager', reason: 'x', evidence: [] },
    { title: 'product designer', reason: 'dup', evidence: ['figma'] },
    { title: 'SEO Specialist', evidence: ['seo', 'invented-skill'] }] };
  const v = validateAi(raw, P, CV);
  assert.deepEqual(v.suggestions.map((s) => s.title), ['Product Designer', 'SEO Specialist']);
  assert.deepEqual(v.suggestions[1].evidence, ['seo'], 'invented evidence is removed');
  assert.ok(!v.keywords.includes('Kubernetes'));
});

test('auto-fill from a CV adds title tags and keywords, and never touches tags the user already chose', async () => {
  const t = await startApp();
  try {
    const up = async (text) => { const fd = new FormData(); fd.append('kind', 'cv'); fd.append('file', new Blob([text]), 'cv.txt'); return (await (await fetch(t.base + '/api/documents', { method: 'POST', body: fd })).json()).id; };
    await up(CV);
    ai.setClient(fakeAi({ fullName: 'Noor Q', headline: 'UI/UX Designer', skills: ['Figma'], keywords: ['Figma', 'user research'],
      suggested_titles: [{ title: 'UI/UX Designer', reason: 'Your CV says so', evidence: ['figma', 'user research'] }, { title: 'Imaginary Role', reason: 'x', evidence: ['unicorns'] }] }));
    const r = (await t.call('POST', '/api/profile/auto-fill', {})).body;
    assert.deepEqual(r.profile.preferredTitles, ['UI/UX Designer']); assert.match(r.filled.join('|'), /Target job titles \(1 suggested\)/);
    assert.ok(r.profile.cvKeywords.includes('figma')); assert.deepEqual(r.suggestions.map((s) => s.title), ['UI/UX Designer']);
    assert.deepEqual((await t.call('GET', '/api/profile')).body.categories, [], 'no category is pre-ticked');

    const p = (await t.call('GET', '/api/profile')).body;
    await t.call('PUT', '/api/profile', { ...p, preferredTitles: ['My Own Title'] });
    ai.setClient(fakeAi({ suggested_titles: [{ title: 'Brand Designer', evidence: ['branding'] }] }));
    const again = (await t.call('POST', '/api/profile/auto-fill', {})).body;
    assert.deepEqual(again.profile.preferredTitles, ['My Own Title'], 'your tags are never replaced');
  } finally { ai.setClient(null); await t.close(); }
});

test('suggest-titles: local mode needs no consent and sends nothing; AI mode needs consent; failures fall back', async () => {
  const t = await startApp({ consent: false });
  try {
    const fd = new FormData(); fd.append('kind', 'cv'); fd.append('file', new Blob([CV]), 'cv.txt'); await fetch(t.base + '/api/documents', { method: 'POST', body: fd });
    let sent = 0; ai.setClient({ messages: { create: async () => { sent++; return { content: [{ type: 'text', text: '{}' }] }; } } });
    assert.equal((await t.call('POST', '/api/profile/suggest-titles', {})).status, 403);
    const local = (await t.call('POST', '/api/profile/suggest-titles', { useAi: false })).body;
    assert.equal(sent, 0); assert.equal(local.ai.used, false); assert.ok(local.suggestions.some((s) => s.title === 'UI/UX Designer'));
    await t.call('POST', '/api/privacy/consent', { ai: true });
    ai.setClient({ messages: { create: async () => { throw new Error('gateway down'); } } });
    const quiet = console.error; console.error = () => {};
    const fb = (await t.call('POST', '/api/profile/suggest-titles', {})).body; console.error = quiet;
    assert.match(fb.ai.note, /AI suggestion failed.*gateway down/); assert.ok(fb.suggestions.length);
  } finally { ai.setClient(null); await t.close(); }
});

test('a legacy profile with the untouched "all 13 categories" default is treated as no choice made', async () => {
  const t = await startApp();
  try {
    const { DEFAULT_CATEGORIES } = require('../src/services/profile');
    (await t.db.prepare("INSERT INTO profile (id, data, updated_at) VALUES (1, ?, now())").run(JSON.stringify({ fullName: 'Old User', categories: DEFAULT_CATEGORIES })));
    assert.deepEqual((await t.call('GET', '/api/profile')).body.categories, []);
    (await t.db.prepare('UPDATE profile SET data = ?').run(JSON.stringify({ fullName: 'Old User', categories: ['Brand Designer', 'SEO Specialist'] })));
    assert.deepEqual(targetTitles((await t.call('GET', '/api/profile')).body), ['Brand Designer', 'SEO Specialist'], 'a real selection is kept');
  } finally { await t.close(); }
});
