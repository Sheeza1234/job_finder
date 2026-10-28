"""Append-only audit trail. Records what happened and when, never request bodies, CV text or credentials."""
from __future__ import annotations

import re

from ..db import json_param, now_iso

ENTITY = [(re.compile(r"^/api/cv-versions/(\d+)"), "cv_version"), (re.compile(r"^/api/letters/(\d+)"), "cover_letter"),
          (re.compile(r"^/api/applications/(\d+)"), "application"), (re.compile(r"^/api/jobs/(\d+)"), "job"),
          (re.compile(r"^/api/documents/(\d+)"), "document"), (re.compile(r"^/api/assist/([a-f0-9]+)"), "assist_session")]


def audit(db, action: str, *, actor: str = "user", entity: str | None = None, entity_id=None, detail: dict | None = None) -> None:
    try:
        db.exec("INSERT INTO audit_logs (at, actor, action, entity, entity_id, detail) VALUES (%s,%s,%s,%s,%s,%s)",
                (now_iso(), actor, action, entity, None if entity_id is None else str(entity_id), json_param(detail or {})))
    except Exception:  # auditing must never break the request
        pass


def request_entry(method: str, path: str, status: int) -> tuple[str, str | None, str | None, dict] | None:
    """What to log for a finished request, or None for reads, non-API paths and failures."""
    if method in ("GET", "HEAD") or not path.startswith("/api") or status >= 400:
        return None
    entity = ident = None
    for rx, name in ENTITY:
        m = rx.match(path)
        if m:
            entity, ident = name, m.group(1)
            break
    action = f"{method} " + re.sub(r"/\d+", "/:id", path)
    return action, entity, ident, {"status": status}


def recent(db, *, entity: str | None = None, entity_id=None, limit=100) -> list[dict]:
    try:
        n = min(int(limit) or 100, 500)
    except (TypeError, ValueError):
        n = 100
    if entity:
        return db.all("SELECT * FROM audit_logs WHERE entity = %s AND entity_id = %s ORDER BY id DESC LIMIT %s", (entity, str(entity_id), n))
    return db.all("SELECT * FROM audit_logs ORDER BY id DESC LIMIT %s", (n,))
