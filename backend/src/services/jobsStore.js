const { matchJob, isRelevant } = require('./match');
const { COUNTRIES } = require('../markets');
const { jobFingerprint, urlKey } = require('../normalize');
const settings = require('./settings');

const COLS = ['source', 'external_id', 'url', 'title', 'company', 'city', 'country', 'location_text', 'description',
  'employment_type', 'work_mode', 'remote_eligibility', 'industry', 'experience_level', 'salary_min', 'salary_max',
  'salary_currency', 'posted_at', 'expires_at', 'sponsorship', 'relocation', 'skills', 'dedupe_key', 'duplicate_of'];

// Inserts/updates jobs. A new job that matches an existing one from ANOTHER source (same employer+title+city, or same
// listing URL) is stored as a duplicate of it: hidden from listings, never notified twice, and its extra details
// (salary, closing date) are merged into the original. `newIds` (optional array) receives ids of genuinely new jobs.
// Timestamps must be real dates in Postgres; a provider's odd or empty date becomes "unknown" instead of failing the whole save.
const asIso = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };

async function upsertJobs(db, jobs, newIds) {
  const now = new Date().toISOString();
  const sql = `INSERT INTO jobs (${COLS.join(',')}, fetched_at, discovered_at)
    VALUES (${COLS.map((c) => '@' + c).join(',')}, @fetched_at, @fetched_at)
    ON CONFLICT(source, external_id) DO UPDATE SET
      ${COLS.filter((c) => !['source', 'external_id', 'dedupe_key', 'duplicate_of'].includes(c)).map((c) => `${c}=excluded.${c}`).join(',')},
      fetched_at = excluded.fetched_at
    RETURNING id`;
  const todo = jobs.filter((j) => j.title).map((j) => ({ ...j, external_id: String(j.external_id), posted_at: asIso(j.posted_at), expires_at: asIso(j.expires_at) }));
  if (!todo.length) return 0;

  // One round trip to learn which jobs are already stored and which could be duplicates of another source's listing.
  const keys = todo.map((j) => jobFingerprint(j)).filter(Boolean);
  const urls = todo.map((j) => j.url).filter(Boolean);
  const existing = new Set((await db.prepare(
    'SELECT source, external_id FROM jobs WHERE (source, external_id) IN (SELECT * FROM unnest(?::text[], ?::text[]))').all(todo.map((j) => j.source), todo.map((j) => j.external_id)))
    .map((r) => `${r.source}\u0000${r.external_id}`));
  const candidates = (keys.length || urls.length) ? await db.prepare(
    'SELECT * FROM jobs WHERE duplicate_of IS NULL AND (dedupe_key = ANY(?::text[]) OR (url IS NOT NULL AND url = ANY(?::text[]))) ORDER BY id').all(keys, urls) : [];

  let added = 0;
  await db.transaction(async () => {
    for (const j of todo) {
      const existed = existing.has(`${j.source}\u0000${j.external_id}`);
      const key = jobFingerprint(j);
      let canonical = null;
      if (!existed && j.source !== 'manual' && j.source !== 'demo') {
        canonical = candidates.find((c) => c.source !== j.source && ((key && c.dedupe_key === key) || (j.url && c.url === j.url))) || null;
      }
      const { id } = await db.prepare(sql).get({ ...j, dedupe_key: key, duplicate_of: canonical ? canonical.id : null, fetched_at: now });
      existing.add(`${j.source}\u0000${j.external_id}`);   // the same listing twice in one batch is one job
      if (existed) continue;
      added++;
      if (canonical) {
        await db.prepare(`UPDATE jobs SET salary_min = COALESCE(salary_min, ?), salary_max = COALESCE(salary_max, ?), salary_currency = COALESCE(salary_currency, ?),
          expires_at = COALESCE(expires_at, ?), posted_at = COALESCE(posted_at, ?) WHERE id = ?`).run(j.salary_min ?? null, j.salary_max ?? null, j.salary_currency ?? null, j.expires_at ?? null, j.posted_at ?? null, canonical.id);
      } else {
        if (newIds) newIds.push(id);
        candidates.push({ id, source: j.source, dedupe_key: key, url: j.url });   // a later job in this batch can be its duplicate
      }
    }
  });
  return added;
}

const hydrate = (r) => ({ ...r, skills: JSON.parse(r.skills || '[]') });

// Demo and production data never mix: demo mode shows only labelled sample jobs, production shows none of them.
const getMode = async (db) => ((await settings.get(db, 'app_mode')) === 'demo' ? 'demo' : 'production');
const modeClause = async (db) => ((await getMode(db)) === 'demo' ? "j.source = 'demo'" : "j.source != 'demo'");

async function getJob(db, id) {
  const r = await db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  return r ? hydrate(r) : null;
}

// Filtered listing. `profile` is used to compute a heuristic match score for sorting.
// Stored jobs that do not fit the profile and that the user never added or tracked. Used by "Remove jobs that don't fit".
async function irrelevantIds(db, profile, minScore = 50) {
  return (await scanJobs(db, { fit: '1', min_score: String(minScore), limit: 3000, scope: 'all' }, profile)).hiddenIds;
}

