// Per-job CV and cover-letter versions. Nothing here ever writes to the profile or uploaded
// documents, so the original CV stays untouched. Approved versions are the only ones used to apply.
const { groundContent, unsupportedFigures, unsupportedSkillMentions } = require('./grounding');
const { buildCvModel } = require('./exportDocs');

const httpError = (status, message) => Object.assign(new Error(message), { status });
const j = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const now = () => new Date().toISOString();

const hydrateCv = (r) => r && ({
  ...r, content: j(r.content, {}), changes: j(r.changes, []), gaps: j(r.gaps, []), keywords: j(r.keywords, []),
  warnings: j(r.warnings, []), profile_snapshot: j(r.profile_snapshot, {}),
});
const summarize = (v) => ({ id: v.id, job_id: v.job_id, version_no: v.version_no, origin: v.origin, status: v.status, parent_id: v.parent_id,
  warnings: v.warnings.length, created_at: v.created_at, approved_at: v.approved_at });

async function nextNo(db, table, jobId) {
  return ((await db.prepare(`SELECT MAX(version_no) m FROM ${table} WHERE job_id = ?`).get(jobId)).m || 0) + 1;
}

// ---- CV versions
async function createCvVersion(db, { job, profile, result, parentId = null, origin = 'ai' }) {
  const r = await db.prepare(`INSERT INTO cv_versions (job_id, version_no, parent_id, origin, content, changes, gaps, keywords, warnings, profile_snapshot, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(job.id, await nextNo(db, 'cv_versions', job.id), parentId, origin, JSON.stringify(result.content),
    JSON.stringify(result.changes || []), JSON.stringify(result.gaps || []), JSON.stringify(result.keywords || []),
    JSON.stringify(result.warnings || []), JSON.stringify(profile), now());
  return getCv(db, r.lastInsertRowid);
}
const getCv = async (db, id) => hydrateCv(await db.prepare('SELECT * FROM cv_versions WHERE id = ?').get(Number(id)));
const needCv = async (db, id) => (await getCv(db, id)) || (() => { throw httpError(404, 'CV version not found'); })();
const listCv = async (db, jobId) => (await db.prepare('SELECT * FROM cv_versions WHERE job_id = ? ORDER BY version_no DESC').all(jobId)).map(hydrateCv).map(summarize);
const cvModel = (v) => buildCvModel(v.profile_snapshot, v.content);
const originalModel = (v) => buildCvModel(v.profile_snapshot, null);

// Editing a draft updates it in place; editing an approved version forks a new draft (approval never carries over).
async function editCv(db, id, input) {
  const v = await needCv(db, id);
  const { content, warnings } = groundContent(v.profile_snapshot, { ...v.content, ...input });
  const changes = [...v.changes.filter((c) => c.section !== 'manual'), { section: 'manual', change: 'Edited by you after generation', reason: 'Manual edit' }];
  if (v.status === 'approved') {
    return createCvVersion(db, { job: { id: v.job_id }, profile: v.profile_snapshot, parentId: v.id, origin: 'edit',
      result: { content, warnings, changes, gaps: v.gaps, keywords: v.keywords } });
  }
  await db.prepare('UPDATE cv_versions SET content = ?, warnings = ?, changes = ?, origin = ? WHERE id = ?')
    .run(JSON.stringify(content), JSON.stringify(warnings), JSON.stringify(changes), v.origin === 'ai' ? 'ai+edit' : v.origin, v.id);
  return getCv(db, v.id);
}

async function approveCv(db, id, { acknowledge } = {}) {
  const v = await needCv(db, id);
  if (v.warnings.length && !acknowledge) throw httpError(409, `This version has ${v.warnings.length} accuracy warning(s). Fix them or approve with acknowledgement that you checked every claim is true.`);
  await db.prepare('UPDATE cv_versions SET status = ?, approved_at = ? WHERE id = ?').run('approved', now(), v.id);
  return getCv(db, v.id);
}
const revokeCv = async (db, id) => { await db.prepare("UPDATE cv_versions SET status = 'draft', approved_at = NULL WHERE id = ?").run((await needCv(db, id)).id); return getCv(db, id); };

// ---- cover letters
const hydrateLetter = (r) => r && { ...r, warnings: j(r.warnings, []) };
async function createLetter(db, { job, text, language = 'en', warnings = [], origin = 'ai' }) {
  const r = await db.prepare('INSERT INTO cover_letters (job_id, version_no, origin, language, text, warnings, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(job.id, await nextNo(db, 'cover_letters', job.id), origin, language, text, JSON.stringify(warnings), now());
  return getLetter(db, r.lastInsertRowid);
}
const getLetter = async (db, id) => hydrateLetter(await db.prepare('SELECT * FROM cover_letters WHERE id = ?').get(Number(id)));
const needLetter = async (db, id) => (await getLetter(db, id)) || (() => { throw httpError(404, 'Cover letter not found'); })();
const listLetters = async (db, jobId) => (await db.prepare('SELECT * FROM cover_letters WHERE job_id = ? ORDER BY version_no DESC').all(jobId)).map(hydrateLetter)
  .map(({ text, ...rest }) => ({ ...rest, warnings: rest.warnings.length, chars: text.length }));

function letterWarnings(profile, text) {
  const w = [];
  const f = unsupportedFigures(profile, text); if (f.length) w.push(`Cover letter contains figure(s) not found in your profile: ${f.join(', ')}. Verify or remove.`);
  const s = unsupportedSkillMentions(profile, text); if (s.length) w.push(`Cover letter mentions ${s.join(', ')}, which your profile does not support.`);
  return w;
}

async function editLetter(db, id, text, profile) {
  const l = await needLetter(db, id);
  if (!String(text || '').trim()) throw httpError(400, 'Letter text is empty');
  const warnings = letterWarnings(profile, text);
  if (l.status === 'approved') return createLetter(db, { job: { id: l.job_id }, text, language: l.language, warnings, origin: 'edit' });
  await db.prepare('UPDATE cover_letters SET text = ?, warnings = ? WHERE id = ?').run(text, JSON.stringify(warnings), l.id);
  return getLetter(db, l.id);
}
async function approveLetter(db, id, { acknowledge } = {}) {
  const l = await needLetter(db, id);
  if (l.warnings.length && !acknowledge) throw httpError(409, `This letter has ${l.warnings.length} accuracy warning(s). Fix them or approve with acknowledgement.`);
  await db.prepare('UPDATE cover_letters SET status = ?, approved_at = ? WHERE id = ?').run('approved', now(), l.id);
  return getLetter(db, l.id);
}
const revokeLetter = async (db, id) => { await db.prepare("UPDATE cover_letters SET status = 'draft', approved_at = NULL WHERE id = ?").run((await needLetter(db, id)).id); return getLetter(db, id); };

// A version that an application in a post-submission state points at must not vanish.
const LOCKED = ['applied', 'assessment', 'interview', 'offer', 'rejected', 'withdrawn'];
async function deleteVersion(db, kind, id) {
  const col = kind === 'cv' ? 'cv_version_id' : 'letter_version_id';
  const app = await db.prepare(`SELECT status FROM applications WHERE ${col} = ?`).get(Number(id));
  if (app && LOCKED.includes(app.status)) throw httpError(409, 'This version was used for a submitted application and is kept as a record.');
  await db.prepare(`UPDATE applications SET ${col} = NULL WHERE ${col} = ?`).run(Number(id));
  await db.prepare(`DELETE FROM ${kind === 'cv' ? 'cv_versions' : 'cover_letters'} WHERE id = ?`).run(Number(id));
}

// ---- compare
const sentences = (s) => String(s || '').split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
function sectionsOf(m) {
  return [
    ['Headline', [m.headline].filter(Boolean)],
    ['Summary', sentences(m.summary)],
    ['Skills', m.skills],
    ['Experience', m.experience.flatMap((e) => [`${e.title}${e.company ? ', ' + e.company : ''}${e.dates ? ' (' + e.dates + ')' : ''}`, ...e.bullets.map((b) => `- ${b}`)])],
    ['Projects', m.projects.flatMap((p) => [p.name, ...(p.description ? [`- ${p.description}`] : [])])],
  ];
}
function lineDiff(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let k = b.length - 1; k >= 0; k--) dp[i][k] = a[i] === b[k] ? dp[i + 1][k + 1] + 1 : Math.max(dp[i + 1][k], dp[i][k + 1]);
  const out = []; let i = 0; let k = 0;
  while (i < a.length && k < b.length) {
    if (a[i] === b[k]) { out.push({ type: 'same', text: a[i] }); i++; k++; }
    else if (dp[i + 1][k] >= dp[i][k + 1]) out.push({ type: 'del', text: a[i++] });
    else out.push({ type: 'add', text: b[k++] });
  }
  while (i < a.length) out.push({ type: 'del', text: a[i++] });
  while (k < b.length) out.push({ type: 'add', text: b[k++] });
  return out;
}
function diffModels(left, right) {
  const L = sectionsOf(left); const R = sectionsOf(right);
  return L.map(([name, la], i) => ({ section: name, lines: lineDiff(la, R[i][1]) }));
}

// Compare a version against the untouched original (profile as snapshotted) or another version of the same job.
async function compare(db, id, to = 'original') {
  const v = await needCv(db, id);
  let left; let label;
  if (to === 'original') { left = originalModel(v); label = 'Original profile CV (unchanged)'; }
  else {
    const o = await needCv(db, to);
    if (o.job_id !== v.job_id) throw httpError(400, 'Versions belong to different jobs');
    left = cvModel(o); label = `Version ${o.version_no}`;
  }
  return { left_label: label, right_label: `Version ${v.version_no}`, diff: diffModels(left, cvModel(v)) };
}

module.exports = {
  createCvVersion, getCv, needCv, listCv, cvModel, originalModel, editCv, approveCv, revokeCv,
  createLetter, getLetter, needLetter, listLetters, editLetter, approveLetter, revokeLetter, letterWarnings,
  deleteVersion, compare, diffModels,
};
