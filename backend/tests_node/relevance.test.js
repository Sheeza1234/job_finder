const test = require('node:test');
const assert = require('node:assert/strict');
const { matchJob, isRelevant, roleTitles, titleFit, searchTitles } = require('../src/services/match');
const { normalize } = require('../src/services/profile');
const { listJobs, upsertJobs } = require('../src/services/jobsStore');
const { buildJob } = require('../src/normalize');
const { runSearch } = require('../src/services/search');
const { newDb } = require('./helpers');

// A full-stack developer whose saved categories do not describe them (the real-world case that went wrong).
const DEV = normalize({ headline: 'Full Stack Developer · Web Developer · Software Engineer', yearsExperience: 2.5,
  skills: ['React.js', 'Next.js', 'JavaScript (ES6+)', 'TypeScript', 'Node.js', 'REST APIs', 'Firebase (Auth)', 'AWS', 'Git', 'AI Agents', 'Prompt Engineering'],
  experience: [{ id: 'a', title: 'Full Stack Web & App Developer', company: 'X', bullets: ['Built apps with React Native'] }],
  categories: ['Web Designer', 'Frontend Developer', 'AI Tools / AI Automation Specialist'] });
const J = (title, description = '', extra = {}) => ({ title, description, skills: [], experience_level: 'unknown', ...extra });

test('titles are compared as roles: spellings and seniority do not matter, generic words alone never match', async () => {
  assert.equal(titleFit('Full Stack Developer', 'Senior Fullstack Engineer'), 1);
  assert.equal(titleFit('Frontend Developer', 'Front-end Developer (React)'), 1);
  assert.equal(titleFit('Full Stack Developer', 'Tier III Service Desk Engineer'), 0, '"engineer" is generic');
  assert.equal(titleFit('Graphic Designer', 'Interior Designer'), 0);
  assert.ok(titleFit('AI Tools / AI Automation Specialist', 'AI Trainer - Video Annotation') < 0.5, 'one shared buzzword is not a fit');
  assert.deepEqual(roleTitles(DEV).slice(3), ['Full Stack Developer', 'Web Developer', 'Software Engineer', 'Full Stack Web & App Developer'], 'CV headline and roles held count too');
  assert.deepEqual(searchTitles(normalize({ preferredTitles: ['Data Analyst'], headline: 'Data Analyst' })), ['Data Analyst'], 'no duplicates');
});

test('developer skills are recognised, spelling variants are one skill, and "AI" alone is not a skill', async () => {
  const m = matchJob(DEV, J('Senior React Full-stack Developer', 'ReactJS, NextJS, NodeJS, TypeScript, AWS, Docker, GraphQL. 5 years.', { experience_level: 'senior' }));
  for (const k of ['react', 'next.js', 'node.js', 'typescript', 'aws']) assert.ok(m.matchedSkills.includes(k), k);
  assert.ok(m.missingSkills.includes('docker') && m.missingSkills.includes('graphql'));
  assert.ok(m.score >= 70, `real fit scores high (${m.score})`);
  assert.ok(!matchJob(DEV, J('AI Trainer - Video Annotation', 'Annotate videos for robotics AI')).matchedSkills.includes('ai'));
  assert.ok(matchJob(DEV, J('AI Trainer - Video Annotation', 'Annotate videos for robotics AI')).score < 60);
});

test('relevance: fits-by-title or scores well; empty profile keeps everything', async () => {
  assert.equal(isRelevant(DEV, J('Senior React Full-stack Developer', 'React Node.js TypeScript')), true);
  assert.equal(isRelevant(DEV, J('Software Engineer, AI Coding Tasks', 'TypeScript')), true);
  for (const t of ['Remote Office Assistant', 'Inside Sales Contractor', 'Freelance Copywriter', 'Tier III Service Desk Engineer', 'AI Trainer - Video Annotation']) assert.equal(isRelevant(DEV, J(t, 'Generic remote role')), false, t);
  assert.equal(isRelevant(normalize({}), J('Anything')), true);
});

