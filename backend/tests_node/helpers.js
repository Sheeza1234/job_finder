const os = require('os');
const fs = require('fs');
const path = require('path');
const { openDb, dropSchema } = require('../src/db');
const { createApp } = require('../src/app');

// Tests run against a throwaway Postgres (docker run -p 55432:5432 postgres:16-alpine), never against your Supabase project.
// Every test gets its own schema, so tests cannot see each other's data.
const TEST_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:test@127.0.0.1:55432/jobfinder_test';
let counter = 0;
const opened = new Set();
require('node:test').after(async () => { for (const db of opened) await db.drop().catch(() => {}); });   // safety net for tests that forget
async function newDb() {
  const db = await openDb({ url: TEST_URL, schema: `t_${process.pid}_${Date.now().toString(36)}_${counter++}`, max: 4 });
  db.drop = () => dropSchema(db);
  opened.add(db);
  return db;
}

async function startApp({ consent = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-'));
  const db = await newDb();
  const app = createApp(db, { uploadDir: dir });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
  };
  if (consent) await call('POST', '/api/privacy/consent', { ai: true });
  return { app, db, base, call, uploadDir: dir, close: async () => { server.close(); server.closeAllConnections?.(); await db.drop(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const SAMPLE_PROFILE = {
  fullName: 'Test Candidate', email: 't@example.com', headline: 'Graphic Designer', yearsExperience: 4,
  skills: ['Photoshop', 'Illustrator', 'Figma', 'Branding'], categories: ['Graphic Designer'],
  experience: [{ id: 'exp1', title: 'Graphic Designer', company: 'Acme Studio', start: '2021-01', current: true, bullets: ['Designed brand identities for 12 clients', 'Built social media templates in Photoshop'] }],
  projects: [{ id: 'proj1', name: 'Cafe Rebrand', description: 'Logo and packaging for a cafe', tech: ['Illustrator'] }],
};

const SAMPLE_JOB = {
  title: 'Senior Graphic Designer', company: 'Riyadh Creative Co', location: 'Riyadh, Saudi Arabia',
  text: 'We are hiring a Senior Graphic Designer in Riyadh. Full-time, on-site. 5+ years experience with Photoshop, Illustrator, Figma and branding. Visa sponsorship is available for the right candidate.',
};

module.exports = { startApp, newDb, SAMPLE_PROFILE, SAMPLE_JOB };

const ai = require('../src/services/ai');
const fakeAi = (reply) => ({ messages: { create: async () => ({ content: [{ type: 'text', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }] }) } });

// App with profile saved + one imported job + a tailored (AI-faked) CV version ready.
async function startWithJob({ approve = false } = {}) {
  const ctx = await startApp();
  await ctx.call('PUT', '/api/profile', { ...SAMPLE_PROFILE, phone: '+966500000000', location: 'Lahore, Pakistan', answers: { noticePeriod: '30 days' } });
  const jobId = (await ctx.call('POST', '/api/jobs/import', SAMPLE_JOB)).body.id;
  const GOOD = { headline: 'Graphic Designer', summary: 'Designer with 4 years of experience in branding.', skills: ['Photoshop', 'Figma'],
    experience: [{ id: 'exp1', bullets: ['Designed brand identities for 12 clients'] }], projects: [{ id: 'proj1', description: 'Logo and packaging for a cafe' }],
    keywords_used: [{ keyword: 'branding', supported_by: 'skills' }], changes: [{ section: 'summary', change: 'Led with branding', reason: 'Job asks for branding' }], gaps: [] };
  ai.setClient(fakeAi(GOOD));
  const cv = (await ctx.call('POST', `/api/jobs/${jobId}/tailor`)).body;
  if (approve) await ctx.call('POST', `/api/cv-versions/${cv.id}/approve`, {});
  return { ...ctx, jobId, cv, GOOD, fakeAi, close: async () => { await ctx.close(); ai.setClient(null); } };
}
module.exports.fakeAi = fakeAi;
module.exports.startWithJob = startWithJob;
