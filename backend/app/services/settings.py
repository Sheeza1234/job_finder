"""Search and notification preferences, validated like the original zod schemas (HTTP 400 with a readable message)."""
from __future__ import annotations

import re
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

from ..db import json_param
from ..errors import HttpError

Item = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
LongItem = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class SearchSettings(BaseModel):
    model_config = ConfigDict(extra="ignore")
    titles: list[Item] = Field(default=[], max_length=30)
    cities: list[Item] = Field(default=[], max_length=20)
    minSalary: float | None = Field(default=None, ge=0, le=10_000_000)
    experienceLevels: list[Literal["entry", "mid", "senior", "lead"]] = Field(default=[], max_length=4)
    employmentTypes: list[Literal["full_time", "part_time", "contract", "internship"]] = Field(default=[], max_length=4)
    workModes: list[Literal["remote", "hybrid", "onsite"]] = Field(default=[], max_length=3)
    minMatchScore: int = Field(default=75, ge=0, le=100)
    excludedCompanies: list[LongItem] = Field(default=[], max_length=100)
    excludedKeywords: list[Item] = Field(default=[], max_length=100)
    includeRemote: bool = True
    arabic: bool = False
    aiScreening: bool = False
    frequency: Literal["off", "hourly", "every_6_hours", "daily"] = "off"
    dailyTime: str = "08:00"
    maxQueries: int = Field(default=12, ge=1, le=40)


class NotifySettings(BaseModel):
    model_config = ConfigDict(extra="ignore")
    inApp: bool = True
    email: bool = False
    newMatches: bool = True
    followUps: bool = True
    interviews: bool = True
    expiring: bool = True
    followUpDays: int = Field(default=7, ge=1, le=60)


def get(db, key: str):
    r = db.one("SELECT value FROM settings WHERE key = %s", (key,))
    return r["value"] if r else None


def set_(db, key: str, value) -> None:
    db.exec("INSERT INTO settings (key, value) VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value = excluded.value", (key, json_param(value)))


def _parse(model, defaults: dict, data) -> dict:
    try:
        return model.model_validate({**defaults, **(data or {})}).model_dump()
    except ValidationError as e:
        raise HttpError(400, "; ".join(f"{'.'.join(map(str, i['loc'])) or 'value'}: {i['msg']}" for i in e.errors()))


def _check_time(v: dict) -> dict:
    if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", v["dailyTime"]):
        raise HttpError(400, "dailyTime: dailyTime must be HH:MM")
    return v


def get_search(db) -> dict:
    return _check_time(_parse(SearchSettings, {}, get(db, "search_settings") or {}))


def save_search(db, data) -> dict:
    v = _check_time(_parse(SearchSettings, {}, data))
    set_(db, "search_settings", v)
    return v


def get_notify(db) -> dict:
    return _parse(NotifySettings, {}, get(db, "notification_prefs") or {})


def save_notify(db, data) -> dict:
    v = _parse(NotifySettings, {}, data)
    set_(db, "notification_prefs", v)
    return v


def _has(hay, needle) -> bool:
    return str(needle).lower() in str(hay or "").lower()


def is_excluded(job: dict, s: dict) -> bool:
    """Excluded employers/keywords never get recommended or notified."""
    if any(_has(job.get("company"), c) for c in s["excludedCompanies"]):
        return True
    return any(_has(job.get("title"), k) or _has(job.get("description"), k) for k in s["excludedKeywords"])


def qualifies(job: dict, s: dict) -> bool:
    """Does a job fit the stated preferences? Unknown attributes are given the benefit of the doubt."""
    if s["employmentTypes"] and job.get("employment_type") != "unknown" and job.get("employment_type") not in s["employmentTypes"]:
        return False
    if s["workModes"] and job.get("work_mode") != "unknown" and job.get("work_mode") not in s["workModes"]:
        return False
    if s["experienceLevels"] and job.get("experience_level") != "unknown" and job.get("experience_level") not in s["experienceLevels"]:
        return False
    pay = job.get("salary_max") or job.get("salary_min")
    if s["minSalary"] and pay and pay < s["minSalary"]:
        return False
    if s["cities"] and job.get("work_mode") != "remote" and job.get("city") and job["city"] not in s["cities"]:
        return False
    if not s["includeRemote"] and job.get("work_mode") == "remote":
        return False
    return True
