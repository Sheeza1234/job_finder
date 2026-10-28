"""Meta, status, profile, settings, job-source keys and activity log."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, Response

from ..config import config
from ..services import audit as audit_svc
from ..services import credentials, profile as profile_svc, settings as settings_svc

router = APIRouter()
SAUDI_CITIES = ["Riyadh", "Jeddah", "Dammam", "Al Khobar", "Mecca", "Medina", "NEOM"]
STATUSES = [["saved", "Saved"], ["shortlisted", "Shortlisted"], ["cv_ready", "CV Ready"], ["awaiting_approval", "Awaiting My Approval"],
            ["ready_to_apply", "Ready to Apply"], ["applied", "Applied"], ["assessment", "Assessment"], ["interview", "Interview"],
            ["offer", "Offer"], ["rejected", "Rejected"], ["withdrawn", "Withdrawn"], ["listing_expired", "Listing Expired"]]


def _db(request: Request):
    return request.app.state.db


def _env_keys() -> dict[str, str]:
    return {"jooble": config.jooble_key, "jsearch": config.rapidapi_key}


@router.get("/api/meta")
def meta():
    return {"categories": profile_svc.DEFAULT_CATEGORIES, "cities": SAUDI_CITIES, "statuses": STATUSES}


@router.get("/api/status")
def status(request: Request):
    db = _db(request)
    has = lambda sid: bool(credentials.get(sid) or _env_keys().get(sid))
    mode = settings_svc.get(db, "app_mode") or "production"
    providers = [{"id": "remotive", "label": "Remotive (remote jobs)", "enabled": True},
                 {"id": "jooble", "label": "Jooble", "enabled": has("jooble")},
                 {"id": "jsearch", "label": "JSearch (RapidAPI)", "enabled": has("jsearch")}]
    # AI features are served by the AI module, which is not ported yet, so AI is reported as off rather than guessed.
    return {"ai": False, "model": None, "ai_target": None, "providers": providers, "browserAssist": False, "mode": mode}


@router.get("/api/profile")
def get_profile(request: Request):
    return profile_svc.get_profile(_db(request))


@router.put("/api/profile")
def put_profile(request: Request, body: dict[str, Any]):
    return profile_svc.save_profile(_db(request), body)


@router.get("/api/settings/search")
def get_search(request: Request):
    return settings_svc.get_search(_db(request))


@router.put("/api/settings/search")
def put_search(request: Request, body: dict[str, Any]):
    return settings_svc.save_search(_db(request), body)


@router.get("/api/settings/notifications")
def get_notify(request: Request):
    return settings_svc.get_notify(_db(request))


@router.put("/api/settings/notifications")
def put_notify(request: Request, body: dict[str, Any]):
    return settings_svc.save_notify(_db(request), body)


@router.get("/api/settings/job-sources")
def job_sources(request: Request):
    return credentials.status(_db(request), _env_keys())


@router.put("/api/settings/job-sources/{sid}")
def put_job_source(sid: str, request: Request, body: dict[str, Any]):
    db = _db(request)
    credentials.set_(db, sid, body.get("key"))
    audit_svc.audit(db, "job_source_key_changed", entity="job_source", entity_id=sid)
    return credentials.status(db, _env_keys())


@router.get("/api/audit")
def get_audit(request: Request, limit: int = 100):
    return audit_svc.recent(_db(request), limit=limit)
