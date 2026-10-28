"""Postgres access (Supabase). Sync psycopg 3 with a connection pool; FastAPI runs sync routes in a thread pool.

Timestamps are read back as ISO-8601 UTC strings ("2026-10-27T11:23:40.123Z"), the shape the UI already uses.
JSON columns are JSONB and come back as Python objects.
"""
from __future__ import annotations

import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator

import psycopg
from psycopg.adapt import Loader
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from .config import config


class _IsoTimestamptz(Loader):
    def load(self, data):  # type: ignore[override]
        s = bytes(data).decode()
        if s in ("infinity", "-infinity"):
            return s
        dt = datetime.fromisoformat(s.replace(" ", "T")).astimezone(timezone.utc)
        return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _configure(conn: psycopg.Connection) -> None:
    conn.adapters.register_loader("timestamptz", _IsoTimestamptz)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def json_param(value: Any) -> Jsonb:
    return Jsonb(value)


class Db:
    """Small helper over a pool. One statement per call, or several inside `with db.tx() as t:`."""

    def __init__(self, url: str):
        if not url:
            raise RuntimeError("DATABASE_URL is not set. Use the Supabase connection string (Project Settings -> Database).")
        self.pool = ConnectionPool(url, min_size=1, max_size=10, kwargs={"row_factory": dict_row, "prepare_threshold": None}, configure=_configure, open=True)
        self._lock = threading.Lock()

    def close(self) -> None:
        self.pool.close()

    @contextmanager
    def tx(self) -> Iterator["Tx"]:
        with self.pool.connection() as conn:   # commits on success, rolls back on error
            yield Tx(conn)

    def one(self, sql: str, params: tuple | list = ()) -> dict | None:
        with self.tx() as t:
            return t.one(sql, params)

    def all(self, sql: str, params: tuple | list = ()) -> list[dict]:
        with self.tx() as t:
            return t.all(sql, params)

    def exec(self, sql: str, params: tuple | list = ()) -> int:
        with self.tx() as t:
            return t.exec(sql, params)


class Tx:
    def __init__(self, conn: psycopg.Connection):
        self.conn = conn

    def one(self, sql, params=()):
        with self.conn.cursor() as cur:
            cur.execute(sql, params or None)
            return cur.fetchone() if cur.description else None

    def all(self, sql, params=()):
        with self.conn.cursor() as cur:
            cur.execute(sql, params or None)
            return cur.fetchall() if cur.description else []

    def exec(self, sql, params=()):
        with self.conn.cursor() as cur:
            cur.execute(sql, params or None)
            return cur.rowcount


def open_db(url: str | None = None) -> Db:
    from .migrate import run
    db = Db(url or config.database_url)
    run(db)
    return db
