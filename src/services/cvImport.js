// Fill the profile from an uploaded CV. Rules:
//  - Only EMPTY fields are filled; anything you already entered is never overwritten.
//  - Lists get new, non-duplicate entries appended (skills/languages/achievements by name; experience, education,
//    certifications, projects by their identifying fields).
//  - Extraction can be wrong, so the previous profile is kept for one-click undo, and what is still missing is reported.
const profileSvc = require('./profile');
const settings = require('./settings');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, ' ').trim();
const SCALARS = [['fullName', 'Full name'], ['email', 'Email'], ['phone', 'Phone'], ['location', 'Location'], ['headline', 'Headline'], ['summary', 'Professional summary'],
  ['linkedinUrl', 'LinkedIn URL'], ['websiteUrl', 'Website'], ['portfolioUrl', 'Portfolio URL']];
const STR_LISTS = [['skills', 'Skills'], ['languages', 'Languages'], ['achievements', 'Achievements']];
const OBJ_LISTS = [['experience', 'Work experience', (x) => `${norm(x.title)}|${norm(x.company)}`],
  ['education', 'Education', (x) => `${norm(x.degree)}|${norm(x.institution)}`],
  ['certifications', 'Certifications', (x) => norm(x.name)], ['projects', 'Projects', (x) => norm(x.name)]];

// What a profile needs before tailoring can work well. Everything else is optional.
const ESSENTIAL = [['fullName', 'Full name'], ['email', 'Email'], ['phone', 'Phone'], ['location', 'Location'], ['headline', 'Headline'],
  ['summary', 'Professional summary'], ['skills', 'Skills'], ['experience', 'Work experience'], ['education', 'Education']];
const isEmpty = (v) => (Array.isArray(v) ? v.length === 0 : v == null || v === '');
const missingFields = (p) => ESSENTIAL.filter(([k]) => isEmpty(p[k])).map(([key, label]) => ({ key, label }));

// ---- local extraction (no AI, nothing leaves the machine): contact details and links only
function basicExtract(text) {
  const t = String(text || '');
  const out = {};
  const email = t.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/); if (email) out.email = email[0];
  for (const m of t.matchAll(/\+?\d[\d\s().-]{7,}\d/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 9 && digits.length <= 15 && !/^(19|20)\d{2}[\s.-]/.test(m[0].trim())) { out.phone = m[0].trim().replace(/\s{2,}/g, ' '); break; }
  }
  const urls = [...t.matchAll(/(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/[^\s)<>,;]*|https?:\/\/[^\s)<>,;]+/gi)].map((m) => m[0].replace(/[.]+$/, ''))
    .filter((u) => !/@/.test(u)).map((u) => (/^https?:/i.test(u) ? u : `https://${u}`));
  const li = urls.find((u) => /linkedin\.com/i.test(u)); if (li) out.linkedinUrl = li;
  const pf = urls.find((u) => /behance\.net|dribbble\.com|portfolio|artstation/i.test(u)); if (pf) out.portfolioUrl = pf;
  const site = urls.find((u) => u !== li && u !== pf && !/linkedin|facebook|instagram|twitter|x\.com/i.test(u)); if (site) out.websiteUrl = site;
  const first = t.split('\n').map((l) => l.trim()).find(Boolean) || '';
  if (/^[A-Za-z؀-ۿ][A-Za-z؀-ۿ.'’ -]{2,58}$/.test(first) && first.split(/\s+/).length >= 2 && first.split(/\s+/).length <= 4 && !/curriculum|resume|\bcv\b/i.test(first)) out.fullName = first;
  return out;
}

// Combine drafts: values in `primary` win, `fallback` fills the blanks.
function layer(primary, fallback) {
  const out = { ...fallback };
  for (const [k, v] of Object.entries(primary || {})) if (!isEmpty(v)) out[k] = v;
  return out;
}

// Returns the merged profile plus a human-readable account of what was filled.
function mergeDraft(current, draftIn) {
  const draft = profileSvc.normalize(draftIn);
  const merged = JSON.parse(JSON.stringify(current));
  const filled = [];
  for (const [k, label] of SCALARS) if (isEmpty(merged[k]) && !isEmpty(draft[k])) { merged[k] = draft[k]; filled.push(label); }
  if (merged.yearsExperience == null && draft.yearsExperience != null) { merged.yearsExperience = draft.yearsExperience; filled.push('Years of experience'); }
  for (const [k, label] of STR_LISTS) {
    const have = new Set(merged[k].map(norm)); const add = draft[k].filter((x) => !have.has(norm(x)));
    if (add.length) { merged[k] = [...merged[k], ...add]; filled.push(`${label} (${add.length} added)`); }
  }
  for (const [k, label, key] of OBJ_LISTS) {
    const have = new Set(merged[k].map(key)); const add = draft[k].filter((x) => key(x).replace(/\|/g, '') && !have.has(key(x)));
    if (add.length) { merged[k] = [...merged[k], ...add]; filled.push(`${label} (${add.length} added)`); }
  }
  return { merged: profileSvc.normalize(merged), filled, missing: missingFields(merged) };
}

// ---- undo support
const BACKUP = 'profile_before_import';
const saveBackup = (db, profile, filename) => settings.set(db, BACKUP, { at: new Date().toISOString(), filename, data: profile });
async function importStatus(db) { const b = await settings.get(db, BACKUP); return b ? { at: b.at, filename: b.filename, can_undo: true } : null; }
async function undo(db) {
  const b = await settings.get(db, BACKUP);
  if (!b) throw Object.assign(new Error('There is no automatic import to undo.'), { status: 404 });
  const restored = await profileSvc.saveProfile(db, b.data);
  await db.prepare("DELETE FROM settings WHERE key = ?").run(BACKUP);
  settings.invalidate(db);
  return restored;
}

module.exports = { basicExtract, mergeDraft, missingFields, layer, saveBackup, importStatus, undo, ESSENTIAL };
