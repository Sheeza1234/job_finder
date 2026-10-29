const jobsStore = require('./jobsStore');
const settings = require('./settings');
const notifications = require('./notifications');
const scheduler = require('./scheduler');
const { matchJob } = require('./match');

const DAY = 864e5;
const DONE = ['applied', 'assessment', 'interview', 'offer', 'rejected', 'withdrawn', 'listing_expired'];
const TERMINAL = ['offer', 'rejected', 'withdrawn', 'listing_expired'];
const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const j = (s, f) => { try { return s ? JSON.parse(s) : f; } catch { return f; } };

const salaryText = (job) => {
  if (!job.salary_min && !job.salary_max) return null;
  const n = (v) => Math.round(v).toLocaleString('en-US');
  const range = job.salary_max && job.salary_max !== job.salary_min ? `${n(job.salary_min || job.salary_max)}–${n(job.salary_max)}` : n(job.salary_min || job.salary_max);
  return `${range} ${job.salary_currency || ''}`.trim();
};

// Compact card used by the dashboard. Sponsorship is shown only when the posting explicitly states it.
function card(job, profile, minScore, an) {
  const ai = an && j(an.data, null);
  const h = matchJob(profile, job);
  return {
    id: job.id, title: job.title, company: job.company, location: job.city || job.location_text, work_mode: job.work_mode, employment_type: job.employment_type,
    salary: salaryText(job), posted_at: job.posted_at, is_new: !!job.posted_at && Date.now() - new Date(job.posted_at) <= DAY,
    match_score: job.match_score, match_method: job.match_method, high_match: job.match_score != null && job.match_score >= minScore,
    top_skills: (ai?.keywords?.length ? ai.keywords : h.matchedSkills).slice(0, 5),
    missing: (ai?.gaps?.length ? ai.gaps : h.missingSkills).slice(0, 5).map(String),
    sponsorship: job.sponsorship === 'not_specified' ? null : job.sponsorship, url: job.url, app_status: job.app_status || null,
  };
}

async function build(db, profile, now = new Date()) {
  const s = await settings.getSearch(db);
  const { jobs: all } = await jobsStore.listJobs(db, { limit: 3000, sort: 'score' }, profile);
  const visible = all.filter((x) => !settings.isExcluded(x, s));
  const today = localDate(now);
  const [apps, unread, search] = await Promise.all([
    jobsStore.modeClause(db).then((mode) => db.prepare(`SELECT a.*, j.title, j.company FROM applications a JOIN jobs j ON j.id = a.job_id WHERE ${mode}`).all()),
    notifications.unreadCount(db), scheduler.status(db, now)]);

  const dueFollowUps = apps.filter((a) => a.follow_up_date && a.follow_up_date <= today && !TERMINAL.includes(a.status));
  const upcoming = [];
  for (const a of apps) for (const d of j(a.interview_dates, [])) {
    const t = new Date(d.length === 10 ? `${d}T09:00` : d);
    if (t >= new Date(+now - 2 * 3600e3) && t - now <= 14 * DAY) upcoming.push({ job_id: a.job_id, title: a.title, company: a.company, at: d });
  }
  upcoming.sort((x, y) => x.at.localeCompare(y.at));

  // Only genuinely relevant jobs: within 15 points of the threshold (never below 40%), best first.
  const floor = Math.max(40, s.minMatchScore - 15);
  const recommendedRows = visible.filter((x) => x.match_score != null && x.match_score >= floor && settings.qualifies(x, s) && !DONE.includes(x.app_status))
    .slice(0, 12);
  const analyses = recommendedRows.length ? await db.prepare('SELECT job_id, data FROM analyses WHERE job_id = ANY(?::int[])').all(recommendedRows.map((x) => x.id)) : [];
  const byJob = new Map(analyses.map((a) => [a.job_id, a]));
  const recommended = recommendedRows.map((x) => card(x, profile, s.minMatchScore, byJob.get(x.id)));

  return {
    overview: {
      total_jobs: all.length,
      high_match: visible.filter((x) => x.match_score != null && x.match_score >= s.minMatchScore).length,
      new_24h: all.filter((x) => x.discovered_at && now - new Date(x.discovered_at) <= DAY).length,
      shortlisted: apps.filter((a) => a.status === 'shortlisted').length,
      submitted: apps.filter((a) => a.applied_at).length,
      interviews: apps.filter((a) => a.status === 'interview').length,
      pending_followups: dueFollowUps.length,
      unread_notifications: unread,
    },
    min_match_score: s.minMatchScore,
    recommended,
    upcoming_interviews: upcoming.slice(0, 8),
    due_followups: dueFollowUps.slice(0, 8).map((a) => ({ job_id: a.job_id, title: a.title, company: a.company, due: a.follow_up_date })),
    search,
  };
}

// CV Studio: master CV, every tailored version across jobs, and each version's history.
async function studio(db) {
  const docs = await db.prepare("SELECT id, filename, kind, is_master, created_at, length(text) AS text_chars FROM documents WHERE kind = 'cv' ORDER BY id DESC").all();
  const versions = (await db.prepare(`SELECT v.id, v.job_id, v.version_no, v.status, v.origin, v.parent_id, v.created_at, v.approved_at, v.warnings, v.changes, j.title AS job_title, j.company,
      (SELECT COUNT(*) FROM applications a WHERE a.cv_version_id = v.id) AS used_count
    FROM cv_versions v JOIN jobs j ON j.id = v.job_id ORDER BY v.created_at DESC`).all())
    .map((v) => ({ ...v, warnings: j(v.warnings, []).length, changes: j(v.changes, []).length }));
  return { master: docs.find((d) => d.is_master) || null, documents: docs, versions };
}

async function history(db, versionId) {
  const v = await db.prepare('SELECT * FROM cv_versions WHERE id = ?').get(versionId);
  if (!v) return null;
  const events = [{ at: v.created_at, event: v.parent_id ? `Created as an edited copy of v${((await db.prepare('SELECT version_no n FROM cv_versions WHERE id = ?').get(v.parent_id)) || {}).n || '?'}` : 'Generated by the tailoring engine' }];
  for (const a of await db.prepare("SELECT at, action FROM audit_logs WHERE entity = 'cv_version' AND entity_id = ? ORDER BY id").all(String(versionId))) {
    const label = /PUT/.test(a.action) ? 'Edited' : /approve/.test(a.action) ? 'Approved' : /revoke/.test(a.action) ? 'Approval revoked' : /DELETE/.test(a.action) ? 'Deleted' : null;
    if (label) events.push({ at: a.at, event: label });
  }
  return { version_id: versionId, version_no: v.version_no, events: events.sort((x, y) => x.at.localeCompare(y.at)),
    changes: j(v.changes, []) };
}

module.exports = { build, studio, history, card, salaryText };
