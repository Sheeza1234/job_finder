const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const helmet = require('helmet');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const ai = require('./services/ai');
const providers = require('./providers');
const profileSvc = require('./services/profile');
const jobsStore = require('./services/jobsStore');
const { runSearch } = require('./services/search');
const { MARKETS, ALL_CITIES } = require('./markets');
const settingsSvc = require('./services/settings');
const assistant = require('./services/assistant');
const { validateUpload, safeExtract } = require('./services/extract');
const { requestLogger, audit } = require('./services/audit');
const { verifyLink } = require('./services/crypto');
const privacySvc = require('./services/privacy');
const cvImport = require('./services/cvImport');
const titlesSvc = require('./services/titles');
const { importJob } = require('./services/importJob');
const applicationsSvc = require('./services/applications');
const versionsSvc = require('./services/versions');

const KINDS = ['cv', 'portfolio', 'certificate', 'project', 'other'];
const ALLOWED_EXT = ['.pdf', '.docx', '.txt', '.md', '.png', '.jpg', '.jpeg'];

const httpError = (status, message) => Object.assign(new Error(message), { status });
const tryJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// Basic auth with a failure throttle: 10 bad attempts per IP per 15 minutes, then 429.
const failures = new Map();
function basicAuth(req, res, next) {
  if (!config.appPassword) return next();
  const ip = req.ip; const f = failures.get(ip);
  if (f && f.count >= 10 && Date.now() - f.first < 15 * 60 * 1000) return res.status(429).send('Too many failed attempts. Try again later.');
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && token) {
    const pass = Buffer.from(token, 'base64').toString().split(':').slice(1).join(':');
    const a = Buffer.from(pass); const b = Buffer.from(config.appPassword);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) { failures.delete(ip); return next(); }
    const cur = f && Date.now() - f.first < 15 * 60 * 1000 ? f : { count: 0, first: Date.now() };
    failures.set(ip, { ...cur, count: cur.count + 1 });
  }
  res.set('WWW-Authenticate', 'Basic realm="Job Finder"').status(401).send('Authentication required');
}

// AI calls send profile/job data to Anthropic; they only run after the user has consented.
const AI_PATHS = [/^\/api\/jobs\/\d+\/(analyze|tailor|cover-letter)$/, /^\/api\/profile\/(import-cv|auto-fill|suggest-titles)$/];
function requireAiConsent(db) {
  return async (req, res, next) => {
    // auto-fill with useAi:false is local-only extraction (nothing is sent anywhere), so it needs no consent
    const localOnly = /^\/api\/profile\/(auto-fill|suggest-titles)$/.test(req.path) && req.body?.useAi === false;
    if (req.method === 'POST' && AI_PATHS.some((re) => re.test(req.path)) && !localOnly && !(await privacySvc.getConsent(db)).ai) {
      return res.status(403).json({ error: 'Consent needed before sending your data to the AI provider.', code: 'consent_required', disclosure: privacySvc.DISCLOSURE.ai });
    }
    next();
  };
}

