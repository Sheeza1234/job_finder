const { matchJob } = require('./match');

const STATUSES = [
  ['saved', 'Saved'], ['shortlisted', 'Shortlisted'], ['cv_ready', 'CV Ready'], ['awaiting_approval', 'Awaiting My Approval'],
  ['ready_to_apply', 'Ready to Apply'], ['applied', 'Applied'], ['assessment', 'Assessment'], ['interview', 'Interview'],
  ['offer', 'Offer'], ['rejected', 'Rejected'], ['withdrawn', 'Withdrawn'], ['listing_expired', 'Listing Expired'],
];
const STATUS_KEYS = STATUSES.map(([k]) => k);
const LABELS = Object.fromEntries(STATUSES);
const EARLY = ['saved', 'shortlisted', 'cv_ready', 'awaiting_approval'];

const httpError = (status, message) => Object.assign(new Error(message), { status });
const j = (s, f) => { try { return s ? JSON.parse(s) : f; } catch { return f; } };
const nowIso = () => new Date().toISOString();
const str = (v, n = 500) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

function ensure(db, jobId) {
  return db.prepare('INSERT OR IGNORE INTO applications (job_id, updated_at) VALUES (?, ?)').run(jobId, nowIso());
}

async function hydrate(db, r) {
  if (!r) return null;
  const cv = r.cv_version_id ? await db.prepare('SELECT id, version_no, status FROM cv_versions WHERE id = ?').get(r.cv_version_id) : null;
  const letter = r.letter_version_id ? await db.prepare('SELECT id, version_no, status FROM cover_letters WHERE id = ?').get(r.letter_version_id) : null;
  return { ...r, status_label: LABELS[r.status], interview_dates: j(r.interview_dates, []), recruiter: j(r.recruiter, {}),
    submission_log: j(r.submission_log, []), checklist: j(r.checklist, {}), allow_duplicate: !!r.allow_duplicate, cv_version: cv, letter_version: letter };
}
const get = async (db, jobId) => hydrate(db, await db.prepare('SELECT * FROM applications WHERE job_id = ?').get(jobId));

async function addLog(db, jobId, entry) {
  await ensure(db, jobId);
  const cur = j((await db.prepare('SELECT submission_log FROM applications WHERE job_id = ?').get(jobId)).submission_log, []);
  cur.push({ at: nowIso(), ...entry });
  await db.prepare('UPDATE applications SET submission_log = ?, updated_at = ? WHERE job_id = ?').run(JSON.stringify(cur), nowIso(), jobId);
}

// ---- duplicate detection (same job id, same URL, or same employer+title+city from another source)
const { jobFingerprint: fingerprint, urlKey } = require('../normalize');

async function duplicates(db, job) {
  const rows = await db.prepare(`SELECT j.*, a.applied_at FROM jobs j JOIN applications a ON a.job_id = j.id WHERE a.applied_at IS NOT NULL`).all();
  const fp = fingerprint(job); const uk = urlKey(job.url);
  const out = [];
  for (const r of rows) {
    const reason = r.id === job.id ? 'This exact job already has an application recorded as applied.'
      : (uk && urlKey(r.url) === uk) ? 'Another saved job has the same listing URL and was already applied to.'
        : (fp && fingerprint(r) === fp) ? 'The same employer, title and city (from another source) was already applied to.' : null;
    if (reason) out.push({ job_id: r.id, title: r.title, company: r.company, applied_at: r.applied_at, reason });
  }
  return out;
}

async function requireNoDuplicate(db, job, allow) {
  const d = await duplicates(db, job);
  if (d.length && !allow) {
    throw Object.assign(httpError(409, `Possible duplicate application: ${d[0].reason} Set "allow duplicate" to proceed anyway.`), { duplicates: d });
  }
}