test('search stores only relevant jobs and says how many it dropped', async () => {
  const db = await newDb();
  const mk = (id, title, d) => buildJob({ source: 'p', externalId: id, title, company: 'C' + id, locationText: 'Remote (Worldwide)', description: d, workModeHint: 'remote', remoteRestriction: 'Worldwide' });
  const provider = { id: 'p', enabled: () => true, remoteOnly: true, search: async () => [mk('1', 'Senior React Full-stack Developer', 'React Node.js'), mk('2', 'Remote Office Assistant', 'Admin'), mk('3', 'Freelance Writer', 'Blogs')] };
  const r = await runSearch(db, { categories: ['Full Stack Developer'], cities: [], includeRemote: true, relevance: (j) => isRelevant(DEV, j) }, [provider]);
  assert.equal(r.fetched, 3); assert.equal(r.added, 1); assert.equal(r.filtered_out, 2);
  assert.deepEqual((await db.prepare('SELECT title FROM jobs').all()).map((x) => x.title), ['Senior React Full-stack Developer']);
});

test('"only jobs that fit me" hides weak matches but reports how many, and can be turned off', async () => {
  const db = await newDb();
  await upsertJobs(db, [buildJob({ source: 'p', externalId: '1', title: 'Senior React Full-stack Developer', company: 'A', locationText: 'Riyadh, Saudi Arabia', description: 'React Node.js TypeScript' }),
    buildJob({ source: 'p', externalId: '2', title: 'Remote Office Assistant', company: 'B', locationText: 'Riyadh, Saudi Arabia', description: 'Admin tasks' })]);
  const all = await listJobs(db, {}, DEV); assert.equal(all.total, 2); assert.equal(all.hidden, 0);
  const fit = await listJobs(db, { min_score: 40 }, DEV);
  assert.deepEqual(fit.jobs.map((j) => j.title), ['Senior React Full-stack Developer']); assert.equal(fit.hidden, 1);
  assert.equal((await listJobs(db, { min_score: 40 }, normalize({}))).hidden, 0, 'no profile, nothing is hidden');
});

test('fit=1 hides unrelated jobs even when they share keywords; cleanup removes only untracked, unrelated ones', async () => {
  const db = await newDb();
  const mk = (id, title, d, extra = {}) => buildJob({ source: 'p', externalId: id, title, company: 'C' + id, locationText: 'Remote (Worldwide)', description: d, workModeHint: 'remote', remoteRestriction: 'Worldwide', ...extra });
  await upsertJobs(db, [mk('1', 'Senior React Full-stack Developer', 'React Node.js TypeScript AWS'),
    mk('2', 'Freelance Copywriter', 'Write blog posts. Some Node.js knowledge and React is a plus, AWS, Git, TypeScript, Firebase'),
    mk('3', 'Remote Office Assistant', 'Admin tasks'),
    mk('4', 'Inside Sales Contractor', 'Sell things')]);
  const titles = (r) => r.jobs.map((j) => j.title);
  const keep = (await db.prepare("SELECT id FROM jobs WHERE title = 'Remote Office Assistant'").get()).id;
  (await db.prepare("INSERT INTO applications (job_id, status, updated_at) VALUES (?, 'saved', ?)").run(keep, new Date().toISOString()));   // user is tracking it
  const fit = await listJobs(db, { fit: '1', min_score: '50' }, DEV);
  assert.ok(!titles(fit).includes('Freelance Copywriter') && !titles(fit).includes('Inside Sales Contractor'));
  assert.ok(titles(fit).includes('Senior React Full-stack Developer'));
  assert.ok(titles(fit).includes('Remote Office Assistant'), 'a job being tracked is never hidden');
  assert.equal('hiddenIds' in fit, false, 'ids are not sent to the browser');
  assert.deepEqual(titles(await listJobs(db, {}, DEV)).sort(), ['Freelance Copywriter', 'Inside Sales Contractor', 'Remote Office Assistant', 'Senior React Full-stack Developer']);
  const { irrelevantIds } = require('../src/services/jobsStore');
  const ids = await irrelevantIds(db, DEV);
  const names = (await Promise.all(ids.map(async (id) => (await db.prepare('SELECT title FROM jobs WHERE id = ?').get(id)).title))).sort();
  assert.deepEqual(names, ['Freelance Copywriter', 'Inside Sales Contractor']);
});
