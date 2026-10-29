// Mode C: approved automatic submission.
//
// Nothing here talks to a real employer site by itself. A submission is only possible through a registered
// adapter for a source/workflow whose operator explicitly permits automated applications. The registry
// ships EMPTY: for every other site the caller gets a manual-application checklist instead.
//
// Safety properties enforced here (not left to adapters):
//  - listing must be verified open, and match the saved job (title + employer)
//  - the CV/cover letter must be APPROVED versions belonging to this exact job
//  - required fields are filled only from the profile or saved answers (sensitive ones are never guessed)
//  - attachment format/size is validated against the adapter's limits
//  - explicit approval (a one-time token bound to the exact content) unless the user pre-approved that adapter
//  - CAPTCHA / MFA / login walls hand control back to the user; they are never bypassed
//  - "applied" is only recorded when the site's response confirms it
const crypto = require('crypto');
const applications = require('./applications');
const versions = require('./versions');
const files = require('./files');
const profileSvc = require('./profile');
const { checklistFor } = applications;

const adapters = new Map();
const tokens = new Map();
const TOKEN_TTL_MS = 15 * 60 * 1000;
const httpError = (status, message) => Object.assign(new Error(message), { status });

function registerAdapter(a) {
  for (const k of ['id', 'label', 'matches', 'verifyListing', 'fields', 'submit']) if (!a[k]) throw new Error(`adapter missing ${k}`);
  if (a.permitted !== true || !a.permissionSource) throw new Error('adapter must declare permitted: true and a permissionSource (link/terms showing automation is allowed)');
  if (!Array.isArray(a.acceptedFormats) || !a.acceptedFormats.length) throw new Error('adapter must declare acceptedFormats');
  adapters.set(a.id, a);
}
const clearAdapters = () => adapters.clear();
const listAdapters = () => [...adapters.values()].map((a) => ({ id: a.id, label: a.label, permissionSource: a.permissionSource, acceptedFormats: a.acceptedFormats }));
const findAdapter = (url) => [...adapters.values()].find((a) => { try { return a.matches(url); } catch { return false; } });

const getPre = async (db) => (await require('./settings').get(db, 'auto_submit_preapproved')) || [];
async function setPreapproved(db, ids) {
  const valid = ids.filter((id) => adapters.has(id));
  await require('./settings').set(db, 'auto_submit_preapproved', valid);
  return valid;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, ' ').trim();
const words = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 2));
function similar(a, b) {
  const A = words(a); const B = words(b);
  if (!A.size || !B.size) return false;
  let hit = 0; A.forEach((w) => B.has(w) && hit++);
  return hit / Math.min(A.size, B.size) >= 0.75;
}

async function manualResult(db, job, profile, reason) {
  const app = await applications.get(db, job.id);
  return { permitted: false, ready: false, reason, handBack: true,
    message: `${reason} Control is returned to you. Apply manually using the checklist below.`,
    checklist: await checklistFor(db, job, profile, app) };
}

