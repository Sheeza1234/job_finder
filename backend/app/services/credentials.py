"""Job-source API keys entered in the app (encrypted with APP_SECRET, write-only). Environment variables still work;
a key saved here takes precedence. Decrypted keys are cached in memory so providers can read them cheaply."""
from __future__ import annotations

import re

from ..errors import HttpError
from . import settings
from .crypto import decrypt, encrypt

KEY = "provider_keys"
_cache: dict[str, str] = {}
SOURCES = {
    "jooble": {"label": "Jooble", "signup": "https://jooble.org/api/about", "free": True,
               "help": "Free. Request an API key on the Jooble page, then paste it here. This is the quickest way to get jobs in Saudi cities."},
    "jsearch": {"label": "JSearch (RapidAPI)", "signup": "https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch", "free": False,
                "help": "Google-for-Jobs results. Has a small free plan; paid beyond it."},
}


def load(db) -> None:
    _cache.clear()
    for sid, enc in (settings.get(db, KEY) or {}).items():
        try:
            _cache[sid] = decrypt(enc)
        except HttpError:
            pass  # APP_SECRET changed: the key must be re-entered


def get(sid: str) -> str:
    return _cache.get(sid, "")


def set_(db, sid: str, key) -> None:
    if sid not in SOURCES:
        raise HttpError(404, "Unknown job source.")
    k = str(key or "").strip()
    if k and (len(k) < 8 or len(k) > 200 or re.search(r"\s", k)):
        raise HttpError(400, "That does not look like an API key (8-200 characters, no spaces).")
    allk = dict(settings.get(db, KEY) or {})
    if k:
        allk[sid] = encrypt(k)
    else:
        allk.pop(sid, None)     # empty = remove
    settings.set_(db, KEY, allk)
    if k:
        _cache[sid] = k
    else:
        _cache.pop(sid, None)


def status(db, env_keys: dict[str, str]) -> list[dict]:
    """Never returns the key itself."""
    stored = settings.get(db, KEY) or {}
    return [{"id": sid, **s, "hasKey": bool(stored.get(sid) or env_keys.get(sid)),
             "from": "app" if stored.get(sid) else ("env" if env_keys.get(sid) else None)} for sid, s in SOURCES.items()]
