const ai = require('./ai');
const settings = require('./settings');
const profileSvc = require('./profile');
const privacy = require('./privacy');
const email = require('./email');
const health = require('./health');

// Setup steps derived from real state, never from a flag the user could forget to tick.
async function steps(db) {
  const p = await profileSvc.getProfile(db);
  const jobs = (await db.prepare("SELECT COUNT(*) n FROM jobs WHERE source != 'demo'").get()).n;
  const cv = (await db.prepare("SELECT COUNT(*) n FROM documents WHERE kind = 'cv' AND length(text) > 0").get()).n;
  const aiOn = ai.isConfigured(); const consent = (await privacy.getConsent(db)).ai;
  const emailWorks = health.outcome(((await settings.get(db, 'integration_health')) || {}).email).state === 'ok';
  const searchSaved = await settings.get(db, 'search_settings');
  const searchOn = (await settings.getSearch(db)).frequency !== 'off';
  return [
    { key: 'cv', label: 'Upload your CV', detail: 'PDF or DOCX. Your profile is filled in from it automatically, so you only add what is missing. The CV itself stays unchanged.', done: cv > 0, view: 'studio', required: true },
    { key: 'profile', label: 'Complete your profile', detail: 'Name, email and your real skills or experience (filled from your CV; add what is missing). Everything the AI writes is based on this.', done: !!(p.fullName && p.email && (p.skills.length || p.experience.length)), view: 'profile', required: true },
    { key: 'preferences', label: 'Set your search preferences', detail: 'Titles, cities, minimum match score and what to exclude.', done: !!searchSaved, view: 'searchsettings', required: true },
    { key: 'source', label: 'Get real jobs in', detail: 'Fetch from a configured source, or add a posting by URL or pasted text. This step is done once real jobs are saved.', done: jobs > 0, view: 'jobs', required: true },
    { key: 'ai', label: 'Turn on AI features', required: false, view: 'settings', done: aiOn && consent,
      detail: !aiOn ? 'Add an AI key in .env (ANTHROPIC_API_KEY, or AI_API_KEY + AI_BASE_URL for a gateway).'
        : 'An AI provider is configured. It asks for your consent the first time you use an AI feature (or allow it in Settings → Privacy).' },
    { key: 'alerts', label: 'Choose how you are notified', required: false, view: 'searchsettings', done: searchOn || emailWorks,
      detail: 'Recurring search and in-app alerts, or email. Email counts only once a test message has actually been delivered.' },
  ];
}

async function status(db) {
  const s = await steps(db);
  const dismissed = !!(await settings.get(db, 'onboarding_dismissed'));
  return { steps: s, complete: s.filter((x) => x.required).every((x) => x.done), dismissed, show: !dismissed && !s.filter((x) => x.required).every((x) => x.done) };
}
const dismiss = (db) => settings.set(db, 'onboarding_dismissed', true);

module.exports = { status, dismiss };