// Runs every pre-submission check. Pure with respect to the employer site except for adapter.verifyListing.
async function prepare(db, jobId, { format, retry = false, issueToken = true } = {}) {
  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) throw httpError(404, 'Job not found');
  const profile = await profileSvc.getProfile(db);
  const adapter = job.url && findAdapter(job.url);
  if (!adapter) {
    return await manualResult(db, job, profile, job.url
      ? 'Automatic submission is not available for this site: no adapter exists for a workflow where the site explicitly permits automation.'
      : 'This job has no application URL.');
  }

  await applications.ensure(db, jobId);
  const app = await applications.get(db, jobId);
  const checks = [];
  const check = (id, label, ok, detail = '') => checks.push({ id, label, ok: !!ok, detail });

  const dups = await applications.duplicates(db, job);
  check('duplicate', 'Not a duplicate of a job already applied to', !dups.length || app.allow_duplicate, dups[0]?.reason || '');

  const lastAttempt = [...app.submission_log].reverse().find((e) => /^submission_/.test(e.event || ''));
  check('previous_attempt', 'No earlier attempt with an unknown outcome', !(lastAttempt && lastAttempt.event !== 'submission_confirmed') || retry,
    lastAttempt && lastAttempt.event !== 'submission_confirmed' ? 'A previous attempt was not confirmed by the site. Check the site/your email first, then retry deliberately.' : '');

  let listing;
  try { listing = await adapter.verifyListing(job); } catch (e) { listing = { open: false, error: e.message }; }
  if (listing.blocked) {
    return { ...(await manualResult(db, job, profile, `The site requires ${listing.blocked} which this tool will not bypass.`)), adapter: adapter.id };
  }
  check('listing_open', 'Listing is still open', listing.open === true, listing.error || (listing.open === false ? 'The listing appears closed or expired.' : ''));
  const matches = listing.open === true && similar(listing.title, job.title) && (!job.company || similar(listing.company, job.company));
  check('details_match', 'Employer and job title match the selected listing', matches,
    listing.open ? `Saved: "${job.title}" at "${job.company || '?'}". Site: "${listing.title || '?'}" at "${listing.company || '?'}".` : '');

  const cv = app.cv_version_id ? await versions.getCv(db, app.cv_version_id) : null;
  check('cv_approved', 'CV is an approved version made for this job', cv && cv.status === 'approved' && cv.job_id === job.id,
    cv ? '' : 'No CV version is linked to this application.');
  const letter = app.letter_version_id ? await versions.getLetter(db, app.letter_version_id) : null;
  check('letter_ok', letter ? 'Cover letter is an approved version made for this job' : 'Cover letter (none attached)',
    letter ? letter.status === 'approved' && letter.job_id === job.id : !adapter.requiresCoverLetter,
    !letter && adapter.requiresCoverLetter ? 'This workflow requires a cover letter.' : '');

  const chosen = format || adapter.acceptedFormats[0];
  let attachments = [];
  let attachOk = adapter.acceptedFormats.includes(chosen); let attachDetail = attachOk ? '' : `Accepted formats: ${adapter.acceptedFormats.join(', ')}.`;
  if (attachOk && cv) {
    try {
      const cvf = await files.cvFile(db, cv.id, chosen);
      attachments.push({ kind: 'cv', ...cvf });
      if (letter) attachments.push({ kind: 'cover_letter', ...(await files.letterFile(db, letter.id, chosen, profile)) });
      const max = (adapter.maxFileMb || 5) * 1024 * 1024;
      const sig = chosen === 'pdf' ? '%PDF' : 'PK';
      for (const a of attachments) {
        if (a.buffer.length > max) { attachOk = false; attachDetail = `${a.kind} exceeds ${adapter.maxFileMb || 5} MB.`; }
        if (a.buffer.subarray(0, sig.length).toString() !== sig) { attachOk = false; attachDetail = `${a.kind} is not a valid ${chosen}.`; }
      }
    } catch (e) { attachOk = false; attachDetail = e.message; }
  }
  check('attachments', `Attachments are valid ${chosen.toUpperCase()} files within size limits`, attachOk && (!!cv), attachDetail);

  const fields = adapter.fields({ job, profile, answer: (key) => profile.answers?.[key] || null });
  const missing = fields.filter((f) => f.required && !String(f.value ?? '').trim());
  check('required_fields', 'All required fields have values from your profile or saved answers', !missing.length,
    missing.length ? `Needs your input (never guessed): ${missing.map((m) => m.label).join(', ')}.` : '');

  const ready = checks.every((c) => c.ok);
  const summary = { adapter: adapter.label, job: { title: job.title, company: job.company, url: job.url },
    cv_version: cv && `v${cv.version_no}`, letter_version: letter && `v${letter.version_no}`, format: chosen,
    fields: fields.map((f) => ({ label: f.label, value: f.sensitive ? `${f.value ?? ''}` : f.value, sensitive: !!f.sensitive })),
    attachments: attachments.map((a) => ({ kind: a.kind, filename: a.filename, bytes: a.buffer.length })) };

  const hash = crypto.createHash('sha256').update(JSON.stringify({ jobId, cv: cv && [cv.id, cv.approved_at], letter: letter && [letter.id, letter.approved_at],
    chosen, fields: fields.map((f) => [f.key, f.value]), url: job.url })).digest('hex');
  const preapproved = (await getPre(db)).includes(adapter.id);
  let approvalToken = null;
  for (const [k, t] of tokens) if (t.exp < Date.now()) tokens.delete(k);
  if (ready && !preapproved && issueToken) {
    approvalToken = crypto.randomBytes(16).toString('hex');
    tokens.set(approvalToken, { jobId, hash, exp: Date.now() + TOKEN_TTL_MS });
  }
  return { permitted: true, adapter: adapter.id, ready, checks, summary, preapproved, approvalToken, _hash: hash, _ctx: { adapter, job, profile, fields, attachments, cv, letter } };
}

