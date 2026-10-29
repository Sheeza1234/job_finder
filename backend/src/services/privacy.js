const fs = require('fs');
const path = require('path');
const settings = require('./settings');

const DISCLOSURE = {
  // Names the real destination: Anthropic directly, or your configured gateway (a third party in the data path).
  get ai() {
    const t = require('./ai').target();
    const dest = t.gateway ? `your AI gateway at ${t.host}, which forwards it to the model provider(s) it is configured with` : 'Anthropic (the Claude API)';
    return `When you use AI features (analyze a job, tailor a CV, write a cover letter, pre-fill your profile from a CV, or AI screening in scheduled searches), the relevant parts of your profile (skills, experience, education, projects, contact details in the profile) and the job text are sent to ${dest} to generate the result. Uploaded CV files are not sent as files; for CV pre-fill only the extracted CV text is sent. Nothing is sent until you consent.`;
  },
  jobSources: 'Job searches send only search keywords and city names to the job-source APIs you enabled (Remotive, Jooble, JSearch). Your CV and profile are never sent to them.',
  employers: 'Your CV and cover letter go to an employer only when you submit them yourself, or when you start browser assistance (Mode B) on that employer’s page and then submit it.',
  email: 'If you enable email notifications, job titles and links are sent through your chosen email provider. CV content is never emailed.',
};

const getConsent = async (db) => (await settings.get(db, 'ai_consent')) || { ai: false, at: null };
async function setConsent(db, ai) { const v = { ai: !!ai, at: new Date().toISOString() }; await settings.set(db, 'ai_consent', v); return v; }

const TABLES = ['notifications', 'audit_logs', 'applications', 'cv_versions', 'cover_letters', 'analyses', 'jobs', 'documents', 'profile', 'settings'];

// Everything stored about the user except credentials, as portable JSON.
async function exportAll(db) {
  const out = { exported_at: new Date().toISOString() };
  for (const t of TABLES) {
    if (t === 'settings') {
      out.settings = Object.fromEntries((await db.prepare("SELECT key, value FROM settings WHERE key IN ('search_settings','notification_prefs','ai_consent')").all()).map((r) => [r.key, JSON.parse(r.value)]));
    } else out[t] = await db.prepare(`SELECT * FROM ${t}`).all();
  }
  return out;
}

// Irreversibly wipes the database content and uploaded files, including stored credentials and the audit log.
async function deleteAll(db, uploadDir) {
  const counts = {};
  await db.transaction(async () => { for (const t of TABLES) counts[t] = (await db.prepare(`DELETE FROM ${t}`).run()).changes; });
  let files = 0;
  if (fs.existsSync(uploadDir)) for (const f of fs.readdirSync(uploadDir)) { fs.rmSync(path.join(uploadDir, f), { recursive: true, force: true }); files++; }
  settings.invalidate(db);
  try { await require('./credentials').load(db); } catch { /* cache cleared with the table */ }
  return { deleted_rows: counts, deleted_files: files };
}

module.exports = { DISCLOSURE, getConsent, setConsent, exportAll, deleteAll };
