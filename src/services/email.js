// Email delivery through a configurable provider. Supported: Resend (HTTPS API) and any SMTP server.
// Secrets are encrypted at rest (see crypto.js) and are never returned to the browser.
// Emails contain job titles/links only; never CV content.
const { z } = require('zod');
const nodemailer = require('nodemailer');
const { encrypt, decrypt } = require('./crypto');
const settings = require('./settings');
const profileSvc = require('./profile');
const health = () => require('./health');

const KEY = 'email_config';
let transportFactory = (cfg) => nodemailer.createTransport(cfg);
const setTransportFactory = (f) => { transportFactory = f || ((cfg) => nodemailer.createTransport(cfg)); };

const schema = z.object({
  provider: z.enum(['none', 'resend', 'smtp']),
  from: z.string().trim().max(200).optional(), to: z.string().trim().email().max(200).optional().or(z.literal('')),
  resendApiKey: z.string().min(8).max(300).optional(),
  smtp: z.object({ host: z.string().trim().min(1).max(200), port: z.number().int().min(1).max(65535), secure: z.boolean(), user: z.string().max(200).optional(), password: z.string().max(500).optional() }).optional(),
});

async function save(db, input) {
  const r = schema.safeParse(input || {});
  if (!r.success) throw Object.assign(new Error(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')), { status: 400 });
  const cur = (await settings.get(db, KEY)) || {};
  const v = r.data;
  const next = { provider: v.provider, from: v.from ?? cur.from ?? '', to: v.to ?? cur.to ?? '' };
  if (v.provider === 'resend' && !(v.resendApiKey || cur.resendKey)) throw Object.assign(new Error('A Resend API key is required.'), { status: 400 });
  if (v.provider !== 'none' && !next.from) throw Object.assign(new Error('A "from" address is required.'), { status: 400 });
  next.resendKey = v.resendApiKey ? encrypt(v.resendApiKey) : cur.resendKey;           // omit to keep the stored key
  if (v.provider === 'smtp') {
    if (!v.smtp) throw Object.assign(new Error('SMTP settings are required.'), { status: 400 });
    next.smtp = { host: v.smtp.host, port: v.smtp.port, secure: v.smtp.secure, user: v.smtp.user || '',
      pass: v.smtp.password ? encrypt(v.smtp.password) : cur.smtp?.pass };
  } else if (cur.smtp) next.smtp = cur.smtp;
  await settings.set(db, KEY, next);
  return publicConfig(db);
}

async function publicConfig(db) {
  const c = (await settings.get(db, KEY)) || { provider: 'none' };
  return { provider: c.provider, from: c.from || '', to: c.to || '', hasResendKey: !!c.resendKey,
    smtp: c.smtp ? { host: c.smtp.host, port: c.smtp.port, secure: c.smtp.secure, user: c.smtp.user, hasPassword: !!c.smtp.pass } : null,
    configured: c.provider !== 'none' && !!c.from };
}

async function send(db, args) {
  const r = await deliver(db, args);
  if (!r.skipped) await health().record(db, 'email', r.ok, r.error);
  return r;
}

async function deliver(db, { subject, text }) {
  const c = await settings.get(db, KEY);
  if (!c || c.provider === 'none' || !c.from) return { ok: false, skipped: true, error: 'Email is not configured.' };
  const to = c.to || (await profileSvc.getProfile(db)).email;
  if (!to) return { ok: false, error: 'No recipient address. Set one in email settings or your profile.' };
  try {
    if (c.provider === 'resend') {
      const res = await fetch(`${process.env.RESEND_API_URL || 'https://api.resend.com'}/emails`, {
        method: 'POST', headers: { Authorization: `Bearer ${decrypt(c.resendKey)}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: c.from, to: [to], subject, text }), signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`Resend returned HTTP ${res.status}`);
      return { ok: true };
    }
    const t = transportFactory({ host: c.smtp.host, port: c.smtp.port, secure: c.smtp.secure, auth: c.smtp.user ? { user: c.smtp.user, pass: c.smtp.pass ? decrypt(c.smtp.pass) : '' } : undefined, connectionTimeout: 15000 });
    await t.sendMail({ from: c.from, to, subject, text });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { save, publicConfig, send, setTransportFactory };
