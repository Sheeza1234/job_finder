// Mode B: browser-assisted application.
//
// Opens the application page in a real (visible) Chrome window, fills ORDINARY fields from the saved profile,
// uploads the approved CV/cover letter, and STOPS. There is no code path that clicks a submit button: the user
// reviews everything in the window and submits themselves. Logins, CAPTCHAs and MFA are left to the user.
// Sensitive questions (salary, notice period, work authorization, visa, relocation, start date) are filled only
// from saved answers; otherwise they are reported as "needs your input".
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const policy = require('./automationPolicy');
const files = require('./files');
const versions = require('./versions');
const applications = require('./applications');

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ---- field classification (pure)
const SENSITIVE = [
  ['salary', /salary|compensation|\bctc\b|expected pay|pay expectation|remuneration|الراتب/, 'salaryExpectation'],
  ['notice', /notice period|notice\b|فترة الإشعار/, 'noticePeriod'],
  ['start_date', /start date|available (from|to start)|availability|earliest/, 'expectedStartDate'],
  ['visa', /\bvisa\b|sponsor/, 'visaStatus'],
  ['authorization', /work(ing)? (permit|authori[sz]ation)|authori[sz]ed to work|right to work|eligible to work|iqama|transferable|إقامة/, 'workAuthorization'],
  ['relocation', /relocat/, 'relocation'],
];
const IDENTITY = [
  ['email', /e-?mail/], ['phone', /phone|mobile|\btel\b|whatsapp|contact number/],
  ['first_name', /first.?name|given.?name|forename/], ['last_name', /last.?name|family.?name|surname/],
  ['full_name', /full.?name|your name|candidate name|^\s*name\b/],
  ['linkedin', /linkedin/], ['portfolio', /portfolio|behance|dribbble/], ['website', /website|personal (site|url)|\burl\b|web ?site/],
  ['current_title', /current (job )?title|job title|current position|present position/], ['current_company', /current (company|employer)|present employer/],
  ['years_experience', /years of (relevant )?experience|total experience|experience \(years\)/],
  ['location', /\bcity\b|location|where are you based|current location/],
];

function classifyField(f) {
  const text = `${f.label || ''} ${f.name || ''} ${f.id || ''} ${f.placeholder || ''} ${f.autocomplete || ''}`.toLowerCase();
  if (f.type === 'file') {
    if (/cover|letter|motivation/.test(text)) return { kind: 'file_letter' };
    if (/resume|cv|curriculum/.test(text)) return { kind: 'file_cv' };
    return { kind: 'file_other' };
  }
  if (f.type === 'checkbox' || f.type === 'radio') return { kind: 'choice' }; // consents / legal / demographic: never auto-ticked
  if (f.tag === 'textarea' && /cover letter|motivation|letter of interest/.test(text)) return { kind: 'letter_text' };
  for (const [kind, re, key] of SENSITIVE) if (re.test(text)) return { kind, sensitive: true, answerKey: key };
  if (f.type === 'email') return { kind: 'email' };
  if (f.type === 'tel') return { kind: 'phone' };
  if (/company|employer|organi[sz]ation|school|university|reference|referee|manager|supervisor|project|business/.test(text) && !/current (company|employer)|present employer/.test(text)) return { kind: 'unknown' };
  for (const [kind, re] of IDENTITY) if (re.test(text)) return { kind };
  return { kind: 'unknown' };
}

function identityValue(kind, p) {
  const parts = (p.fullName || '').split(/\s+/).filter(Boolean);
  const current = p.experience.find((e) => e.current) || p.experience[0];
  return ({
    email: p.email, phone: p.phone, full_name: p.fullName, first_name: parts[0], last_name: parts.slice(1).join(' '),
    linkedin: p.linkedinUrl, portfolio: p.portfolioUrl || p.websiteUrl, website: p.websiteUrl || p.portfolioUrl,
    current_title: current?.title, current_company: current?.company,
    years_experience: p.yearsExperience != null ? String(p.yearsExperience) : '', location: p.location,
  })[kind] || '';
}

