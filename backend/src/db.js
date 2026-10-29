// Postgres (Supabase) access. Services keep the small `db.prepare(sql).get/all/run(...)` shape they always had, but every
// call is now async. `?` and `@name` placeholders are rewritten to $1.. so the SQL stays readable.
// Values come back in the shape the services already expect: timestamps as ISO-8601 strings, JSON columns as text
// (they JSON.parse them), booleans as 1/0 and counts as numbers.
const { Pool, types } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const baseTimestamptz = types.getTypeParser(1184);
types.setTypeParser(1184, (v) => { const d = baseTimestamptz(v); return d instanceof Date && !isNaN(d) ? d.toISOString() : v; });
types.setTypeParser(1114, (v) => { const d = new Date(`${v.replace(' ', 'T')}Z`); return isNaN(d) ? v : d.toISOString(); });
types.setTypeParser(20, (v) => Number(v));            // COUNT(), bigint
types.setTypeParser(1700, (v) => parseFloat(v));      // numeric (SUM, AVG)
types.setTypeParser(114, (v) => v);                   // json / jsonb stay text
types.setTypeParser(3802, (v) => v);
types.setTypeParser(16, (v) => (v === 't' ? 1 : 0));  // boolean

const MIGRATIONS_DIR = path.join(__dirname, '..', 'app', 'migrations');   // one schema for the whole project
const LOCK_ID = 7426001;                                                              // same advisory lock the Python backend uses
const TABLES_WITH_ID = ['documents', 'jobs', 'cv_versions', 'cover_letters', 'notifications', 'audit_logs'];

// "SELECT ... WHERE a = ? AND b = @name" -> "$1 ... $2", plus the ordered values.
function bind(sql, args) {
  const values = []; const named = new Map();
  const obj = args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) && !(args[0] instanceof Date) ? args[0] : null;
  const arr = obj ? [] : args;
  let i = 0;
  const text = sql.replace(/\?|@([a-zA-Z_]\w*)/g, (m, name) => {
    if (name) {
      if (!named.has(name)) { values.push(obj ? obj[name] : undefined); named.set(name, values.length); }
      return `$${named.get(name)}`;
    }
    values.push(arr[i++]);
    return `$${values.length}`;
  });
  return { text, values: values.map((v) => (v === undefined || (typeof v === 'number' && Number.isNaN(v)) ? null : v)) };   // a non-numeric id in a URL matches nothing, as it did before
}

function dialect(sql) {
  let s = sql.trim().replace(/;$/, '');
  const ignore = /^INSERT\s+OR\s+IGNORE\s+INTO/i.test(s);
  if (ignore) s = s.replace(/^INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO') + ' ON CONFLICT DO NOTHING';
  const table = /^INSERT\s+INTO\s+(\w+)/i.exec(s)?.[1];
  if (table && TABLES_WITH_ID.includes(table) && !/\bRETURNING\b/i.test(s)) s += ' RETURNING id';
  return s;
}

class Db {
  constructor(pool, { schema = null } = {}) {
    this.pool = pool; this.schema = schema; this.als = new AsyncLocalStorage();
    this.pending = new Set();   // background writes (the request audit log); reads of that table wait for them
  }

  track(promise) { this.pending.add(promise); promise.finally(() => this.pending.delete(promise)); return promise; }

  async query(sql, args = []) {
    if (this.pending.size && /^\s*SELECT[\s\S]*\baudit_logs\b/i.test(sql)) await Promise.allSettled([...this.pending]);
    const { text, values } = bind(dialect(sql), args);
    const tx = this.als.getStore();
    return tx ? tx.query(text, values) : this.pool.query(text, values);
  }

  prepare(sql) {
    return {
      get: async (...a) => (await this.query(sql, a)).rows[0],
      all: async (...a) => (await this.query(sql, a)).rows,
      run: async (...a) => { const r = await this.query(sql, a); return { changes: r.rowCount, lastInsertRowid: r.rows[0]?.id }; },
    };
  }

  // Several statements without parameters (DDL).
  async exec(sql) { const tx = this.als.getStore(); await (tx || this.pool).query(sql); }

  // Everything awaited inside `fn` runs on one connection and commits or rolls back together.
  async transaction(fn) {
    if (this.als.getStore()) return fn();     // already inside one: join it
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await this.als.run(client, fn);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
      throw e;
    } finally { client.release(); }
  }

  async close() { await Promise.allSettled([...this.pending]); await this.pool.end(); }
}

const migrationFiles = () => fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

// Versioned, forward-only. Each file runs once inside a transaction under an advisory lock, so two processes
// starting together cannot apply the same migration twice. The Python backend reads the same folder and table.
async function migrate(db) {
  const applied = [];
  await db.transaction(async () => {
    await db.query('SELECT pg_advisory_xact_lock(?)', [LOCK_ID]);
    await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    await db.exec('ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY');
    const done = new Set((await db.prepare('SELECT id FROM schema_migrations').all()).map((r) => r.id));
    for (const f of migrationFiles()) {
      const id = f.replace(/\.sql$/, '');
      if (done.has(id)) continue;
      await db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
      await db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(id);
      applied.push(id);
    }
  });
  return applied;
}

async function migrationStatus(db) {
  const rows = await db.prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id').all();
  const ids = new Set(rows.map((r) => r.id));
  return { applied: rows, pending: migrationFiles().map((f) => f.replace(/\.sql$/, '')).filter((id) => !ids.has(id)) };
}

// Supabase's pooler certificate is signed by Supabase's own root CA (certs/supabase-ca.crt, valid to 2031), which is not in
// the system trust store. We verify against it instead of turning verification off. Local databases (tests) use no TLS.
const CA_FILE = path.join(__dirname, '..', 'certs', 'supabase-ca.crt');
function connection(url) {
  const u = new URL(url);
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
  u.searchParams.delete('sslmode');
  return { connectionString: u.toString(), ...(local ? {} : { ssl: fs.existsSync(CA_FILE) ? { ca: fs.readFileSync(CA_FILE, 'utf8'), rejectUnauthorized: true } : { rejectUnauthorized: true } }) };
}

// openDb() uses DATABASE_URL (your Supabase project). Tests pass a url and a throwaway schema.
async function openDb({ url = config.databaseUrl, schema = null, max = 8 } = {}) {
  if (!url) throw new Error('DATABASE_URL is not set. Add the Supabase connection string (Project Settings -> Database) to .env.');
  if (schema) {
    const admin = new Pool({ ...connection(url), max: 1 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await admin.end();
  }
  const pool = new Pool({ ...connection(url), max, ...(schema ? { options: `-c search_path="${schema}"` } : {}), idleTimeoutMillis: 600000, keepAlive: true, connectionTimeoutMillis: 30000 });   // a new connection to a far-away pooler takes seconds: keep them warm
  pool.on('error', () => { /* an idle connection dropped; the pool replaces it */ });
  const db = new Db(pool, { schema });
  await migrate(db);
  if (!schema) await Promise.all([1, 2, 3, 4].map(() => pool.query('SELECT 1')));   // open a few connections up front
  return db;
}

// Test helper: drop the throwaway schema.
async function dropSchema(db) {
  if (!db.schema || db.dropped) return;
  db.dropped = true;
  const conn = { connectionString: db.pool.options.connectionString, ssl: db.pool.options.ssl };
  await db.close();
  const admin = new Pool({ ...conn, max: 1 });
  await admin.query(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`);
  await admin.end();
}

module.exports = { openDb, dropSchema, migrate, migrationStatus, Db };
