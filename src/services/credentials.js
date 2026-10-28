// Job-source API keys entered in the app (stored encrypted with APP_SECRET, write-only). Environment variables still work;
// a key saved here takes precedence. Keys are cached in memory so providers can read them synchronously.
const settings = require('./settings');
const { encrypt, decrypt } = require('./crypto');

const KEY = 'provider_keys';
const cache = new Map();
const SOURCES = {
  jooble: { label: 'Jooble', signup: 'https://jooble.org/api/about', free: true, help: 'Free. Request an API key on the Jooble page, then paste it here. This is the quickest way to get jobs in Saudi cities.' },
  jooble_pk: { label: 'Jooble Pakistan', signup: 'https://pk.jooble.org/api/about', free: true, help: 'Free. Jooble keys belong to one country, so Pakistan needs its own key: request it on the Pakistan Jooble page, then paste it here.' },
  jsearch: { label: 'JSearch (RapidAPI)', signup: 'https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch', free: false, help: 'Google-for-Jobs results. Has a small free plan; paid beyond it.' },
};

async function load(db) {
  const all = (await settings.get(db, KEY)) || {};
  cache.clear();
  for (const [id, enc] of Object.entries(all)) { try { cache.set(id, decrypt(enc)); } catch { /* APP_SECRET changed: the key must be re-entered */ } }
}
const get = (id) => cache.get(id) || '';

async function set(db, id, key) {
  if (!SOURCES[id]) throw Object.assign(new Error('Unknown job source.'), { status: 404 });
  const k = String(key || '').trim();
  if (k && (k.length < 8 || k.length > 200 || /\s/.test(k))) throw Object.assign(new Error('That does not look like an API key (8-200 characters, no spaces).'), { status: 400 });
  const all = (await settings.get(db, KEY)) || {};
  if (k) all[id] = encrypt(k); else delete all[id];       // empty = remove
  await settings.set(db, KEY, all);
  if (k) cache.set(id, k); else cache.delete(id);
}

// Never returns the key itself.
async function status(db, envKeys) {
  const stored = (await settings.get(db, KEY)) || {};
  return Object.entries(SOURCES).map(([id, s]) => ({ id, ...s, hasKey: !!stored[id] || !!envKeys[id], from: stored[id] ? 'app' : envKeys[id] ? 'env' : null }));
}

module.exports = { load, get, set, status, SOURCES };