// Decide what to do with each scanned field. Returns [{field, action, value, source, reason}].
function planFill(profile, fields, { letterText } = {}) {
  return fields.map((f) => {
    const c = classifyField(f);
    const base = { field: f, kind: c.kind, sensitive: !!c.sensitive };
    if (c.kind.startsWith('file_')) return { ...base, action: c.kind === 'file_other' ? 'needs_input' : 'upload', reason: c.kind === 'file_other' ? 'Unrecognised attachment slot; add it yourself.' : '' };
    if (c.kind === 'choice') return { ...base, action: 'needs_input', reason: 'Checkboxes/radio buttons (consents, declarations, demographics) are always left for you.' };
    if (c.kind === 'letter_text') return letterText ? { ...base, action: 'fill', value: letterText, source: 'approved cover letter' } : { ...base, action: 'needs_input', reason: 'No approved cover letter to paste.' };
    if (c.sensitive) {
      const saved = profile.answers?.[c.answerKey];
      if (!saved) return { ...base, action: 'needs_input', reason: `Sensitive question. No saved answer for ${c.answerKey}; I won't guess. Answer it yourself or save an answer in your profile.` };
      if (f.tag === 'select') {
        const opt = (f.options || []).find((o) => o.text.toLowerCase().includes(saved.toLowerCase()) || saved.toLowerCase().includes(o.text.toLowerCase()) && o.text.length > 1);
        return opt ? { ...base, action: 'fill', value: opt.value, display: opt.text, source: 'saved answer' } : { ...base, action: 'needs_input', reason: `Your saved answer ("${saved}") doesn't clearly match an option; choose yourself.` };
      }
      return { ...base, action: 'fill', value: saved, source: 'saved answer' };
    }
    if (c.kind === 'unknown') return { ...base, action: 'needs_input', reason: f.required ? 'Required question I can\'t answer from your profile.' : 'Not a standard profile field; left blank.' };
    const val = identityValue(c.kind, profile);
    if (!val) return { ...base, action: 'needs_input', reason: `Your profile has no ${c.kind.replace('_', ' ')}.` };
    if (f.tag === 'select') {
      const opt = (f.options || []).find((o) => o.text.toLowerCase() === val.toLowerCase());
      return opt ? { ...base, action: 'fill', value: opt.value, display: opt.text, source: 'profile' } : { ...base, action: 'needs_input', reason: 'No exact option for your value; choose yourself.' };
    }
    return { ...base, action: 'fill', value: val, source: 'profile' };
  });
}

// ---- browser session
const sessions = new Map();

const SCAN = () => {
  const labelOf = (el) => {
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return l.innerText; }
    const wrap = el.closest('label'); if (wrap) return wrap.innerText;
    const aria = el.getAttribute('aria-label'); if (aria) return aria;
    const by = el.getAttribute('aria-labelledby');
    if (by) return by.split(' ').map((i) => (document.getElementById(i) || {}).innerText || '').join(' ');
    const p = el.parentElement; const t = p && p.querySelector('label,legend'); return t ? t.innerText : '';
  };
  const out = []; let i = 0;
  document.querySelectorAll('input,textarea,select').forEach((el) => {
    const type = (el.getAttribute('type') || (el.tagName === 'INPUT' ? 'text' : '')).toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset', 'password'].includes(type) || el.disabled) return;
    if (type !== 'file' && el.offsetParent === null) return;
    el.setAttribute('data-jfa', String(i));
    out.push({ idx: i++, tag: el.tagName.toLowerCase(), type, name: el.name || '', id: el.id || '', placeholder: el.placeholder || '', autocomplete: el.autocomplete || '',
      label: (labelOf(el) || '').trim().replace(/\s+/g, ' ').slice(0, 200), required: el.required || el.getAttribute('aria-required') === 'true', value: type === 'file' ? '' : el.value || '',
      options: el.tagName === 'SELECT' ? [...el.options].map((o) => ({ value: o.value, text: o.text.trim() })) : undefined });
  });
  const html = document.documentElement.innerHTML.toLowerCase();
  const blockers = [];
  if (document.querySelector('input[type=password]')) blockers.push('login');
  if (document.querySelector('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare"],.g-recaptcha,.h-captcha,[data-sitekey]')) blockers.push('captcha');
  if (/one-time (code|password)|verification code|two-factor|2fa|authenticator/.test(html) && !out.length) blockers.push('mfa');
  return { fields: out, blockers };
};

const SET_VALUE = (idx, value) => {
  const el = document.querySelector(`[data-jfa="${idx}"]`); if (!el) return false;
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
};

const READ_ALL = () => [...document.querySelectorAll('[data-jfa]')].map((el) => ({
  idx: Number(el.getAttribute('data-jfa')), type: (el.getAttribute('type') || '').toLowerCase(), tag: el.tagName.toLowerCase(),
  value: el.type === 'file' ? [...(el.files || [])].map((f) => f.name).join(', ') : el.type === 'checkbox' || el.type === 'radio' ? (el.checked ? 'checked' : '') : el.tagName === 'SELECT' ? (el.options[el.selectedIndex] || {}).text || '' : el.value,
}));

async function launch() {
  if (!config.chromePath) throw httpError(501, 'No Chrome/Chromium found. Set CHROME_PATH, or use Manual assistance (Mode A).');
  const puppeteer = require('puppeteer-core');
  return puppeteer.launch({ executablePath: config.chromePath, headless: config.assistHeadless, defaultViewport: null, args: config.chromeArgs });
}

