const { z } = require('zod');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const dashboard = require('../services/dashboard');
const settings = require('../services/settings');
const notifications = require('../services/notifications');
const email = require('../services/email');
const scheduler = require('../services/scheduler');
const privacy = require('../services/privacy');
const audit = require('../services/audit');
const profileSvc = require('../services/profile');
const { signLink } = require('../services/crypto');
const appMode = require('../services/appMode');
const credentials = require('../services/credentials');
const onboarding = require('../services/onboarding');
const health = require('../services/health');
const providers = require('../providers');
const ai = require('../services/ai');

// Dashboard, CV Studio, search/notification/email settings, scheduler, notifications, privacy, audit.
module.exports = function dashboardRoutes(app, { db, httpError, uploadDir }) {
  app.get('/api/dashboard', async (_req, res) => res.json(await dashboard.build(db, await profileSvc.getProfile(db))));
  app.get('/api/cv-studio', async (_req, res) => res.json(await dashboard.studio(db)));
  app.get('/api/cv-versions/:vid/history', async (req, res) => res.json((await dashboard.history(db, Number(req.params.vid))) || (() => { throw httpError(404, 'Version not found'); })()));

  // ---- master CV + private downloads
  app.post('/api/documents/:id/master', async (req, res) => {
    const d = await db.prepare('SELECT id, kind FROM documents WHERE id = ?').get(Number(req.params.id));
    if (!d) throw httpError(404, 'Document not found');
    if (d.kind !== 'cv') throw httpError(400, 'Only a CV can be the master CV.');
    await db.transaction(async () => { await db.prepare("UPDATE documents SET is_master = false WHERE kind = 'cv'").run(); await db.prepare('UPDATE documents SET is_master = true WHERE id = ?').run(d.id); });
    res.json({ master: d.id });
  });
  app.post('/api/documents/:id/link', async (req, res) => {       // short-lived signed link (5 minutes)
    if (!(await db.prepare('SELECT 1 FROM documents WHERE id = ?').get(Number(req.params.id)))) throw httpError(404, 'Document not found');
    res.json({ url: `/dl/${signLink('document', Number(req.params.id))}`, expires_in_seconds: 300 });
  });

  // ---- search settings + scheduler
  app.get('/api/settings/search', async (_req, res) => res.json(await settings.getSearch(db)));
  app.put('/api/settings/search', async (req, res) => res.json(await settings.saveSearch(db, req.body)));
  app.get('/api/scheduler', async (_req, res) => res.json(await scheduler.status(db)));
  // Manual "search now". Discovery only: it never applies to anything.
  app.post('/api/scheduler/run', async (_req, res) => res.json(await scheduler.runSearchJob(db, { actor: 'user' })));

  // ---- notifications
  app.get('/api/settings/notifications', async (_req, res) => res.json(await settings.getNotify(db)));
  app.put('/api/settings/notifications', async (req, res) => res.json(await settings.saveNotify(db, req.body)));
  app.get('/api/notifications', async (req, res) => res.json({ unread: await notifications.unreadCount(db), items: await notifications.list(db, { unread: req.query.unread === 'true', limit: req.query.limit }) }));
  app.post('/api/notifications/read-all', async (_req, res) => { await notifications.markAllRead(db); res.status(204).end(); });
  app.post('/api/notifications/:id/read', async (req, res) => { await notifications.markRead(db, req.params.id); res.status(204).end(); });
  app.delete('/api/notifications/:id', async (req, res) => { await notifications.remove(db, req.params.id); res.status(204).end(); });

  // ---- email provider (secrets are write-only)
  app.get('/api/settings/email', async (_req, res) => res.json({ ...(await email.publicConfig(db)), secretsEnabled: config.appSecret.length >= 16 }));
  app.put('/api/settings/email', async (req, res) => res.json(await email.save(db, req.body)));
  app.post('/api/settings/email/test', async (_req, res) => {
    const r = await email.send(db, { subject: 'Test from Saudi Job Finder', text: 'Email notifications are working. No CV or personal documents are ever included in these emails.' });
    res.status(r.ok ? 200 : 422).json(r.ok ? { ok: true } : { error: r.error });
  });

  // ---- job-source keys (write-only; stored encrypted)
  app.get('/api/settings/job-sources', async (_req, res) => res.json(await credentials.status(db, { jooble: config.joobleKey, jooble_pk: config.joobleKeyPk, jsearch: config.rapidApiKey })));
  app.put('/api/settings/job-sources/:id', async (req, res) => {
    await credentials.set(db, req.params.id, req.body?.key);
    await audit.audit(db, 'job_source_key_changed', { entity: 'job_source', entityId: req.params.id });
    res.json(await credentials.status(db, { jooble: config.joobleKey, jooble_pk: config.joobleKeyPk, jsearch: config.rapidApiKey }));
  });

  // ---- demo / production mode
  app.get('/api/app-mode', async (_req, res) => res.json({ mode: await appMode.getMode(db) }));
  app.put('/api/app-mode', async (req, res) => res.json(await appMode.setMode(db, req.body?.mode)));

  // ---- onboarding, integration status, readiness
  app.get('/api/onboarding', async (_req, res) => res.json(await onboarding.status(db)));
  app.post('/api/onboarding/dismiss', async (_req, res) => { await onboarding.dismiss(db); res.status(204).end(); });
  app.get('/api/integrations', async (_req, res) => res.json(await health.integrations(db)));
  app.get('/api/readiness', async (_req, res) => res.json(await health.readiness(db, { uploadDir })));
  // Connection test. Sends no personal data: a tiny search query, a one-word AI ping, or a test email.
  app.post('/api/integrations/:id/test', async (req, res) => {
    const id = req.params.id;
    const market = id === 'jooble_pk' ? 'PK' : 'SA';                 // the Pakistan Jooble key is tested on its own country address
    const p = providers.all.find((x) => x.id === (id === 'jooble_pk' ? 'jooble' : id));
    try {
      if (p) {
        if (p.supports ? !p.supports({ market }) : !p.enabled()) throw httpError(422, 'This source is not configured.');
        const jobs = await p.search({ keyword: 'designer', city: market === 'PK' ? 'Lahore' : 'Riyadh', remote: false, market });
        await health.record(db, id, true); return res.json({ ok: true, detail: `Reached ${p.label}; ${jobs.length} result(s) for a sample query.` });
      }
      if (id === 'ai') {
        const out = await ai.completeText({ system: 'Reply with the single word OK.', user: 'ping', maxTokens: 5 });
        return res.json({ ok: true, detail: `The model replied: ${out.trim().slice(0, 40)}` });
      }
      if (id === 'email') {
        const r = await require('../services/email').send(db, { subject: 'Integration test', text: 'Email delivery works.' });
        if (!r.ok) throw httpError(422, r.error || 'Email failed');
        return res.json({ ok: true, detail: 'Test email accepted by the provider.' });
      }
    } catch (e) {
      if (p) await health.record(db, id, false, e.message);
      // A refusal from the job site is not an app bug: say what it means instead of "Internal server error".
      const http = !e.status && /^HTTP (\d{3}) from/.exec(e.message);
      if (p && http) {
        const code = Number(http[1]);
        throw httpError(502, code === 401 || code === 403
          ? `${p.label} refused the request (HTTP ${code}). The key may be wrong or not activated yet, or this network may be blocked by the site. Check the key in the email they sent you, or try again later.`
          : `${p.label} could not be reached (HTTP ${code}). Try again in a minute.`);
      }
      throw e;
    }
    throw httpError(400, 'This integration has no connection test.');
  });

  // ---- privacy
  app.get('/api/privacy', async (_req, res) => res.json({ consent: await privacy.getConsent(db), disclosure: privacy.DISCLOSURE }));
  app.post('/api/privacy/consent', async (req, res) => {
    const r = z.object({ ai: z.boolean() }).safeParse(req.body);
    if (!r.success) throw httpError(400, 'ai must be true or false');
    await audit.audit(db, r.data.ai ? 'ai_consent_given' : 'ai_consent_withdrawn', { entity: 'privacy' });
    res.json(await privacy.setConsent(db, r.data.ai));
  });
  app.get('/api/privacy/export', async (_req, res) => {
    await audit.audit(db, 'data_export', { entity: 'privacy' });
    res.set({ 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="my-data.json"' }).send(JSON.stringify(await privacy.exportAll(db), null, 2));
  });
  app.delete('/api/privacy/data', async (req, res) => {
    if (req.body?.confirm !== 'DELETE MY DATA') throw httpError(400, 'Send {"confirm":"DELETE MY DATA"} to confirm.');
    await require('../services/browserAssist').closeAll();
    res.json(await privacy.deleteAll(db, uploadDir));
  });
  app.get('/api/audit', async (req, res) => res.json(await audit.recent(db, { entity: req.query.entity, entityId: req.query.entity_id, limit: req.query.limit })));
};
