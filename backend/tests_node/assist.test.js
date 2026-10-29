const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const config = require('../src/config');
const policy = require('../src/services/automationPolicy');
const assist = require('../src/services/browserAssist');
const { normalize } = require('../src/services/profile');
const { startWithJob, SAMPLE_PROFILE } = require('./helpers');

const field = (o) => ({ tag: 'input', type: 'text', name: '', id: '', placeholder: '', autocomplete: '', label: '', required: false, ...o });
const profile = normalize({ ...SAMPLE_PROFILE, phone: '+966500000000', email: 't@example.com', answers: { noticePeriod: '30 days' } });

test('policy: sites that restrict automation are handed back to the user; private hosts are refused', async () => {
  for (const u of ['https://www.linkedin.com/jobs/view/1', 'https://sa.indeed.com/viewjob?jk=1', 'https://www.bayt.com/en/job/1', 'https://jobs.glassdoor.com/x']) {
    const p = policy.assistPolicy(u);
    assert.equal(p.allowed, false, u); assert.equal(p.fallback, 'manual'); assert.match(p.message, /Manual assistance/);
  }
  assert.equal(policy.assistPolicy('https://careers.acme.com/apply/1').allowed, true);
  assert.equal(policy.assistPolicy('ftp://x.com').allowed, false);
  assert.equal(policy.assistPolicy('').allowed, false);
  await assert.rejects(policy.assertPublicHost('http://internal.test/x', async () => [{ address: '10.0.0.5' }]), /private/);
  await policy.assertPublicHost('https://careers.acme.com', async () => [{ address: '93.184.216.34' }]);
});

test('classifier: ordinary fields map to profile facts, sensitive ones to saved answers only', async () => {
  const k = (o) => assist.classifyField(field(o));
  assert.equal(k({ type: 'email' }).kind, 'email');
  assert.equal(k({ label: 'Mobile number' }).kind, 'phone');
  assert.equal(k({ label: 'Full name *' }).kind, 'full_name');
  assert.equal(k({ label: 'Company name' }).kind, 'unknown', 'never put your name in a company field');
  assert.equal(k({ label: 'LinkedIn profile' }).kind, 'linkedin');
  assert.equal(k({ label: 'Expected salary (SAR)' }).sensitive, true);
  assert.equal(k({ label: 'Do you require visa sponsorship?' }).kind, 'visa');
  assert.equal(k({ label: 'Notice period' }).answerKey, 'noticePeriod');
  assert.equal(k({ label: 'Are you authorized to work in Saudi Arabia?' }).kind, 'authorization');
  assert.equal(k({ type: 'file', label: 'Upload your resume' }).kind, 'file_cv');
  assert.equal(k({ type: 'file', label: 'Cover letter' }).kind, 'file_letter');
  assert.equal(k({ type: 'checkbox', label: 'I agree to the terms' }).kind, 'choice');
  assert.equal(k({ label: 'Why do you want this job?' }).kind, 'unknown');
});