function createApp(db, { uploadDir = path.join(config.dataDir, 'uploads') } = {}) {
  fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    dest: uploadDir, limits: { fileSize: Math.max(1, Math.floor(config.maxUploadMb * 1024 * 1024)) },
    fileFilter: (_req, file, cb) => cb(ALLOWED_EXT.includes(path.extname(file.originalname).toLowerCase()) ? null : httpError(400, `Unsupported file type. Allowed: ${ALLOWED_EXT.join(', ')}`), true),
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], frameSrc: ["'self'"], objectSrc: ["'none'"], upgradeInsecureRequests: null } } }));
  if (config.trustProxy) app.set('trust proxy', config.trustProxy === 'true' ? true : Number(config.trustProxy) || config.trustProxy);
  app.get('/healthz', (_req, res) => res.json({ ok: true }));   // liveness only: no data, no auth, for container health checks
  app.use(basicAuth);
  app.use(express.json({ limit: '2mb' }));
  app.use(requestLogger(db));
  app.use(requireAiConsent(db));
  app.get('/dl/:token', async (req, res) => {
    const p = verifyLink(req.params.token);
    const d = p && p.kind === 'document' && await db.prepare('SELECT * FROM documents WHERE id = ?').get(p.id);
    if (!d) return res.status(410).send('This download link is invalid or has expired.');
    res.set('X-Content-Type-Options', 'nosniff').download(storedPath(d.stored_name), d.filename);
  });
  app.use(express.static(path.join(config.root, 'public')));

  // Stored names are random, but never trust a path that came out of the database.
  const storedPath = (name) => {
    const p = path.resolve(uploadDir, String(name));
    if (!p.startsWith(path.resolve(uploadDir) + path.sep)) throw httpError(400, 'Invalid file reference.');
    return p;
  };
  // Saved job-source keys are read once at start-up; the first request waits for that to finish.
  const keysLoaded = require('./services/credentials').load(db).catch(() => { /* no APP_SECRET or unreadable keys: re-enter in Settings */ });
  app.use((_req, _res, next) => keysLoaded.then(() => next()));
  const needJob = async (req) => (await jobsStore.getJob(db, Number(req.params.id))) || (() => { throw httpError(404, 'Job not found'); })();

  // ---- meta / status
  app.get('/api/status', async (_req, res) => res.json({ ai: ai.isConfigured(), model: config.aiModel, ai_target: ai.target(), providers: providers.status(), browserAssist: !!config.chromePath, mode: await jobsStore.getMode(db) }));
    app.get('/api/meta', (_req, res) => res.json({ categories: profileSvc.DEFAULT_CATEGORIES, cities: ALL_CITIES, markets: Object.values(MARKETS).map(({ code, country, cities }) => ({ code, country, cities })), statuses: applicationsSvc.STATUSES }));

  // ---- profile
  app.get('/api/profile', async (_req, res) => res.json(await profileSvc.getProfile(db)));
  app.put('/api/profile', async (req, res) => res.json(await profileSvc.saveProfile(db, req.body)));

  app.post('/api/profile/import-cv', async (req, res) => {
    const doc = await db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.body.documentId));
    if (!doc) throw httpError(404, 'Document not found');
    if (!doc.text) throw httpError(422, 'No text could be extracted from this document');
    // Returned as a draft only; nothing is saved until the user reviews and saves.
    res.json({ draft: profileSvc.normalize(await assistant.parseCvToProfile(doc.text)) });
  });

  // Fill the profile from the (master) CV. Only empty fields are filled; the previous profile is kept for undo.
  app.post('/api/profile/auto-fill', async (req, res) => {
    const id = Number(req.body?.documentId);
    const doc = id ? await db.prepare('SELECT * FROM documents WHERE id = ?').get(id)
      : await db.prepare("SELECT * FROM documents WHERE kind = 'cv' AND length(text) > 0 ORDER BY is_master DESC, id DESC").get();
    if (!doc) throw httpError(404, 'Upload a CV first.');
    if (!doc.text) throw httpError(422, 'No text could be read from this CV (is it a scanned image?). Please fill in your profile manually.');
    let draft = cvImport.basicExtract(doc.text);
    let rawAi = null;
    const ai_info = { used: false, note: '' };
    if (req.body?.useAi === false) ai_info.note = 'Only contact details and links were read locally; nothing was sent to an AI provider.';
    else if (!ai.isConfigured()) ai_info.note = 'AI is not configured, so only contact details and links were read. Add an AI key to read experience, education and skills.';
    else {
      // Models occasionally return broken JSON or a gateway hiccups; one automatic retry fixes most of those.
      for (let attempt = 1; attempt <= 2 && !ai_info.used; attempt++) {
        try { rawAi = await assistant.parseCvToProfile(doc.text); draft = cvImport.layer(rawAi, draft); ai_info.used = true; ai_info.note = ''; }
        catch (e) { ai_info.failed = true; ai_info.note = `AI reading failed (${e.message}); only contact details and links were read. You can retry.`; }
      }
      if (ai_info.used) delete ai_info.failed;
    }
    const before = await profileSvc.getProfile(db);
    const { merged, filled, missing } = cvImport.mergeDraft(before, draft);
    // Keywords found in the CV, and target-title tags suggested from them (AI with evidence checks, else offline rules).
    const sugg = rawAi ? titlesSvc.validateAi(rawAi, merged, doc.text) : { keywords: [], suggestions: [] };
    const local = titlesSvc.suggestLocal(merged, doc.text);
    const suggestions = sugg.suggestions.length ? sugg.suggestions : local.suggestions;
    const keywords = sugg.keywords.length ? sugg.keywords : local.keywords;
    const keywordsChanged = JSON.stringify(keywords) !== JSON.stringify(merged.cvKeywords);
    merged.cvKeywords = keywords;
    let titlesAdded = 0;
    if (!profileSvc.targetTitles(before).length && suggestions.length) { merged.preferredTitles = suggestions.map((x) => x.title); titlesAdded = suggestions.length; filled.push(`Target job titles (${titlesAdded} suggested)`); }
    if (filled.length || keywordsChanged) {
      if (filled.length) await cvImport.saveBackup(db, before, doc.filename);
      await profileSvc.saveProfile(db, merged);
    }
    res.json({ filled, missing, profile: merged, suggestions, keywords, ai: ai_info, document: { id: doc.id, filename: doc.filename } });
  });
  // Suggest target job titles from the CV keywords. Returns suggestions only; the user decides which become tags.
  app.post('/api/profile/suggest-titles', async (req, res) => {
    const profile = await profileSvc.getProfile(db);
    const doc = await db.prepare("SELECT * FROM documents WHERE kind = 'cv' AND length(text) > 0 ORDER BY is_master DESC, id DESC").get();
    const text = doc?.text || '';
    let out = titlesSvc.suggestLocal(profile, text); const info = { used: false, note: '' };
    if (req.body?.useAi === false) info.note = 'Suggested from keywords in your CV using local rules; nothing was sent to an AI provider.';
    else if (!ai.isConfigured()) info.note = 'AI is not configured, so these come from local keyword rules.';
    else {
      try { const v = titlesSvc.validateAi(await assistant.suggestTitles(profile, text), profile, text); if (v.suggestions.length) { out = v; info.used = true; } else info.note = 'The AI gave no evidence-backed titles, so local keyword rules were used.'; }
      catch (e) { info.note = `AI suggestion failed (${e.message}); local keyword rules were used.`; }
    }
    res.json({ keywords: out.keywords, suggestions: out.suggestions, ai: info });
  });
  app.post('/api/profile/undo-import', async (_req, res) => res.json({ profile: await cvImport.undo(db) }));
  app.get('/api/profile/status', async (_req, res) => res.json({ missing: cvImport.missingFields(await profileSvc.getProfile(db)), import: await cvImport.importStatus(db) }));

  // ---- documents
  app.get('/api/documents', async (_req, res) => res.json(await db.prepare('SELECT id, kind, filename, mime, is_master, created_at, length(text) AS text_chars FROM documents ORDER BY id DESC').all()));
  app.post('/api/documents', upload.single('file'), async (req, res) => {
    if (!req.file) throw httpError(400, 'No file uploaded');
    const kind = KINDS.includes(req.body.kind) ? req.body.kind : 'other';
    const original = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    try { validateUpload(req.file.path, path.extname(original)); } catch (e) { fs.rmSync(req.file.path, { force: true }); throw e; }
    let text = '';
    try { text = await safeExtract(req.file.path, original); } catch { /* stored anyway; text stays empty */ }
    const r = await db.prepare('INSERT INTO documents (kind, filename, mime, stored_name, text, created_at) VALUES (?,?,?,?,?,?)')
      .run(kind, original, req.file.mimetype, req.file.filename, text, new Date().toISOString());
    if (kind === 'cv' && !(await db.prepare("SELECT 1 FROM documents WHERE kind = 'cv' AND is_master = true").get())) await db.prepare('UPDATE documents SET is_master = true WHERE id = ?').run(r.lastInsertRowid);
    res.status(201).json({ id: r.lastInsertRowid, kind, filename: original, text_chars: text.length });
  });
  app.get('/api/documents/:id/download', async (req, res) => {
    const d = await db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
    if (!d) throw httpError(404, 'Not found');
    res.set('X-Content-Type-Options', 'nosniff').download(storedPath(d.stored_name), d.filename);
  });
  app.delete('/api/documents/:id', async (req, res) => {
    const d = await db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
    if (d) { fs.rmSync(storedPath(d.stored_name), { force: true }); await db.prepare('DELETE FROM documents WHERE id = ?').run(d.id); }
    res.status(204).end();
  });

  // ---- jobs
  app.post('/api/jobs/search', async (req, res) => {
    const profile = await profileSvc.getProfile(db);
    const b = req.body || {};
    res.json(await runSearch(db, {
      categories: b.categories?.length ? b.categories : require('./services/match').searchTitles(profile),
      relevance: (j) => require('./services/match').isRelevant(profile, j),
      cities: b.cities?.length ? b.cities : profile.preferences.cities,
      markets: b.markets?.length ? b.markets : (await settingsSvc.getSearch(db)).markets,
      includeRemote: b.includeRemote, arabic: b.arabic, maxQueries: b.maxQueries,
    }));
  });
  app.get('/api/jobs', async (req, res) => res.json(await jobsStore.listJobs(db, req.query, await profileSvc.getProfile(db))));
  // Remove stored jobs that do not fit the profile. Never touches jobs the user added by hand or is tracking.
  app.post('/api/jobs/cleanup', async (req, res) => {
    const ids = await jobsStore.irrelevantIds(db, await profileSvc.getProfile(db));
    if (req.body?.dryRun) return res.json({ count: ids.length });
    if (ids.length) await db.prepare('DELETE FROM jobs WHERE id = ANY(?::int[])').run(ids);
    await audit(db, 'jobs_cleanup', { entity: 'jobs', detail: { removed: ids.length } });
    res.json({ count: ids.length });
  });
  app.get('/api/jobs/facets', async (_req, res) => res.json(await jobsStore.facets(db)));
  app.post('/api/jobs/import', async (req, res) => {
    const id = await importJob(db, req.body || {}).catch((e) => { throw httpError(422, e.message); });
    res.status(201).json({ id });
  });
  app.get('/api/jobs/:id', async (req, res) => {
    const job = await needJob(req);
    const a = await db.prepare('SELECT * FROM analyses WHERE job_id = ?').get(job.id);
    const ap = await applicationsSvc.get(db, job.id);
    res.json({
      job,
      heuristic: require('./services/match').matchJob(await profileSvc.getProfile(db), job),
      analysis: a ? { score: a.score, method: a.method, created_at: a.created_at, ...tryJson(a.data) } : null,
      application: ap,
      also_listed_on: await jobsStore.alsoListedOn(db, job.id),
      cv_versions: await versionsSvc.listCv(db, job.id),
      letters: await versionsSvc.listLetters(db, job.id),
    });
  });
  app.delete('/api/jobs/:id', async (req, res) => { await db.prepare('DELETE FROM jobs WHERE id = ?').run(Number(req.params.id)); res.status(204).end(); });

  app.post('/api/jobs/:id/analyze', async (req, res) => {
    const job = await needJob(req);
    const { score, data } = await assistant.analyzeJob(await profileSvc.getProfile(db), job);
    await jobsStore.saveAnalysis(db, job.id, score, data);
    res.json({ score, method: 'ai', ...data });
  });

  require('./routes/cv')(app, { db, needJob, httpError });
  require('./routes/applications')(app, { db, needJob, httpError });
  require('./routes/dashboard')(app, { db, httpError, uploadDir });

  app.use('/api', (_req, _res, next) => next(httpError(404, 'Not found')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const aiErr = err instanceof Anthropic.APIError;
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : err.name === 'SyntaxError' ? 400 : 500);
    if (!aiErr && status === 500) console.error(err);          // unexpected: log server-side only
    const message = aiErr ? `AI provider error: ${err.message}` : status === 500 ? 'Internal server error' : err.message;
    res.status(aiErr ? 502 : status).json({ error: message, ...(err.duplicates && { duplicates: err.duplicates }) });
  });
  return app;
}

module.exports = { createApp };
