const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const apps = require('../src/services/applications');
const { checkListing } = require('../src/services/importJob');
const { startWithJob, SAMPLE_JOB } = require('./helpers');

test('12 statuses in the requested order', async () => {
  assert.deepEqual(apps.STATUSES.map(([, l]) => l), ['Saved', 'Shortlisted', 'CV Ready', 'Awaiting My Approval', 'Ready to Apply', 'Applied', 'Assessment', 'Interview', 'Offer', 'Rejected', 'Withdrawn', 'Listing Expired']);
});

test('status follows versions: awaiting approval -> CV ready; ready to apply needs an approved CV', async () => {
  const t = await startWithJob();
  try {
    assert.equal((await t.call('GET', `/api/applications/${t.jobId}`)).body.status, 'awaiting_approval');
    const blocked = await t.call('PUT', `/api/applications/${t.jobId}`, { status: 'ready_to_apply' });
    assert.equal(blocked.status, 409); assert.match(blocked.body.error, /Approve a CV/);
    await t.call('POST', `/api/cv-versions/${t.cv.id}/approve`, {});
    const a = (await t.call('GET', `/api/applications/${t.jobId}`)).body;
    assert.equal(a.status, 'cv_ready'); assert.equal(a.cv_version_id, t.cv.id);
    const ok = await t.call('PUT', `/api/applications/${t.jobId}`, { status: 'ready_to_apply' });
    assert.equal(ok.status, 200); assert.equal(ok.body.status_label, 'Ready to Apply');
  } finally { await t.close(); }
});

test('tracked fields validate and persist', async () => {
  const t = await startWithJob();
  try {
    const put = (b) => t.call('PUT', `/api/applications/${t.jobId}`, b);
    assert.equal((await put({ follow_up_date: 'tomorrow' })).status, 400);
    assert.equal((await put({ interview_dates: ['not a date'] })).status, 400);
    assert.equal((await put({ status: 'nonsense' })).status, 400);
    assert.equal((await put({ cv_version_id: 99999 })).status, 400);
    const r = (await put({ follow_up_date: '2026-11-10', interview_dates: ['2026-11-12T10:00'], notes: 'n', recruiter: { name: 'Sara', email: 's@x.com' } })).body;
    assert.equal(r.follow_up_date, '2026-11-10'); assert.deepEqual(r.interview_dates, ['2026-11-12T10:00']); assert.equal(r.recruiter.name, 'Sara');
  } finally { await t.close(); }
});

test('duplicate applications are blocked unless explicitly allowed (even across sources)', async () => {
  const t = await startWithJob({ approve: true });
  try {
    assert.equal((await t.call('POST', `/api/applications/${t.jobId}/mark-submitted`, { confirmation: 'ref-1' })).body.submission_source, 'user_declared');
    // same employer/title/city arriving from a different source
    const { upsertJobs } = require('../src/services/jobsStore');
    const { buildJob } = require('../src/normalize');
    await upsertJobs(t.db, [buildJob({ source: 'jooble', externalId: 'x9', title: 'Senior Graphic Designer', company: 'Riyadh Creative Co', locationText: 'Riyadh, Saudi Arabia', description: 'Same role, other board' })]);
    const dupId = (await t.db.prepare("SELECT id FROM jobs WHERE source = 'jooble'").get()).id;
    assert.equal((await t.call('GET', `/api/applications/${dupId}/duplicates`)).body.length, 1);
    const r = await t.call('POST', `/api/applications/${dupId}/mark-submitted`, {});
    assert.equal(r.status, 409); assert.match(r.body.error, /duplicate/i); assert.equal(r.body.duplicates[0].job_id, t.jobId);
    assert.equal((await t.call('POST', `/api/applications/${dupId}/mark-submitted`, { allow_duplicate: true })).status, 200);
  } finally { await t.close(); }
});

