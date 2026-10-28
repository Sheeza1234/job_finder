// Integration status: configured / not configured / failing / unavailable, from real outcomes, not just from config.
const config = require('../config');
const providers = require('../providers');
const ai = require('./ai');
const email = require('./email');  // (email -> health is lazy, so this direction is safe)
const settings = require('./settings');
const profileSvc = require('./profile');
// Lazy: scheduler -> search -> health would otherwise be a require cycle with a stale partial export.
const lazy = (m) => new Proxy({}, { get: (_t, k) => require(m)[k] });
const scheduler = lazy('./scheduler');
const autoSubmit = lazy('./autoSubmit');
const { migrationStatus } = require('../db');
const fs = require('fs');

const KEY = 'integration_health';
async function record(db, id, ok, error) {
  const all = (await settings.get(db, KEY)) || {};
  const now = new Date().toISOString();
  all[id] = ok ? { ...(all[id] || {}), last_ok_at: now } : { ...(all[id] || {}), last_error_at: now, last_error: String(error || 'failed').slice(0, 300) };
  await settings.set(db, KEY, all);
}

// "failing" only when the most recent outcome was an error.
function outcome(h) {
  if (!h) return { state: 'configured', detail: 'Not used yet.' };
  if (h.last_error_at && (!h.last_ok_at || h.last_error_at > h.last_ok_at)) return { state: 'failing', detail: `Last attempt failed: ${h.last_error}`, last_error_at: h.last_error_at, last_ok_at: h.last_ok_at };
  return { state: 'ok', detail: 'Last attempt succeeded.', last_ok_at: h.last_ok_at };
}

async function integrations(db) {
  const health = (await settings.get(db, KEY)) || {};
  const out = [];
  const keyHint = { jooble: 'Add a Jooble key (Saudi Arabia: JOOBLE_API_KEY, Pakistan: JOOBLE_PK_API_KEY).', jsearch: 'Set RAPIDAPI_KEY.' };
  for (const p of providers.all) {
    out.push({ id: p.id, group: 'Job sources', label: p.label, testable: true,
      ...(p.enabled() ? outcome(health[p.id]) : { state: 'not_configured', detail: keyHint[p.id] || 'Not enabled.' }) });
  }
  const aiH = ai.health();
  out.push({ id: 'ai', group: 'AI', label: `AI via ${ai.target().name} (${config.aiModel}, ${config.aiProtocol} protocol)`, testable: true,
    ...(ai.isConfigured() ? outcome(aiH.last_ok_at || aiH.last_error_at ? aiH : null) : { state: 'not_configured', detail: config.aiProtocol === 'openai' && !config.aiBaseUrl ? 'AI_PROTOCOL=openai needs AI_BASE_URL.' : 'Set ANTHROPIC_API_KEY, or AI_API_KEY + AI_BASE_URL for a gateway.' }) });
  const ec = await email.publicConfig(db);
  out.push({ id: 'email', group: 'Notifications', label: 'Email delivery', testable: ec.configured,
    ...(ec.configured ? { ...outcome(health.email), detail: `${ec.provider}: ${outcome(health.email).detail}` } : { state: 'not_configured', detail: 'Optional. Configure a provider below.' }) });
  const sch = await scheduler.status(db);
  out.push({ id: 'scheduler', group: 'Background jobs', label: 'Scheduled search & reminders', testable: false,
    state: !config.schedulerEnabled ? 'unavailable' : scheduler.isRunning() ? (sch.last_result?.errors?.length ? 'failing' : 'ok') : 'unavailable',
    detail: !config.schedulerEnabled ? 'Disabled (SCHEDULER=off).' : !scheduler.isRunning() ? 'The scheduler is not running in this process.'
      : `${sch.frequency === 'off' ? 'Reminders active; automatic search is off.' : `Search ${sch.frequency}; next ${sch.next_run_at || 'soon'}.`}${sch.last_result?.errors?.length ? ' Last run had errors: ' + sch.last_result.errors[0] : ''}` });
  out.push({ id: 'browser_assist', group: 'Applying', label: 'Mode B: browser-assisted apply', testable: false, state: config.chromePath ? 'configured' : 'unavailable',
    detail: config.chromePath ? `Chrome found at ${config.chromePath}. Only works when the app runs on your own computer.` : 'No Chrome/Chromium found (set CHROME_PATH).' });
  const n = autoSubmit.listAdapters().length;
  out.push({ id: 'auto_submit', group: 'Applying', label: 'Mode C: automatic submission', testable: false, state: n ? 'configured' : 'unavailable',
    detail: n ? `${n} permitted adapter(s) registered.` : 'No supported sites: none is known to permit automated applications. Manual/assisted modes remain available.' });
  const m = await migrationStatus(db);
  out.push({ id: 'database', group: 'System', label: 'Database', testable: false, state: m.pending.length ? 'failing' : 'ok', detail: m.pending.length ? `Pending migrations: ${m.pending.join(', ')}` : `${m.applied.length} migrations applied.` });
  return out;
}

// Production-readiness checks shown in Settings.
async function readiness(db, { uploadDir, host = config.host } = {}) {
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  let writable = true; try { fs.accessSync(uploadDir, fs.constants.W_OK); } catch { writable = false; }
  const items = [
    { id: 'auth', level: config.appPassword ? 'ok' : loopback ? 'warn' : 'fail', label: 'Access password', detail: config.appPassword ? 'APP_PASSWORD is set.' : loopback ? 'No APP_PASSWORD. Acceptable only while the app is reachable from this computer alone.' : 'The app is network-reachable without a password. Set APP_PASSWORD.' },
    { id: 'secret', level: config.appSecret.length >= 16 ? 'ok' : 'warn', label: 'Credential encryption key', detail: config.appSecret.length >= 16 ? 'APP_SECRET is set.' : 'APP_SECRET is not set: email credentials cannot be stored.' },
    { id: 'https', level: loopback ? 'ok' : 'warn', label: 'HTTPS', detail: loopback ? 'Local use.' : 'Serve over HTTPS (reverse proxy). Basic-auth passwords are readable on plain HTTP.' },
    { id: 'ai', level: ai.isConfigured() ? 'ok' : 'warn', label: 'AI provider', detail: ai.isConfigured() ? `API key set (${ai.target().name}).` : 'No AI key: AI features are off.' },
    { id: 'source', level: providers.all.some((p) => p.enabled()) ? 'ok' : 'warn', label: 'Job source', detail: providers.all.some((p) => p.enabled()) ? 'At least one source is enabled.' : 'No source enabled. You can still add jobs by URL or pasted text.' },
    { id: 'storage', level: writable ? 'ok' : 'fail', label: 'Upload storage writable', detail: writable ? uploadDir : `Cannot write to ${uploadDir}.` },
    { id: 'profile', level: (await profileSvc.getProfile(db)).fullName ? 'ok' : 'warn', label: 'Profile filled in', detail: 'Tailoring and applications need your real profile.' },
  ];
  return { ready: !items.some((i) => i.level === 'fail'), items };
}

module.exports = { record, integrations, readiness, outcome };