async function listJobs(db, f = {}, profile = null) {
  const { hiddenIds, ...result } = await scanJobs(db, f, profile);   // ids are for cleanup only, not for the browser
  return result;
}

async function scanJobs(db, f = {}, profile = null) {
  const where = []; const args = [];
  const add = (sql, ...a) => { where.push(sql); args.push(...a); };

  add('j.duplicate_of IS NULL');
  add(await modeClause(db));
  if (f.scope !== 'all') add(`(source = 'manual' OR country IN (${COUNTRIES.map(() => '?').join(',')}) OR (work_mode = 'remote' AND remote_eligibility != 'restricted'))`, ...COUNTRIES);
  if (f.country) add('country = ?', f.country);
  if (f.city) add('city = ?', f.city);
  if (f.q) add('(title ILIKE ? OR description ILIKE ?)', `%${f.q}%`, `%${f.q}%`);
  if (f.company) add('company ILIKE ?', `%${f.company}%`);
  if (f.industry) add('industry ILIKE ?', `%${f.industry}%`);
  if (f.experience_level) add('experience_level = ?', f.experience_level);
  if (f.employment_type) add('employment_type = ?', f.employment_type);
  if (f.work_mode) add('work_mode = ?', f.work_mode);
  if (f.sponsorship) add('sponsorship = ?', f.sponsorship);
  if (f.relocation) add('relocation = ?', f.relocation);
  if (f.salary_min) add('(salary_max >= ? OR salary_min >= ?)', Number(f.salary_min), Number(f.salary_min));
  if (f.salary_max) add('(salary_min IS NULL OR salary_min <= ?)', Number(f.salary_max));
  if (f.posted_within_days) {
    add('posted_at >= ?', new Date(Date.now() - Number(f.posted_within_days) * 864e5).toISOString());
  }
  for (const s of String(f.skills || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    add('(skills::text ILIKE ? OR description ILIKE ? OR title ILIKE ?)', `%${s}%`, `%${s}%`, `%${s}%`);
  }

  const rows = await db.prepare(`
    SELECT j.*, a.score AS ai_score, a.method AS analysis_method, ap.status AS app_status
    FROM jobs j LEFT JOIN analyses a ON a.job_id = j.id LEFT JOIN applications ap ON ap.job_id = j.id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} LIMIT 3000`).all(...args);

  const out = rows.map((r) => {
    const job = hydrate(r);
    const h = profile ? matchJob(profile, job) : null;
    job.match_score = r.ai_score ?? h?.score ?? null;
    job.match_method = r.ai_score != null ? r.analysis_method : h ? 'heuristic' : null;
    return job;
  });
  // "Only jobs that fit me": hide weak matches, but say how many so nothing disappears silently.
  const minScore = Number(f.min_score) || 0;
  // fit=1 also hides jobs whose title has nothing to do with the profile's roles, however many keywords they share.
  // Jobs the user added or is tracking are never hidden.
  const fitOnly = f.fit === '1' && profile;
  const hiddenJobs = out.filter((j) => j.source !== 'manual' && !j.app_status
    && ((minScore && j.match_score != null && j.match_score < minScore) || (fitOnly && !isRelevant(profile, j))));
  if (hiddenJobs.length) { const drop = new Set(hiddenJobs.map((j) => j.id)); for (let i = out.length - 1; i >= 0; i--) if (drop.has(out[i].id)) out.splice(i, 1); }
  const sort = f.sort || 'score';
  out.sort((a, b) => sort === 'posted'
    ? (b.posted_at || '').localeCompare(a.posted_at || '')
    : (b.match_score ?? -1) - (a.match_score ?? -1) || (b.posted_at || '').localeCompare(a.posted_at || ''));

  const limit = Math.min(Number(f.limit) || 50, 3000); const offset = Number(f.offset) || 0;
  return { total: out.length, hidden: hiddenJobs.length, hiddenIds: hiddenJobs.map((x) => x.id), jobs: out.slice(offset, offset + limit) };
}

const alsoListedOn = (db, id) => db.prepare('SELECT id, source, url FROM jobs WHERE duplicate_of = ?').all(id);

async function facets(db) {
  const mode = (await getMode(db)) === 'demo' ? "source = 'demo'" : "source != 'demo'";
  const distinct = async (col) => (await db.prepare(`SELECT DISTINCT ${col} v FROM jobs WHERE duplicate_of IS NULL AND ${mode} AND ${col} IS NOT NULL AND ${col} != '' ORDER BY v LIMIT 100`).all()).map((r) => r.v);
  return { cities: await distinct('city'), industries: await distinct('industry'), companies: await distinct('company') };
}

function saveAnalysis(db, jobId, score, data) {
  return db.prepare(`INSERT INTO analyses (job_id, score, method, data, created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(job_id) DO UPDATE SET score=excluded.score, method=excluded.method, data=excluded.data, created_at=excluded.created_at`)
    .run(jobId, score, 'ai', JSON.stringify(data), new Date().toISOString());
}

module.exports = { getMode, modeClause, alsoListedOn, saveAnalysis, upsertJobs, getJob, listJobs, facets, irrelevantIds };
