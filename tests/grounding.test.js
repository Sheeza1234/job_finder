const test = require('node:test');
const assert = require('node:assert/strict');
const { groundContent, unsupportedFigures, unsupportedSkillMentions } = require('../src/services/grounding');
const { normalize } = require('../src/services/profile');
const { matchJob } = require('../src/services/match');
const { SAMPLE_PROFILE } = require('./helpers');

const profile = normalize(SAMPLE_PROFILE);

test('invented figures are flagged, real ones are not', async () => {
  assert.deepEqual(unsupportedFigures(profile, 'Led 12 client projects'), []);
  assert.deepEqual(unsupportedFigures(profile, 'Increased sales by 300%'), ['300%']);
});
test('invented skills and unknown ids are removed', async () => {
  const { content: tailored, warnings } = groundContent(profile, {
    summary: 'Designer with 10 years of experience',
    skills: ['Photoshop', 'Kubernetes'],
    experience: [{ id: 'exp1', bullets: ['Designed brands'] }, { id: 'fake', bullets: ['Worked at Google'] }],
    projects: [{ id: 'nope', description: 'x' }],
  });
  assert.deepEqual(tailored.skills, ['Photoshop']);
  assert.equal(tailored.experience.length, 1);
  assert.equal(tailored.projects.length, 0);
  assert.ok(warnings.some((w) => w.includes('Kubernetes')));
  assert.ok(warnings.some((w) => w.includes('"10"') || w.includes('10')));
  assert.ok(warnings.some((w) => w.includes('fake')));
});
test('skills named in free text but absent from the profile are flagged', async () => {
  assert.deepEqual(unsupportedSkillMentions(profile, 'Built stores with Shopify and designed in Figma'), ['shopify']);
  assert.deepEqual(unsupportedSkillMentions(profile, 'Designed logos in Illustrator'), []);
});
test('plural and singular forms count as the same skill (no false "unsupported" warnings)', async () => {
  const p = normalize({ ...SAMPLE_PROFILE, experience: [{ id: 'e', title: 'Designer', company: 'X', bullets: ['Designed brand identities for 12 clients', 'Built logos'] }], skills: ['Branding', 'Logo design'] });
  assert.deepEqual(unsupportedSkillMentions(p, 'I create brand identity systems and a logo design'), []);
  assert.deepEqual(unsupportedSkillMentions(p, 'I also build Shopify stores'), ['shopify']);
});
test('a gap the AI already described is not repeated by the keyword scan', async () => {
  const { groundTailoredCv } = require('../src/services/grounding');
  const out = groundTailoredCv(profile, { summary: '', skills: [], experience: [], projects: [], gaps: [{ requirement: 'Motion graphics experience', note: '' }] },
    { title: 'Designer', description: 'Needs motion graphics and Sketch', skills: [], experience_level: 'unknown' });
  assert.deepEqual(out.gaps.map((g) => g.requirement), ['Motion graphics experience', 'sketch']);
});
test('heuristic match rewards overlap and is null for an empty profile', async () => {
  const good = matchJob(profile, { title: 'Graphic Designer', description: 'Photoshop and Illustrator', skills: [], experience_level: 'mid' });
  const bad = matchJob(profile, { title: 'Backend Engineer', description: 'Kubernetes golang postgres', skills: [], experience_level: 'senior' });
  assert.ok(good.score > bad.score);
  assert.equal(matchJob(normalize({}), { title: 'x', description: '', skills: [] }).score, null);
});
