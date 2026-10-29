// Append-only audit trail. Records what happened and when, never request bodies, CV text or credentials.
const insert = (db, row) => db.prepare('INSERT INTO audit_logs (at, actor, action, entity, entity_id, detail) VALUES (?,?,?,?,?,?)')
  .run(new Date().toISOString(), row.actor || 'user', row.action, row.entity || null, row.entityId != null ? String(row.entityId) : null, JSON.stringify(row.detail || {}));

async function audit(db, action, o = {}) { try { await insert(db, { action, ...o }); } catch { /* auditing must never break the request */ } }

// Map "METHOD /api/path" to a readable action + entity for the automatic request log.
const ENTITY = [[/^\/api\/cv-versions\/(\d+)/, 'cv_version'], [/^\/api\/letters\/(\d+)/, 'cover_letter'], [/^\/api\/applications\/(\d+)/, 'application'],
  [/^\/api\/jobs\/(\d+)/, 'job'], [/^\/api\/documents\/(\d+)/, 'document'], [/^\/api\/assist\/([a-f0-9]+)/, 'assist_session']];

function requestLogger(db) {
  return (req, res, next) => {
    res.on('finish', () => {
      if (req.method === 'GET' || req.method === 'HEAD' || !req.path.startsWith('/api') || res.statusCode >= 400) return;
      let entity = null; let id = null;
      for (const [re, name] of ENTITY) { const m = re.exec(req.path); if (m) { entity = name; id = m[1]; break; } }
      db.track(audit(db, `${req.method} ${req.path.replace(/\/\d+/g, '/:id')}`, { entity, entityId: id, detail: { status: res.statusCode } }));
    });
    next();
  };
}

const recent = async (db, { entity, entityId, limit = 100 } = {}) => (await db.prepare(
  `SELECT * FROM audit_logs ${entity ? 'WHERE entity = ? AND entity_id = ?' : ''} ORDER BY id DESC LIMIT ?`)
  .all(...(entity ? [entity, String(entityId)] : []), Math.min(Number(limit) || 100, 500))).map((r) => ({ ...r, detail: JSON.parse(r.detail) }));

module.exports = { audit, requestLogger, recent };
