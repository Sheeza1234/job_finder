import base64
import os

import pytest

from app import migrate
from app.errors import HttpError
from app.services import crypto


def test_migrations_apply_once_and_record(db):
    assert migrate.run(db) == []                       # already applied by the fixture
    s = migrate.status(db)
    assert [m["id"] for m in s["applied"]] == ["001_baseline"] and s["pending"] == []


def test_timestamps_read_back_as_iso_utc_strings(db):
    db.exec("TRUNCATE settings")
    db.exec("INSERT INTO audit_logs (at, actor, action) VALUES ('2026-10-27T11:23:40.123Z', 'user', 'x')")
    at = db.one("SELECT at FROM audit_logs ORDER BY id DESC LIMIT 1")["at"]
    assert at == "2026-10-27T11:23:40.123Z"


def test_row_level_security_is_on_for_every_table(db):
    rows = db.all("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                  "WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity")
    assert [r["relname"] for r in rows] == [], "Supabase would expose these tables through its public REST API"


def test_encrypt_roundtrip_and_tamper_detection(monkeypatch):
    monkeypatch.setenv("APP_SECRET", "a-long-enough-secret-value")
    blob = crypto.encrypt("sk-secret-key")
    assert "sk-secret-key" not in blob and crypto.decrypt(blob) == "sk-secret-key"
    v, iv, tag, ct = blob.split(":")
    bad = base64.b64encode(bytes([base64.b64decode(ct)[0] ^ 1]) + base64.b64decode(ct)[1:]).decode()
    with pytest.raises(HttpError):
        crypto.decrypt(f"{v}:{iv}:{tag}:{bad}")
    monkeypatch.setenv("APP_SECRET", "a-different-secret-value")
    with pytest.raises(HttpError):
        crypto.decrypt(blob)


def test_encryption_refuses_without_app_secret(monkeypatch):
    monkeypatch.delenv("APP_SECRET", raising=False)
    with pytest.raises(HttpError) as e:
        crypto.encrypt("x")
    assert e.value.status == 400


def test_node_encrypted_value_is_readable(monkeypatch):
    """Value produced by the existing Node implementation (APP_SECRET below), so a key saved there keeps working."""
    monkeypatch.setenv("APP_SECRET", "a-long-enough-secret-value")
    blob = os.environ.get("NODE_SAMPLE_BLOB")
    if not blob:
        pytest.skip("NODE_SAMPLE_BLOB not provided")
    assert crypto.decrypt(blob) == "from-node-123"


def test_signed_links_expire_and_resist_tampering(monkeypatch):
    monkeypatch.setenv("APP_SECRET", "a-long-enough-secret-value")
    t = crypto.sign_link("document", 7, ttl_ms=1000, now_ms=10_000)
    assert crypto.verify_link(t, now_ms=10_500) == {"kind": "document", "id": 7}
    assert crypto.verify_link(t, now_ms=11_001) is None
    body, sig = t.split(".")
    assert crypto.verify_link(f"{body}.{sig[:-2]}AA", now_ms=10_500) is None
    assert crypto.verify_link("garbage", now_ms=0) is None
