"""Encrypts integration credentials at rest with AES-256-GCM (key derived from APP_SECRET, which lives in the
environment, never in the database or the browser), and signs short-lived download links."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from ..config import config
from ..errors import HttpError

_fallback_sign_key = os.urandom(32).hex()


def _key() -> bytes:
    if len(config.app_secret) < 16:
        raise HttpError(400, "Set APP_SECRET (at least 16 characters) in the server environment before storing credentials.")
    # Same derivation as the Node version (scrypt N=16384, r=8, p=1) so values encrypted by either can be read by both.
    return hashlib.scrypt(config.app_secret.encode(), salt=b"jobfinder-credentials-v1", n=16384, r=8, p=1, dklen=32)


def encrypt(plain: str) -> str:
    iv = os.urandom(12)
    sealed = AESGCM(_key()).encrypt(iv, str(plain).encode(), None)   # ciphertext || 16-byte tag
    ct, tag = sealed[:-16], sealed[-16:]
    b = lambda x: base64.b64encode(x).decode()
    return f"v1:{b(iv)}:{b(tag)}:{b(ct)}"


def decrypt(blob: str) -> str:
    parts = str(blob).split(":")
    if len(parts) != 4 or parts[0] != "v1" or not parts[3]:
        raise HttpError(500, "Stored credential is malformed.")
    _, iv, tag, ct = parts
    try:
        return AESGCM(_key()).decrypt(base64.b64decode(iv), base64.b64decode(ct) + base64.b64decode(tag), None).decode()
    except (InvalidTag, ValueError):
        raise HttpError(400, "Cannot decrypt stored credential (APP_SECRET changed?). Re-enter it.")


def _sign_key() -> bytes:
    return (config.app_secret if len(config.app_secret) >= 16 else _fallback_sign_key).encode()


def _b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign_link(kind: str, ident: int | str, ttl_ms: int = 5 * 60 * 1000, now_ms: int | None = None) -> str:
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    body = _b64u(json.dumps({"k": kind, "i": ident, "e": now_ms + ttl_ms}, separators=(",", ":")).encode())
    return f"{body}.{_b64u(hmac.new(_sign_key(), body.encode(), hashlib.sha256).digest())}"


def verify_link(token: str, now_ms: int | None = None) -> dict | None:
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    body, _, sig = str(token).partition(".")
    if not body or not sig:
        return None
    want = hmac.new(_sign_key(), body.encode(), hashlib.sha256).digest()
    try:
        if not hmac.compare_digest(_unb64u(sig), want):
            return None
        p = json.loads(_unb64u(body))
    except (ValueError, json.JSONDecodeError):
        return None
    return {"kind": p["k"], "id": p["i"]} if p.get("e", 0) > now_ms else None
