const settings = require('./settings');
const email = require('./email');

const hydrate = (r) => r && { ...r, payload: JSON.parse(r.payload || '{}') };
const APP_URL = () => (process.env.APP_BASE_URL || '').replace(/\/$/, '');

// Creates an in-app notification (once per dedupeKey) and, if enabled, emails it. Returns the row or null if it already existed.
async function notify(db, { kind, title, body = '', jobId = null, payload = {}, dedupeKey = null }) {
  const prefs = await settings.getNotify(db);
  const now = new Date().toISOString();
  const r = await db.prepare('INSERT OR IGNORE INTO notifications (kind, title, body, job_id, payload, dedupe_key, created_at, read_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(kind, title, body, jobId, JSON.stringify(payload), dedupeKey, now, prefs.inApp ? null : now);
  if (!r.changes) return null;
  const id = Number(r.lastInsertRowid);
  if (prefs.email) {
    const out = await email.send(db, { subject: title, text: `${title}\n\n${body}${APP_URL() ? `\n\n${APP_URL()}` : ''}\n` });
    await db.prepare('UPDATE notifications SET emailed_at = ?, email_error = ? WHERE id = ?').run(out.ok ? new Date().toISOString() : null, out.ok ? null : out.error || 'failed', id);
  }
  return hydrate(await db.prepare('SELECT * FROM notifications WHERE id = ?').get(id));
}

const list = async (db, { unread, limit = 50 } = {}) => (await db.prepare(`SELECT * FROM notifications ${unread ? 'WHERE read_at IS NULL' : ''} ORDER BY id DESC LIMIT ?`).all(Math.min(Number(limit) || 50, 200))).map(hydrate);
const unreadCount = async (db) => (await db.prepare('SELECT COUNT(*) n FROM notifications WHERE read_at IS NULL').get()).n;
const markRead = (db, id) => db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?').run(new Date().toISOString(), Number(id));
const markAllRead = (db) => db.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL').run(new Date().toISOString());
const remove = (db, id) => db.prepare('DELETE FROM notifications WHERE id = ?').run(Number(id));

module.exports = { notify, list, unreadCount, markRead, markAllRead, remove };
