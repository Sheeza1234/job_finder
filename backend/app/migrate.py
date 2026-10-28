"""Versioned, forward-only SQL migrations (app/migrations/NNN_name.sql). Each runs once, in a transaction, under an
advisory lock so two processes starting together cannot apply the same migration twice."""
from __future__ import annotations

from pathlib import Path

DIR = Path(__file__).parent / "migrations"
LOCK_ID = 7_426_001


def files() -> list[Path]:
    return sorted(DIR.glob("*.sql"))


def run(db) -> list[str]:
    applied: list[str] = []
    with db.tx() as t:
        t.exec("SELECT pg_advisory_xact_lock(%s)", (LOCK_ID,))
        t.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())")
        t.exec("ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY")   # public schema on Supabase: keep it off the REST API too
        done = {r["id"] for r in t.all("SELECT id FROM schema_migrations")}
        for f in files():
            if f.stem in done:
                continue
            t.exec(f.read_text())
            t.exec("INSERT INTO schema_migrations (id) VALUES (%s)", (f.stem,))
            applied.append(f.stem)
    return applied


def status(db) -> dict:
    rows = db.all("SELECT id, applied_at FROM schema_migrations ORDER BY id")
    ids = {r["id"] for r in rows}
    return {"applied": rows, "pending": [f.stem for f in files() if f.stem not in ids]}


if __name__ == "__main__":  # python -m app.migrate
    from .db import open_db
    s = status(open_db())
    print(f"Applied: {', '.join(r['id'] for r in s['applied']) or 'none'}\nPending: {', '.join(s['pending']) or 'none'}")
