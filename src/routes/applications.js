const config = require('../config');
const profileSvc = require('../services/profile');
const apps = require('../services/applications');
const policy = require('../services/automationPolicy');
const assist = require('../services/browserAssist');
const auto = require('../services/autoSubmit');
const { checkListing } = require('../services/importJob');

// Tracker, application modes A (manual), B (browser-assisted), C (approved automatic submission).
module.exports = function applicationRoutes(app, { db, needJob, httpError }) {
  const profile = () => profileSvc.getProfile(db);   // async

  // ---- tracker
  app.get('/api/applications', async (req, res) => res.json(await apps.list(db, await profile(), req.query)));
  app.get('/api/applications/export.csv', async (req, res) => {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="applications.csv"' }).send(apps.toCsv(await apps.list(db, await profile(), req.query)));
  });
  app.post('/api/applications', async (req, res) => {   // "track this job" without changing anything else
    const job = await needJob({ params: { id: req.body?.job_id } });
    await apps.ensure(db, job.id);
    res.status(201).json(await apps.update(db, job.id, req.body?.status ? { status: req.body.status } : {}));
  });
  app.get('/api/applications/:id', async (req, res) => { const j = await needJob(req); await apps.ensure(db, j.id); res.json(await apps.get(db, j.id)); });
  app.put('/api/applications/:id', async (req, res) => res.json(await apps.update(db, (await needJob(req)).id, req.body || {})));
  app.get('/api/applications/:id/duplicates', async (req, res) => res.json(await apps.duplicates(db, await needJob(req))));
  app.post('/api/jobs/:id/check-listing', async (req, res) => res.json(await checkListing((await needJob(req)).url || '')));

  // ---- Mode A: manual assistance
  app.get('/api/applications/:id/checklist', async (req, res) => {
    const job = await needJob(req); await apps.ensure(db, job.id);
    res.json(await apps.checklistFor(db, job, await profile(), await apps.get(db, job.id)));
  });
  app.post('/api/applications/:id/mark-submitted', async (req, res) => {
    const job = await needJob(req); await apps.ensure(db, job.id);
    res.json(await apps.markSubmitted(db, job.id, req.body || {}));
  });

  // ---- which modes are available for this job, and why not
  app.get('/api/applications/:id/modes', async (req, res) => {
    const job = await needJob(req);
    const pol = job.url ? policy.assistPolicy(job.url) : { allowed: false, message: 'This job has no URL.' };
    const adapter = job.url && auto.findAdapter(job.url);
    res.json({
      manual: { available: true },
      assisted: { available: pol.allowed && !!config.chromePath, reason: !pol.allowed ? pol.message : !config.chromePath ? 'No Chrome/Chromium found on the server (set CHROME_PATH). Browser assistance opens a visible window, so it only works when the app runs on your own computer.' : '' },
      automatic: { available: !!adapter, adapter: adapter ? adapter.id : null, preapproved: adapter ? (await auto.getPreapproved(db)).includes(adapter.id) : false,
        reason: adapter ? '' : 'No adapter exists for this site. Automatic submission is only offered where the site explicitly permits it.' },
    });
  });

  // ---- Mode B: browser-assisted
  app.post('/api/applications/:id/assist/start', async (req, res) => res.json(await assist.start(db, (await needJob(req)).id, { format: req.body?.format === 'docx' ? 'docx' : 'pdf' })));
  app.post('/api/assist/:sid/rescan', async (req, res) => res.json(await assist.rescan(db, req.params.sid)));
  app.get('/api/assist/:sid/summary', async (req, res) => res.json(await assist.summary(req.params.sid)));
  app.delete('/api/assist/:sid', async (req, res) => { await assist.close(req.params.sid); res.status(204).end(); });

  // ---- Mode C: approved automatic submission (only for registered, explicitly permitted adapters)
  app.get('/api/auto-submit/adapters', async (_req, res) => res.json({ adapters: auto.listAdapters(), preapproved: await auto.getPreapproved(db) }));
  app.put('/api/auto-submit/preapproved', async (req, res) => {
    if (!Array.isArray(req.body?.adapters)) throw httpError(400, 'adapters must be an array');
    res.json({ preapproved: await auto.setPreapproved(db, req.body.adapters.map(String)) });
  });
  app.post('/api/applications/:id/auto-submit/prepare', async (req, res) => res.json(await auto.prepare(db, (await needJob(req)).id, { format: req.body?.format, retry: !!req.body?.retry })));
  app.post('/api/applications/:id/auto-submit/confirm', async (req, res) => res.json(await auto.submit(db, (await needJob(req)).id, { approvalToken: req.body?.approvalToken, format: req.body?.format, retry: !!req.body?.retry })));
};
