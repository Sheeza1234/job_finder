const { z } = require('zod');

const list = (max = 50, len = 100) => z.array(z.string().trim().min(1).max(len)).max(max);
const enumList = (vals) => z.array(z.enum(vals)).max(vals.length);

const searchSchema = z.object({
  titles: list(30), cities: list(20), markets: z.array(z.enum(['SA', 'PK'])).min(1, 'choose at least one country').max(2),
  minSalary: z.number().min(0).max(10_000_000).nullable(),
  experienceLevels: enumList(['entry', 'mid', 'senior', 'lead']),
  employmentTypes: enumList(['full_time', 'part_time', 'contract', 'internship']),
  workModes: enumList(['remote', 'hybrid', 'onsite']),
  minMatchScore: z.number().int().min(0).max(100),
  excludedCompanies: list(100, 200), excludedKeywords: list(100, 100),
  includeRemote: z.boolean(), arabic: z.boolean(), aiScreening: z.boolean(),
  frequency: z.enum(['off', 'hourly', 'every_6_hours', 'daily']),
  dailyTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'dailyTime must be HH:MM'),
  maxQueries: z.number().int().min(1).max(40),
});
const SEARCH_DEFAULTS = {
  titles: [], cities: [], markets: ['SA', 'PK'], minSalary: null, experienceLevels: [], employmentTypes: [], workModes: [], minMatchScore: 75,
  excludedCompanies: [], excludedKeywords: [], includeRemote: true, arabic: false, aiScreening: false,
  frequency: 'off', dailyTime: '08:00', maxQueries: 20,
};

const notifySchema = z.object({
  inApp: z.boolean(), email: z.boolean(), newMatches: z.boolean(), followUps: z.boolean(), interviews: z.boolean(), expiring: z.boolean(),
  followUpDays: z.number().int().min(1).max(60),
});
const NOTIFY_DEFAULTS = { inApp: true, email: false, newMatches: true, followUps: true, interviews: true, expiring: true, followUpDays: 7 };

// Settings are read on almost every request and each read is a network round trip, so they are cached per database
// connection and refreshed on every write made through this module (this process is the only writer).
const caches = new WeakMap();
const cacheOf = (db) => { let c = caches.get(db); if (!c) { c = new Map(); caches.set(db, c); } return c; };
const invalidate = (db) => cacheOf(db).clear();

const get = async (db, key) => {
  const c = cacheOf(db);
  if (!c.has(key)) {
    const r = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    try { c.set(key, r ? JSON.parse(r.value) : null); } catch { c.set(key, null); }
  }
  const v = c.get(key);
  return v == null ? v : JSON.parse(JSON.stringify(v));   // callers may modify what they get
};
const set = async (db, key, value) => {
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  cacheOf(db).delete(key);
};

function parse(schema, defaults, input) {
  const r = schema.safeParse({ ...defaults, ...input });
  if (!r.success) throw Object.assign(new Error(r.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')), { status: 400 });
  return r.data;
}

const getSearch = async (db) => parse(searchSchema, SEARCH_DEFAULTS, (await get(db, 'search_settings')) || {});
const saveSearch = async (db, input) => { const v = parse(searchSchema, SEARCH_DEFAULTS, input); await set(db, 'search_settings', v); return v; };
const getNotify = async (db) => parse(notifySchema, NOTIFY_DEFAULTS, (await get(db, 'notification_prefs')) || {});
const saveNotify = async (db, input) => { const v = parse(notifySchema, NOTIFY_DEFAULTS, input); await set(db, 'notification_prefs', v); return v; };

const has = (hay, needle) => String(hay || '').toLowerCase().includes(String(needle).toLowerCase());

// Excluded employers/keywords never get recommended or notified.
function isExcluded(job, s) {
  if (s.excludedCompanies.some((c) => has(job.company, c))) return true;
  return s.excludedKeywords.some((k) => has(job.title, k) || has(job.description, k));
}

// Does a job fit the stated preferences? Unknown attributes are given the benefit of the doubt.
function qualifies(job, s) {
  if (s.employmentTypes.length && job.employment_type !== 'unknown' && !s.employmentTypes.includes(job.employment_type)) return false;
  if (s.workModes.length && job.work_mode !== 'unknown' && !s.workModes.includes(job.work_mode)) return false;
  if (s.experienceLevels.length && job.experience_level !== 'unknown' && !s.experienceLevels.includes(job.experience_level)) return false;
  if (s.minSalary && (job.salary_max || job.salary_min) && (job.salary_max || job.salary_min) < s.minSalary) return false;
  if (s.cities.length && job.work_mode !== 'remote' && job.city && !s.cities.includes(job.city)) return false;
  if (!s.includeRemote && job.work_mode === 'remote') return false;
  return true;
}

module.exports = { getSearch, saveSearch, getNotify, saveNotify, get, set, invalidate, isExcluded, qualifies, SEARCH_DEFAULTS };
