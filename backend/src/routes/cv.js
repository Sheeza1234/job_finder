const profileSvc = require('../services/profile');
const assistant = require('../services/assistant');
const versions = require('../services/versions');
const files = require('../services/files');
const apps = require('../services/applications');

const tryJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// Tailored CV and cover-letter versions: generate, preview, edit, compare, approve, download.
module.exports = function cvRoutes(app, { db, needJob, httpError }) {
  const sendFile = (res, f) => res.set({ 'Content-Type': f.mime, 'Content-Disposition': `attachment; filename="${f.filename}"`, 'X-Document-Approved': String(f.approved) }).send(f.buffer);
  const detail = ({ profile_snapshot, ...v }) => ({ ...v, model: versions.cvModel({ profile_snapshot, content: v.content }) });
  // An approval is the user's intent to use that version, unless the application was already submitted.
  const link = async (jobId, patch) => { const a = await apps.get(db, jobId); if (!a?.applied_at) await apps.update(db, jobId, patch); };

  // ---- CV
  app.get('/api/jobs/:id/cv-versions', async (req, res) => res.json(await versions.listCv(db, (await needJob(req)).id)));

  app.post('/api/jobs/:id/tailor', async (req, res) => {
    const job = await needJob(req);
    const profile = await profileSvc.getProfile(db);
    if (!profile.experience.length && !profile.skills.length) throw httpError(422, 'Fill in your profile (experience or skills) before tailoring a CV.');
    const a = await db.prepare('SELECT data FROM analyses WHERE job_id = ?').get(job.id);
    const result = await assistant.tailorCv(profile, job, a && tryJson(a.data));
    const v = await versions.createCvVersion(db, { job, profile, result });
    await apps.syncFromVersions(db, job.id);
    res.status(201).json({ ...detail(v), notes: result.notes });
  });

  app.get('/api/cv-versions/:vid', async (req, res) => res.json(detail(await versions.needCv(db, req.params.vid))));
  app.put('/api/cv-versions/:vid', async (req, res) => {
    const v = await versions.editCv(db, req.params.vid, req.body || {});
    await apps.syncFromVersions(db, v.job_id);
    res.json(detail(v));
  });
  app.post('/api/cv-versions/:vid/approve', async (req, res) => {
    const v = await versions.approveCv(db, req.params.vid, { acknowledge: !!req.body?.acknowledge });
    await apps.syncFromVersions(db, v.job_id); await link(v.job_id, { cv_version_id: v.id });
    res.json(detail(v));
  });
  app.post('/api/cv-versions/:vid/revoke', async (req, res) => {
    const v = await versions.revokeCv(db, req.params.vid);
    await apps.syncFromVersions(db, v.job_id);
    res.json(detail(v));
  });
  app.delete('/api/cv-versions/:vid', async (req, res) => {
    const v = await versions.needCv(db, req.params.vid);
    await versions.deleteVersion(db, 'cv', v.id); await apps.syncFromVersions(db, v.job_id);
    res.status(204).end();
  });
  app.get('/api/cv-versions/:vid/compare', async (req, res) => res.json(await versions.compare(db, req.params.vid, req.query.to || 'original')));
  app.get('/api/cv-versions/:vid/download', async (req, res) => sendFile(res, await files.cvFile(db, req.params.vid, req.query.format || 'pdf')));

  // ---- cover letters
  app.get('/api/jobs/:id/letters', async (req, res) => res.json(await versions.listLetters(db, (await needJob(req)).id)));

  app.post('/api/jobs/:id/cover-letter', async (req, res) => {
    const job = await needJob(req);
    const profile = await profileSvc.getProfile(db);
    if (!profile.fullName) throw httpError(422, 'Add your full name to the profile first.');
    const a = await db.prepare('SELECT data FROM analyses WHERE job_id = ?').get(job.id);
    const language = req.body?.language === 'ar' ? 'ar' : 'en';
    const out = await assistant.writeCoverLetter(profile, job, { language, tone: req.body?.tone, analysis: a && tryJson(a.data) });
    const warnings = [...out.warnings, ...versions.letterWarnings(profile, out.letter).filter((w) => !out.warnings.includes(w) && !/figure/.test(w))];
    res.status(201).json(await versions.createLetter(db, { job, text: out.letter, language, warnings }));
  });
  app.get('/api/letters/:lid', async (req, res) => res.json(await versions.needLetter(db, req.params.lid)));
  app.put('/api/letters/:lid', async (req, res) => res.json(await versions.editLetter(db, req.params.lid, req.body?.text, await profileSvc.getProfile(db))));
  app.post('/api/letters/:lid/approve', async (req, res) => {
    const l = await versions.approveLetter(db, req.params.lid, { acknowledge: !!req.body?.acknowledge });
    await link(l.job_id, { letter_version_id: l.id });
    res.json(l);
  });
  app.post('/api/letters/:lid/revoke', async (req, res) => res.json(await versions.revokeLetter(db, req.params.lid)));
  app.delete('/api/letters/:lid', async (req, res) => { await versions.deleteVersion(db, 'letter', (await versions.needLetter(db, req.params.lid)).id); res.status(204).end(); });
  app.get('/api/letters/:lid/download', async (req, res) => sendFile(res, await files.letterFile(db, req.params.lid, req.query.format || 'pdf', await profileSvc.getProfile(db))));
};