// ---- update with guarded transitions
async function update(db, jobId, patch = {}) {
  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) throw httpError(404, 'Job not found');
  await ensure(db, jobId);
  const cur = await get(db, jobId);
  const next = {};

  if (patch.status !== undefined) { if (!STATUS_KEYS.includes(patch.status)) throw httpError(400, `status must be one of ${STATUS_KEYS.join(', ')}`); next.status = patch.status; }
  if (patch.notes !== undefined) next.notes = str(patch.notes, 10000);
  if (patch.confirmation !== undefined) next.confirmation = str(patch.confirmation, 500) || null;
  if (patch.follow_up_date !== undefined) {
    const d = str(patch.follow_up_date, 10);
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw httpError(400, 'follow_up_date must be YYYY-MM-DD');
    next.follow_up_date = d || null;
  }
  if (patch.interview_dates !== undefined) {
    const arr = Array.isArray(patch.interview_dates) ? patch.interview_dates : [];
    next.interview_dates = JSON.stringify(arr.map((x) => str(x, 25)).filter((x) => {
      if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/.test(x)) throw httpError(400, 'interview dates must be YYYY-MM-DD or YYYY-MM-DDTHH:MM');
      return true;
    }));
  }
  if (patch.recruiter !== undefined) {
    const r = patch.recruiter || {};
    next.recruiter = JSON.stringify({ name: str(r.name, 200), email: str(r.email, 200), phone: str(r.phone, 50), notes: str(r.notes, 1000) });
  }
  if (patch.checklist !== undefined) {
    next.checklist = JSON.stringify(Object.fromEntries(Object.entries(patch.checklist || {}).slice(0, 60).map(([k, v]) => [str(k, 60), !!v])));
  }
  if (patch.allow_duplicate !== undefined) next.allow_duplicate = patch.allow_duplicate ? 1 : 0;

  for (const [field, table] of [['cv_version_id', 'cv_versions'], ['letter_version_id', 'cover_letters']]) {
    if (patch[field] === undefined) continue;
    if (patch[field] === null) { next[field] = null; continue; }
    const row = await db.prepare(`SELECT job_id FROM ${table} WHERE id = ?`).get(Number(patch[field]));
    if (!row || row.job_id !== jobId) throw httpError(400, `${field} does not belong to this job`);
    next[field] = Number(patch[field]);
  }

  const target = next.status || cur.status;
  const cvId = next.cv_version_id !== undefined ? next.cv_version_id : cur.cv_version_id;
  const allow = next.allow_duplicate !== undefined ? !!next.allow_duplicate : cur.allow_duplicate;

  if (target === 'ready_to_apply' || (target === 'applied' && next.status === 'applied' && cvId)) {
    let id = cvId;
    if (!id && target === 'ready_to_apply') {
      const a = await db.prepare("SELECT id FROM cv_versions WHERE job_id = ? AND status = 'approved' ORDER BY version_no DESC").get(jobId);
      if (a) { id = a.id; next.cv_version_id = id; }
    }
    const v = id && await db.prepare('SELECT status FROM cv_versions WHERE id = ?').get(id);
    if (!v || v.status !== 'approved') throw httpError(409, 'Approve a CV version for this job first; only approved CVs are used to apply.');
  }
  const letterId = next.letter_version_id !== undefined ? next.letter_version_id : cur.letter_version_id;
  if (letterId && (target === 'ready_to_apply' || target === 'applied')) {
    const l = await db.prepare('SELECT status FROM cover_letters WHERE id = ?').get(letterId);
    if (!l || l.status !== 'approved') throw httpError(409, 'The linked cover letter is not approved yet.');
  }

  if (next.status === 'applied') {
    await requireNoDuplicate(db, job, allow);
    if (!cur.applied_at) {
      next.applied_at = patch.applied_at ? new Date(patch.applied_at).toISOString() : nowIso();
      if (!cur.submission_source) next.submission_source = 'user_declared';
    }
  }

  next.updated_at = nowIso();
  const cols = Object.keys(next);
  await db.prepare(`UPDATE applications SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE job_id = @job_id`).run({ ...next, job_id: jobId });
  if (next.status && next.status !== cur.status) await addLog(db, jobId, { event: 'status', from: cur.status, to: next.status });
  return get(db, jobId);
}

// The user tells us they submitted it themselves; we record that as self-reported, never as site-confirmed.
async function markSubmitted(db, jobId, { confirmation, applied_at, allow_duplicate } = {}) {
  const patch = { status: 'applied' };
  if (confirmation) patch.confirmation = confirmation;
  if (applied_at) patch.applied_at = applied_at;
  if (allow_duplicate) patch.allow_duplicate = true;
  const out = await update(db, jobId, patch);
  await addLog(db, jobId, { event: 'submitted', method: 'manual', note: 'Marked as submitted by you (self-reported, not verified by the site).' });
  return out;
}