test('planFill: never guesses; missing saved answers become "needs input"', async () => {
  const plan = assist.planFill(profile, [
    field({ idx: 0, type: 'email', label: 'Email' }), field({ idx: 1, label: 'Expected salary' }), field({ idx: 2, label: 'Notice period' }),
    field({ idx: 3, type: 'checkbox', label: 'I consent' }), field({ idx: 4, label: 'Why us?', required: true }),
    field({ idx: 5, tag: 'select', label: 'Notice period', options: [{ value: '', text: 'Select' }, { value: 'a', text: '30 days' }, { value: 'b', text: 'Immediate' }] }),
  ]);
  const by = (i) => plan[i];
  assert.deepEqual([by(0).action, by(0).value], ['fill', 't@example.com']);
  assert.equal(by(1).action, 'needs_input'); assert.match(by(1).reason, /won't guess/);
  assert.deepEqual([by(2).action, by(2).value, by(2).source], ['fill', '30 days', 'saved answer']);
  assert.equal(by(3).action, 'needs_input'); assert.equal(by(4).action, 'needs_input');
  assert.deepEqual([by(5).action, by(5).value], ['fill', 'a']);
});

// ---- live browser test against a local form (skipped when Chrome isn't installed)
const FORM = `<!doctype html><title>Apply</title><form id="f" action="/submit" method="post">
  <label for="n">Full name *</label><input id="n" name="n" required>
  <label for="e">Email</label><input id="e" name="e" type="email">
  <label for="p">Phone</label><input id="p" name="p" type="tel">
  <label for="np">Notice period</label><input id="np" name="np">
  <label for="sal">Expected salary</label><input id="sal" name="sal">
  <label for="co">Current company name</label><input id="co" name="co">
  <label for="pre">City</label><input id="pre" name="pre" value="Already typed">
  <label for="cv">Upload your CV</label><input id="cv" type="file" name="cv">
  <label for="cl">Cover letter</label><input id="cl" type="file" name="cl">
  <label><input type="checkbox" name="agree"> I agree to the privacy policy</label>
  <button type="submit">Submit application</button></form>`;
const LOGIN = '<!doctype html><title>Login</title><form><label>Email<input name="u"></label><input type="password" name="pw"></form>';

test('Mode B: fills ordinary fields, uploads approved files, leaves sensitive/unknown fields, never submits', { skip: !config.chromePath && 'Chrome not installed' }, async () => {
  let submitHits = 0;
  const srv = http.createServer((req, res) => {
    if (req.url === '/submit') { submitHits++; return res.end('submitted'); }
    res.setHeader('Content-Type', 'text/html'); res.end(req.url === '/login' ? LOGIN : FORM);
  }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  Object.assign(process.env, { ASSIST_ALLOW_PRIVATE: 'true' });
  const saved = [config.assistHeadless, config.chromeArgs]; config.assistHeadless = true; config.chromeArgs = ['--no-sandbox'];
  const t = await startWithJob({ approve: true });
  try {
    const ai = require('../src/services/ai');
    ai.setClient(t.fakeAi('Dear Hiring Manager, I enjoy branding work. Regards, Test Candidate'));
    const letter = (await t.call('POST', `/api/jobs/${t.jobId}/cover-letter`, {})).body;
    await t.call('POST', `/api/letters/${letter.id}/approve`, {});
    (await t.db.prepare('UPDATE jobs SET url = ? WHERE id = ?').run(`${base}/apply`, t.jobId));

    const r = (await t.call('POST', `/api/applications/${t.jobId}/assist/start`, {})).body;
    assert.equal(r.started, true, JSON.stringify(r).slice(0, 500));
    const f = Object.fromEntries(r.report.filled.map((x) => [x.label, x]));
    assert.ok(f['Full name *'] && f['Email'] && f['Phone'], 'ordinary fields filled');
    assert.equal(f['Notice period'].value, '30 days'); assert.equal(f['Notice period'].source, 'saved answer');
    assert.deepEqual(r.report.uploaded.map((u) => u.label).sort(), ['Cover letter', 'Upload your CV']);
    const need = r.report.needs_input.map((n) => n.label);
    assert.equal(f['Current company name'].value, 'Acme Studio', 'real current employer from the profile');
    for (const l of ['Expected salary', 'I agree to the privacy policy']) assert.ok(need.some((n) => n.includes(l)), `${l} left for the user`);
    assert.ok(r.report.skipped.some((s) => s.label === 'City'), 'pre-filled value is not overwritten');

    const sum = (await t.call('GET', `/api/assist/${r.sessionId}/summary`)).body;
    const v = Object.fromEntries(sum.fields.map((x) => [x.label, x.value]));
    assert.equal(v['Full name *'], 'Test Candidate'); assert.equal(v['Email'], 't@example.com');
    assert.match(v['Upload your CV'], /^CV_Test_Candidate.*\.pdf$/);
    assert.equal(v['Expected salary'], '');
    assert.equal(submitHits, 0, 'the form was never submitted');
    assert.equal((await t.call('GET', `/api/applications/${t.jobId}`)).body.status, 'cv_ready', 'assist does not mark anything as applied');
    assert.equal((await t.call('DELETE', `/api/assist/${r.sessionId}`)).status, 204);
    assert.equal((await t.call('GET', `/api/assist/${r.sessionId}/summary`)).status, 404);

    (await t.db.prepare('UPDATE jobs SET url = ? WHERE id = ?').run(`${base}/login`, t.jobId));
    const l = (await t.call('POST', `/api/applications/${t.jobId}/assist/start`, {})).body;
    assert.deepEqual(l.report.blockers, ['login']); assert.equal(l.report.filled.length, 0);
    assert.match(l.report.message, /log in yourself/i);
    await t.call('DELETE', `/api/assist/${l.sessionId}`);
  } finally {
    await assist.closeAll(); await t.close(); srv.close(); delete process.env.ASSIST_ALLOW_PRIVATE; [config.assistHeadless, config.chromeArgs] = saved;
  }
});

test('Mode B refuses without an approved CV, and for sites that forbid automation', async () => {
  const t = await startWithJob({ approve: false });
  try {
    (await t.db.prepare('UPDATE jobs SET url = ? WHERE id = ?').run('https://careers.acme.com/apply', t.jobId));
    const r = await t.call('POST', `/api/applications/${t.jobId}/assist/start`, {});
    assert.equal(r.status, 409); assert.match(r.body.error, /approve a CV/i);
    (await t.db.prepare('UPDATE jobs SET url = ? WHERE id = ?').run('https://www.linkedin.com/jobs/view/123', t.jobId));
    const li = (await t.call('POST', `/api/applications/${t.jobId}/assist/start`, {})).body;
    assert.equal(li.started, false); assert.equal(li.fallback, 'manual'); assert.ok(li.checklist.length);
    const modes = (await t.call('GET', `/api/applications/${t.jobId}/modes`)).body;
    assert.equal(modes.assisted.available, false); assert.equal(modes.automatic.available, false); assert.equal(modes.manual.available, true);
  } finally { await t.close(); }
});