test('list filters, sorting and CSV export (with formula-injection protection)', async () => {
  const t = await startWithJob({ approve: true });
  try {
    await t.call('PUT', `/api/applications/${t.jobId}`, { notes: '=HYPERLINK("http://evil","x"), "quoted"', status: 'shortlisted' });
    assert.equal((await t.call('GET', '/api/applications?status=shortlisted')).body.length, 1);
    assert.equal((await t.call('GET', '/api/applications?status=offer')).body.length, 0);
    assert.equal((await t.call('GET', '/api/applications?q=Riyadh')).body.length, 1);
    assert.equal((await t.call('GET', '/api/applications?employer=nobody')).body.length, 0);
    const row = (await t.call('GET', '/api/applications')).body[0];
    for (const k of ['title', 'employer', 'location', 'url', 'match_score', 'cv_version', 'letter_version', 'discovered_at', 'applied_at', 'status', 'notes', 'follow_up_date', 'interview_dates', 'recruiter', 'confirmation']) assert.ok(k in row, k);
    assert.equal(row.cv_version, 'v1');
    assert.equal((await t.call('GET', '/api/applications?sort=employer&dir=asc')).status, 200);
    const csv = await t.call('GET', '/api/applications/export.csv');
    const text = csv.body.toString('utf8');
    assert.ok(text.startsWith('﻿Job title,Employer,Location'));
    assert.ok(text.includes(`"'=HYPERLINK(""http://evil"",""x""), ""quoted"""`), 'formula neutralised and quotes escaped');
    assert.match(csv.headers.get('content-type'), /text\/csv/);
  } finally { await t.close(); }
});

test('Mode A checklist derives requirements from the posting and saved answers', async () => {
  const t = await startWithJob({ approve: true });
  try {
    const cl = (await t.call('GET', `/api/applications/${t.jobId}/checklist`)).body;
    const by = Object.fromEntries(cl.map((i) => [i.key, i]));
    assert.equal(by.cv.done, true); assert.equal(by.contact.done, true);
    assert.ok(by.visa, 'visa mentioned in posting'); assert.match(by.visa.hint, /No saved answer/);
    assert.ok(by.years && /5\+/.test(by.years.label));
    assert.ok(by.submit && by.review);
    await t.call('PUT', `/api/applications/${t.jobId}`, { checklist: { listing: true } });
    assert.equal((await t.call('GET', `/api/applications/${t.jobId}/checklist`)).body.find((i) => i.key === 'listing').done, true);
  } finally { await t.close(); }
});

test('listing check detects expired pages, never blindly trusting open ones', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/gone') { res.statusCode = 404; return res.end('nope'); }
    if (req.url === '/filled') return res.end('<h1>Designer</h1><p>This position has been filled.</p>');
    res.end('<h1>Designer</h1><p>Apply now</p>');
  }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const fakePublic = async () => [{ address: '93.184.216.34' }]; // bypass guard so the local fixture is reachable
  try {
    assert.equal((await checkListing(`${base}/gone`, fakePublic)).state, 'expired');
    assert.equal((await checkListing(`${base}/filled`, fakePublic)).state, 'likely_expired');
    assert.equal((await checkListing(`${base}/live`, fakePublic)).state, 'appears_open');
    assert.equal((await checkListing(`${base}/live`)).state, 'unknown', 'private address refused by default');
  } finally { srv.close(); }
});

test('sorting orders rows and puts empty values last', async () => {
  const t = await startWithJob();
  try {
    const { upsertJobs } = require('../src/services/jobsStore');
    const { buildJob } = require('../src/normalize');
    await upsertJobs(t.db, [buildJob({ source: 's', externalId: '1', title: 'Web Designer', company: 'Aardvark Co', locationText: 'Jeddah, Saudi Arabia', description: 'Web designer role in Jeddah' })]);
    const id2 = (await t.db.prepare("SELECT id FROM jobs WHERE source = 's'").get()).id;
    await t.call('PUT', `/api/applications/${id2}`, { status: 'saved', follow_up_date: '2026-12-01' });
    const asc = (await t.call('GET', '/api/applications?sort=employer&dir=asc')).body.map((r) => r.employer);
    assert.deepEqual(asc, ['Aardvark Co', 'Riyadh Creative Co']);
    const fu = (await t.call('GET', '/api/applications?sort=follow_up_date&dir=asc')).body;
    assert.equal(fu[0].job_id, id2); assert.equal(fu[1].follow_up_date, null, 'empty values last');
  } finally { await t.close(); }
});
