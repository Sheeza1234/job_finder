// Encrypts integration credentials (email API keys, SMTP passwords) at rest with AES-256-GCM.
// The key is derived from APP_SECRET, which lives in the environment, never in the database or the browser.
const crypto = require('crypto');
const config = require('../config');

const httpError = (status, message) => Object.assign(new Error(message), { status });
const key = () => {
  if (!config.appSecret || config.appSecret.length < 16) throw httpError(400, 'Set APP_SECRET (at least 16 characters) in the server environment before storing credentials.');
  return crypto.scryptSync(config.appSecret, 'jobfinder-credentials-v1', 32);
};

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

function decrypt(blob) {
  const [v, iv, tag, ct] = String(blob).split(':');
  if (v !== 'v1' || !ct) throw httpError(500, 'Stored credential is malformed.');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  try { return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8'); } catch { throw httpError(400, 'Cannot decrypt stored credential (APP_SECRET changed?). Re-enter it.'); }
}

// Short-lived signed download links for private files.
const signKey = () => (config.appSecret && config.appSecret.length >= 16 ? config.appSecret : (signKey.fallback = signKey.fallback || crypto.randomBytes(32).toString('hex')));
function signLink(kind, id, ttlMs = 5 * 60 * 1000, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ k: kind, i: id, e: now + ttlMs })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', signKey()).update(body).digest('base64url')}`;
}
function verifyLink(token, now = Date.now()) {
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', signKey()).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.e > now ? { kind: p.k, id: p.i } : null; } catch { return null; }
}

module.exports = { encrypt, decrypt, signLink, verifyLink };