// Called when versions change, to move early-stage applications forward without ever skipping approval.
async function syncFromVersions(db, jobId) {
  await ensure(db, jobId);
  const cur = await get(db, jobId);
  if (!EARLY.includes(cur.status)) return;
  const approved = await db.prepare("SELECT id FROM cv_versions WHERE job_id = ? AND status = 'approved' ORDER BY version_no DESC").get(jobId);
  const any = await db.prepare('SELECT id FROM cv_versions WHERE job_id = ?').get(jobId);
  const status = approved ? 'cv_ready' : any ? 'awaiting_approval' : null;
  if (status && status !== cur.status && cur.status !== 'shortlisted') {
    await db.prepare('UPDATE applications SET status = ?, updated_at = ? WHERE job_id = ?').run(status, nowIso(), jobId);
    await addLog(db, jobId, { event: 'status', from: cur.status, to: status, auto: true });
  }
  if (approved && !cur.cv_version_id) await db.prepare('UPDATE applications SET cv_version_id = ? WHERE job_id = ?').run(approved.id, jobId);
}

// ---- listing, sorting, CSV
const SORTS = ['updated_at', 'applied_at', 'discovered_at', 'title', 'employer', 'match_score', 'follow_up_date', 'status'];
async function list(db, profile, f = {}) {
  const where = [await require('./jobsStore').modeClause(db)]; const args = [];
  if (f.status) { where.push('a.status = ?'); args.push(f.status); }
  if (f.city) { where.push('j.city = ?'); args.push(f.city); }
  if (f.employer) { where.push('j.company ILIKE ?'); args.push(`%${f.employer}%`); }
  if (f.q) { where.push('(j.title ILIKE ? OR j.company ILIKE ? OR a.notes ILIKE ? OR a.recruiter::text ILIKE ?)'); args.push(...Array(4).fill(`%${f.q}%`)); }
  if (f.followup_due === 'true') { where.push('a.follow_up_date IS NOT NULL AND a.follow_up_date <= ?'); args.push(new Date().toISOString().slice(0, 10)); }
  const rows = await db.prepare(`SELECT a.*, j.title, j.company, j.city, j.location_text, j.url, j.discovered_at, j.description, j.skills, j.experience_level,
      an.score AS ai_score, cv.version_no AS cv_no, cl.version_no AS letter_no
    FROM applications a JOIN jobs j ON j.id = a.job_id LEFT JOIN analyses an ON an.job_id = j.id
    LEFT JOIN cv_versions cv ON cv.id = a.cv_version_id LEFT JOIN cover_letters cl ON cl.id = a.letter_version_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).all(...args);
  const out = rows.map((r) => ({
    job_id: r.job_id, title: r.title, employer: r.company, location: r.city || r.location_text, url: r.url,
    match_score: r.ai_score ?? (profile ? matchJob(profile, { ...r, skills: j(r.skills, []) }).score : null),
    cv_version_id: r.cv_version_id, letter_version_id: r.letter_version_id, cv_version: r.cv_no ? `v${r.cv_no}` : '', letter_version: r.letter_no ? `v${r.letter_no}` : '',
    discovered_at: r.discovered_at, applied_at: r.applied_at, status: r.status, status_label: LABELS[r.status], notes: r.notes,
    follow_up_date: r.follow_up_date, interview_dates: j(r.interview_dates, []), recruiter: j(r.recruiter, {}),
    confirmation: r.confirmation, submission_source: r.submission_source, updated_at: r.updated_at,
  }));
  const key = SORTS.includes(f.sort) ? f.sort : 'updated_at'; const dir = f.dir === 'asc' ? 1 : -1;
  out.sort((a, b) => {
    const x = a[key]; const y = b[key];
    if (x == null || x === '') return 1; if (y == null || y === '') return -1;
    return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
  });
  return out;
}

const CSV_COLS = [['Job title', 'title'], ['Employer', 'employer'], ['Location', 'location'], ['Original job URL', 'url'], ['Match score', 'match_score'],
  ['Applied CV version', 'cv_version'], ['Cover letter version', 'letter_version'], ['Date discovered', 'discovered_at'], ['Date applied', 'applied_at'],
  ['Status', 'status_label'], ['Notes', 'notes'], ['Follow-up date', 'follow_up_date'], ['Interview dates', (r) => r.interview_dates.join('; ')],
  ['Recruiter', (r) => [r.recruiter.name, r.recruiter.email, r.recruiter.phone].filter(Boolean).join(' / ')],
  ['Submission confirmation', 'confirmation'], ['Submission source', 'submission_source']];

// Cells beginning with = + - @ are prefixed so spreadsheets never evaluate job-supplied text as a formula.
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows) {
  const lines = [CSV_COLS.map(([h]) => csvCell(h)).join(',')];
  for (const r of rows) lines.push(CSV_COLS.map(([, k]) => csvCell(typeof k === 'function' ? k(r) : r[k])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// ---- Mode A: requirement checklist
const REQUIREMENTS = [
  ['cover_letter', /cover letter|motivation letter|letter of interest|خطاب (تقديم|تحفيزي)/i, 'Cover letter requested'],
  ['portfolio', /portfolio|work samples|behance|dribbble|معرض أعمال/i, 'Portfolio / work samples requested'],
  ['salary', /salary expectation|expected salary|current salary|desired salary|الراتب المتوقع/i, 'Salary expectation requested', 'salaryExpectation'],
  ['notice', /notice period|available to start|start date|availability|فترة الإشعار/i, 'Notice period / availability requested', 'noticePeriod'],
  ['authorization', /work permit|iqama|right to work|authori[sz]ed to work|eligible to work|transferable|إقامة/i, 'Work authorization / iqama status asked', 'workAuthorization'],
  ['visa', /\bvisa\b/i, 'Visa status mentioned', 'visaStatus'],
  ['relocation', /relocat/i, 'Relocation mentioned', 'relocation'],
  ['references', /references/i, 'References requested'],
  ['certificates', /certificat|transcript|degree (copy|certificate)/i, 'Certificates / transcripts requested'],
  ['language', /\b(english|arabic)\b.*\b(proficien|fluen|written|spoken)|\b(proficien|fluen).*\b(english|arabic)\b/i, 'Language proficiency required'],
];

async function checklistFor(db, job, profile, app, extras = {}) {
  const text = `${job.title}\n${job.description}`;
  const checked = app?.checklist || {};
  const items = [];
  const add = (key, label, o = {}) => items.push({ key, label, done: !!(o.auto ?? checked[key]), auto: o.auto !== undefined, hint: o.hint || '' });

  const approvedCv = await db.prepare("SELECT id, version_no FROM cv_versions WHERE job_id = ? AND status = 'approved' ORDER BY version_no DESC").get(job.id);
  add('listing', 'Open the original listing and confirm it is still accepting applications', { hint: job.url || 'No URL saved for this job.' });
  add('cv', approvedCv ? `Approved CV v${approvedCv.version_no} is ready to attach` : 'Approve a tailored CV version for this job', { auto: !!approvedCv });
  const missingProfile = ['fullName', 'email', 'phone'].filter((k) => !profile[k]);
  add('contact', 'Profile has name, email and phone', { auto: !missingProfile.length, hint: missingProfile.length ? `Missing: ${missingProfile.join(', ')}` : '' });
  for (const [key, re, label, answerKey] of REQUIREMENTS) {
    if (!re.test(text)) continue;
    const saved = answerKey && profile.answers?.[answerKey];
    add(key, label, { hint: answerKey ? (saved ? `Your saved answer: "${saved}"` : 'No saved answer. Decide this yourself; the tool will not guess.') : '' });
  }
  const yrs = text.match(/(\d{1,2})\s*\+?\s*years/i);
  if (yrs) add('years', `Confirm you honestly meet the ${yrs[1]}+ years requirement`, { hint: profile.yearsExperience != null ? `Profile says ${profile.yearsExperience} years.` : 'Profile has no years of experience.' });
  add('review', 'Review every answer and attachment before submitting');
  add('submit', 'Submit on the employer site yourself, then mark as submitted here');
  void extras;
  return items;
}

module.exports = {
  STATUSES, STATUS_KEYS, LABELS, ensure, get, update, markSubmitted, addLog, duplicates, requireNoDuplicate,
  syncFromVersions, list, toCsv, csvCell, checklistFor, fingerprint, hydrate, httpError,
};
