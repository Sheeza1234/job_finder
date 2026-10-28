const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../src/services/ai');
const { startApp, SAMPLE_PROFILE, SAMPLE_JOB } = require('./helpers');
const { runSearch } = require('../src/services/search');
const { isPrivateIp, safeFetchHtml } = require('../src/services/importJob');

let ctx;
test.before(async () => { ctx = await startApp(); });
test.after(async () => { await ctx.close(); ai.setClient(null); });

const fakeAi = (reply) => ({ messages: { create: async () => ({ content: [{ type: 'text', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }] }) } });

test('profile starts with no pre-selected categories and persists edits', async () => {
  const empty = await ctx.call('GET', '/api/profile');
  assert.equal(empty.body.categories.length, 0, 'no categories are pre-selected: nobody has confirmed they qualify');
  assert.equal((await ctx.call('GET', '/api/meta')).body.categories.length, 13, 'the starter list is still offered as optional quick-adds');
  const saved = await ctx.call('PUT', '/api/profile', SAMPLE_PROFILE);
  assert.equal(saved.body.fullName, 'Test Candidate');
  assert.equal((await ctx.call('GET', '/api/profile')).body.experience[0].company, 'Acme Studio');
});

let jobId;
test('import pasted job, listing and filters', async () => {
  const r = await ctx.call('POST', '/api/jobs/import', SAMPLE_JOB);
  assert.equal(r.status, 201); jobId = r.body.id;
  const all = await ctx.call('GET', '/api/jobs');
  assert.equal(all.body.total, 1);
  assert.equal(all.body.jobs[0].city, 'Riyadh');
  assert.equal(all.body.jobs[0].sponsorship, 'yes');
  assert.equal((await ctx.call('GET', '/api/jobs?city=Jeddah')).body.total, 0);
  assert.equal((await ctx.call('GET', '/api/jobs?skills=figma,photoshop&sponsorship=yes')).body.total, 1);
  assert.equal((await ctx.call('GET', '/api/jobs?sponsorship=not_specified')).body.total, 0);
  assert.equal((await ctx.call('GET', '/api/jobs?experience_level=senior')).body.total, 1);
});

test('import rejects too-short text', async () => {
  assert.equal((await ctx.call('POST', '/api/jobs/import', { title: 'x', text: 'short' })).status, 422);
});

test('AI endpoints return 503 when AI is not configured', async () => {
  ai.setClient(null);
  const r = await ctx.call('POST', `/api/jobs/${jobId}/analyze`);
  assert.equal(r.status, 503);
});

test('AI analysis is stored and used for the score', async () => {
  ai.setClient(fakeAi({ score: 82, verdict: 'strong_match', summary: 'ok', strengths: ['Photoshop'], gaps: [], requirements: [] }));
  const r = await ctx.call('POST', `/api/jobs/${jobId}/analyze`);
  assert.equal(r.status, 200); assert.equal(r.body.score, 82);
  const list = await ctx.call('GET', '/api/jobs');
  assert.equal(list.body.jobs[0].match_score, 82); assert.equal(list.body.jobs[0].match_method, 'ai');
});

test('malformed AI output yields 502, not a crash', async () => {
  ai.setClient(fakeAi('sorry I cannot'));
  assert.equal((await ctx.call('POST', `/api/jobs/${jobId}/analyze`)).status, 502);
});

test('document upload extracts text; disallowed types rejected', async () => {
  const fd = new FormData(); fd.append('kind', 'cv'); fd.append('file', new Blob(['Jane Doe\nGraphic designer'], { type: 'text/plain' }), 'cv.txt');
  const up = await fetch(ctx.base + '/api/documents', { method: 'POST', body: fd });
  assert.equal(up.status, 201); assert.ok((await up.json()).text_chars > 5);
  const bad = new FormData(); bad.append('file', new Blob(['MZ'], { type: 'application/x-msdownload' }), 'evil.exe');
  assert.equal((await fetch(ctx.base + '/api/documents', { method: 'POST', body: bad })).status, 400);
});

test('CV import returns a draft and does not overwrite the saved profile', async () => {
  const docs = (await ctx.call('GET', '/api/documents')).body;
  ai.setClient(fakeAi({ fullName: 'Someone Else', skills: ['Sketch'] }));
  const r = await ctx.call('POST', '/api/profile/import-cv', { documentId: docs[0].id });
  assert.equal(r.body.draft.fullName, 'Someone Else');
  assert.equal((await ctx.call('GET', '/api/profile')).body.fullName, 'Test Candidate');
});

test('search aggregates providers, tolerates failures, keeps only Saudi/eligible-remote jobs', async () => {
  const { buildJob } = require('../src/normalize');
  const good = { id: 'fake', enabled: () => true, search: async () => [
    buildJob({ source: 'fake', externalId: 'a', title: 'Brand Designer', locationText: 'Dammam, Saudi Arabia', description: 'Brand designer role' }),
    buildJob({ source: 'fake', externalId: 'b', title: 'Brand Designer', locationText: 'London, UK', description: 'On site' }),
    buildJob({ source: 'fake', externalId: 'c', title: 'Brand Designer', locationText: 'Remote', description: 'Remote role', workModeHint: 'remote', remoteRestriction: 'Worldwide' }),
    buildJob({ source: 'fake', externalId: 'd', title: 'Brand Designer', locationText: 'Remote', description: 'Remote role', workModeHint: 'remote', remoteRestriction: 'USA Only' }),
  ] };
  const broken = { id: 'broken', enabled: () => true, search: async () => { throw new Error('boom'); } };
  const off = { id: 'off', enabled: () => false, search: async () => { throw new Error('should not run'); } };
  const r = await runSearch(ctx.db, { categories: ['Brand Designer'], cities: ['Dammam'], includeRemote: false }, [good, broken, off]);
  assert.equal(r.fetched, 4); assert.equal(r.kept, 2); assert.equal(r.added, 2);
  assert.equal(r.providers.find((p) => p.id === 'broken').errors.length, 1);
  assert.equal(r.providers.find((p) => p.id === 'off').fetched, 0);
});

test('SSRF guard blocks private addresses and non-http schemes', async () => {
  assert.ok(isPrivateIp('127.0.0.1') && isPrivateIp('10.1.2.3') && isPrivateIp('192.168.0.5') && isPrivateIp('169.254.169.254') && isPrivateIp('::1'));
  assert.ok(!isPrivateIp('8.8.8.8'));
  await assert.rejects(safeFetchHtml('file:///etc/passwd'), /http/);
  await assert.rejects(safeFetchHtml('http://internal.test/x', async () => [{ address: '10.0.0.1' }]), /private/);
});

test('unknown API routes 404 as JSON', async () => {
  const r = await ctx.call('GET', '/api/nope'); assert.equal(r.status, 404); assert.ok(r.body.error);
});