async function fillPage(session, profile, letterText) {
  const { page } = session;
  const { fields, blockers } = await page.evaluate(SCAN);
  const report = { blockers, filled: [], needs_input: [], uploaded: [], skipped: [] };
  if (blockers.includes('login')) {
    report.message = 'This page needs you to log in. Log in yourself in the browser window, then press Re-scan & fill.';
    return report;
  }
  const plan = planFill(profile, fields, { letterText });
  for (const step of plan) {
    const f = step.field; const label = f.label || f.name || f.id || f.placeholder || `field ${f.idx}`;
    if (step.action === 'needs_input') { report.needs_input.push({ label, required: f.required, reason: step.reason, sensitive: step.sensitive }); continue; }
    if (step.action === 'upload') {
      const file = step.kind === 'file_cv' ? session.files.cv : session.files.letter;
      if (!file) { report.needs_input.push({ label, required: f.required, reason: step.kind === 'file_cv' ? 'No approved CV file.' : 'No approved cover letter to upload.' }); continue; }
      const handle = await page.$(`[data-jfa="${f.idx}"]`);
      await handle.uploadFile(file.path);
      report.uploaded.push({ label, file: file.name }); continue;
    }
    if (f.value && f.value.trim()) { report.skipped.push({ label, reason: 'Already has a value; left as is.' }); continue; }
    await page.evaluate(SET_VALUE, f.idx, step.value);
    report.filled.push({ label, value: step.display || step.value.slice(0, 120), source: step.source, sensitive: step.sensitive });
  }
  return report;
}

async function start(db, jobId, { format = 'pdf' } = {}) {
  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) throw httpError(404, 'Job not found');
  const pol = policy.assistPolicy(job.url);
  if (!pol.allowed) return { started: false, ...pol, checklist: await applications.checklistFor(db, job, await require('./profile').getProfile(db), await applications.get(db, jobId)) };
  await applications.ensure(db, jobId);
  const app = await applications.get(db, jobId);
  await applications.requireNoDuplicate(db, job, app.allow_duplicate);
  const cv = app.cv_version_id ? await versions.getCv(db, app.cv_version_id) : null;
  if (!cv || cv.status !== 'approved' || cv.job_id !== jobId) throw httpError(409, 'Link and approve a CV version for this job before using browser assistance.');
  const letter = app.letter_version_id ? await versions.getLetter(db, app.letter_version_id) : null;
  if (letter && (letter.status !== 'approved' || letter.job_id !== jobId)) throw httpError(409, 'The linked cover letter is not approved.');

  await policy.assertPublicHost(job.url); // after the cheap local checks, before any browser is launched
  for (const [id, s] of sessions) if (s.jobId === jobId) await close(id);
  const profile = await require('./profile').getProfile(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-assist-'));
  const filesOut = {};
  const cvf = await files.cvFile(db, cv.id, format);
  filesOut.cv = { name: cvf.filename, path: path.join(dir, cvf.filename) }; fs.writeFileSync(filesOut.cv.path, cvf.buffer);
  if (letter) {
    const lf = await files.letterFile(db, letter.id, format, profile);
    filesOut.letter = { name: lf.filename, path: path.join(dir, lf.filename) }; fs.writeFileSync(filesOut.letter.path, lf.buffer);
  }

  const browser = await launch();
  const sid = crypto.randomBytes(8).toString('hex');
  try {
    const page = await browser.newPage();
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const session = { id: sid, jobId, browser, page, files: filesOut, dir, letterText: letter?.text, profile };
    sessions.set(sid, session);
    browser.on('disconnected', () => { sessions.delete(sid); fs.rmSync(dir, { recursive: true, force: true }); });
    const report = await fillPage(session, profile, letter?.text);
    await applications.addLog(db, jobId, { event: 'assist_started', mode: 'B', filled: report.filled.length, needs_input: report.needs_input.length });
    return { started: true, sessionId: sid, report, notice: 'Nothing has been submitted. Review the browser window, complete the highlighted items yourself, and submit there. Then come back and mark it as submitted.' };
  } catch (e) {
    await browser.close().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true });
    throw httpError(e.status || 502, `Could not open the application page: ${e.message}`);
  }
}

const need = (sid) => sessions.get(sid) || (() => { throw httpError(404, 'Assist session not found or the browser window was closed.'); })();

async function rescan(db, sid) {
  const s = need(sid);
  s.profile = await require('./profile').getProfile(db);
  return { report: await fillPage(s, s.profile, s.letterText) };
}

// What would be submitted right now: live values read back from the form (including anything you typed).
async function summary(sid) {
  const s = need(sid);
  const { fields } = await s.page.evaluate(SCAN); // refreshes tags for new fields without changing values
  const vals = await s.page.evaluate(READ_ALL);
  const byIdx = new Map(vals.map((v) => [v.idx, v.value]));
  return {
    url: s.page.url(),
    fields: fields.map((f) => ({ label: f.label || f.name || f.id || f.placeholder, value: byIdx.get(f.idx) || '', required: f.required, sensitive: !!classifyField(f).sensitive, empty: !byIdx.get(f.idx) })),
    note: 'Values are read live from the page. The tool never presses submit; you do.',
  };
}

async function close(sid) {
  const s = sessions.get(sid); if (!s) return;
  sessions.delete(sid);
  await s.browser.close().catch(() => {});
  fs.rmSync(s.dir, { recursive: true, force: true });
}
const closeAll = () => Promise.all([...sessions.keys()].map(close));
process.on('exit', () => { for (const s of sessions.values()) try { s.browser.process()?.kill(); } catch { /* already gone */ } });

module.exports = { classifyField, planFill, start, rescan, summary, close, closeAll };