const publicView = ({ _hash, _ctx, ...rest }) => rest;
const prepareForClient = async (db, jobId, opts) => publicView(await prepare(db, jobId, opts));

// Submits only after a fresh re-verification and valid approval. Returns what the SITE confirmed, nothing more.
async function submit(db, jobId, { approvalToken, format, retry = false } = {}) {
  const p = await prepare(db, jobId, { format, retry, issueToken: false });
  if (!p.permitted) return publicView(p);
  if (!p.ready) return { ...publicView(p), submitted: false, message: 'Not submitted: one or more checks failed.' };

  if (!p.preapproved) {
    const t = approvalToken && tokens.get(approvalToken);
    tokens.delete(approvalToken);
    if (!t || t.exp < Date.now() || t.jobId !== jobId) throw httpError(403, 'Explicit approval required: review the summary and confirm. The approval is missing, expired, or already used.');
    if (t.hash !== p._hash) throw httpError(409, 'The application content changed since you approved it. Review the new summary and approve again.');
  }

  const { adapter, job, profile, fields, attachments } = p._ctx;
  let result;
  try {
    result = await adapter.submit({ job, profile, fields, attachments });
  } catch (e) {
    await applications.addLog(db, jobId, { event: 'submission_failed', method: adapter.id, error: e.message });
    return { submitted: false, confirmed: false, status: 'unknown', message: `The submission call failed (${e.message}). The site may or may not have received it, so it is NOT recorded as applied. Check the site/your email before retrying.` };
  }

  if (result && result.confirmed === true && (result.confirmationNumber || result.message)) {
    await applications.update(db, jobId, { status: 'applied', confirmation: result.confirmationNumber || result.message });
    await db.prepare("UPDATE applications SET submission_source = 'site_confirmed' WHERE job_id = ?").run(jobId);
    await applications.addLog(db, jobId, { event: 'submission_confirmed', method: adapter.id, confirmation: result.confirmationNumber || null, message: result.message || '' });
    return { submitted: true, confirmed: true, status: 'applied', confirmation: result.confirmationNumber || null, message: result.message || 'Confirmed by the site.' };
  }
  await applications.addLog(db, jobId, { event: 'submission_unconfirmed', method: adapter.id, message: result?.message || '' });
  const app = await applications.get(db, jobId);
  if (applications.STATUS_KEYS.indexOf(app.status) < applications.STATUS_KEYS.indexOf('ready_to_apply')) await applications.update(db, jobId, { status: 'ready_to_apply' });
  return { submitted: true, confirmed: false, status: 'unconfirmed', message: 'The request was sent but the site did not confirm receipt, so it is NOT recorded as applied. Verify on the site or in your email, then mark it submitted yourself if it went through.' };
}

module.exports = { registerAdapter, clearAdapters, listAdapters, findAdapter, setPreapproved, getPreapproved: getPre, prepare: prepareForClient, submit, similar };
