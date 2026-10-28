"""The single profile. Starting categories do NOT imply the candidate qualifies; matching always compares job
requirements with the real profile data."""
from __future__ import annotations

import json
import secrets
from typing import Any

from ..db import json_param, now_iso

DEFAULT_CATEGORIES = [
    "Graphic Designer", "Senior Graphic Designer", "Brand Designer", "UI/UX Designer",
    "Digital Marketing Specialist", "SEO Specialist", "Digital Solutions Consultant", "Web Designer",
    "Frontend Developer", "AI Tools / AI Automation Specialist", "Shopify Developer", "Creative Designer",
    "Marketing and Business Development Specialist",
]

# English + Arabic search keywords per category (used for provider queries).
CATEGORY_KEYWORDS = {
    "Graphic Designer": ["graphic designer", "مصمم جرافيك"],
    "Senior Graphic Designer": ["senior graphic designer", "مصمم جرافيك أول"],
    "Brand Designer": ["brand designer", "مصمم هوية بصرية"],
    "UI/UX Designer": ["ui ux designer", "مصمم واجهات وتجربة المستخدم"],
    "Digital Marketing Specialist": ["digital marketing specialist", "أخصائي تسويق رقمي"],
    "SEO Specialist": ["seo specialist", "أخصائي تحسين محركات البحث"],
    "Digital Solutions Consultant": ["digital solutions consultant", "مستشار حلول رقمية"],
    "Web Designer": ["web designer", "مصمم مواقع"],
    "Frontend Developer": ["frontend developer", "مطور واجهات أمامية"],
    "AI Tools / AI Automation Specialist": ["ai automation specialist", "أخصائي أتمتة الذكاء الاصطناعي"],
    "Shopify Developer": ["shopify developer", "مطور شوبيفاي"],
    "Creative Designer": ["creative designer", "مصمم إبداعي"],
    "Marketing and Business Development Specialist": ["business development specialist marketing", "أخصائي تطوير الأعمال والتسويق"],
}


def _new_id() -> str:
    return secrets.token_hex(4)


def _str(v: Any, n: int = 5000) -> str:
    return v.strip()[:n] if isinstance(v, str) else ""


def _strs(v: Any, n: int = 200) -> list[str]:
    return [s for s in (_str(x, n) for x in (v if isinstance(v, list) else [])) if s]


def _items(v: Any) -> list[dict]:
    return [x for x in (v if isinstance(v, list) else []) if isinstance(x, dict)]


def _number(v: Any) -> float | int | None:
    """Mirrors JS Number.isFinite(Number(v)): blank and junk become None, whole numbers stay ints."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return int(f) if f == int(f) else f


def normalize(p: dict | None = None) -> dict:
    """Coerces arbitrary input into the profile shape, assigning stable ids to list items."""
    p = p if isinstance(p, dict) else {}
    prefs = p.get("preferences") if isinstance(p.get("preferences"), dict) else {}
    ans = p.get("answers") if isinstance(p.get("answers"), dict) else {}
    min_salary = _number(prefs.get("minSalary"))
    return {
        "fullName": _str(p.get("fullName"), 200), "email": _str(p.get("email"), 200), "phone": _str(p.get("phone"), 50),
        "location": _str(p.get("location"), 200), "headline": _str(p.get("headline"), 300), "summary": _str(p.get("summary"), 3000),
        "linkedinUrl": _str(p.get("linkedinUrl"), 500), "websiteUrl": _str(p.get("websiteUrl"), 500), "portfolioUrl": _str(p.get("portfolioUrl"), 500),
        "yearsExperience": _number(p.get("yearsExperience")) if p.get("yearsExperience") not in ("", None) else None,
        # categories: legacy starter-list picks. Target job titles are tags in preferredTitles (see target_titles()).
        "categories": _strs(p.get("categories")), "preferredTitles": _strs(p.get("preferredTitles")), "cvKeywords": _strs(p.get("cvKeywords"), 60),
        "skills": _strs(p.get("skills"), 100), "languages": _strs(p.get("languages"), 100), "achievements": _strs(p.get("achievements"), 500),
        "experience": [{"id": _str(e.get("id"), 20) or _new_id(), "title": _str(e.get("title"), 200), "company": _str(e.get("company"), 200),
                        "location": _str(e.get("location"), 200), "start": _str(e.get("start"), 20), "end": _str(e.get("end"), 20),
                        "current": bool(e.get("current")), "bullets": _strs(e.get("bullets"), 600)} for e in _items(p.get("experience"))],
        "education": [{"id": _str(e.get("id"), 20) or _new_id(), "degree": _str(e.get("degree"), 200), "institution": _str(e.get("institution"), 200),
                       "year": _str(e.get("year"), 20), "notes": _str(e.get("notes"), 500)} for e in _items(p.get("education"))],
        "certifications": [{"id": _str(c.get("id"), 20) or _new_id(), "name": _str(c.get("name"), 200), "issuer": _str(c.get("issuer"), 200),
                            "year": _str(c.get("year"), 20)} for c in _items(p.get("certifications"))],
        "projects": [{"id": _str(x.get("id"), 20) or _new_id(), "name": _str(x.get("name"), 200), "description": _str(x.get("description"), 1500),
                      "url": _str(x.get("url"), 500), "tech": _strs(x.get("tech"), 100)} for x in _items(p.get("projects"))],
        # Saved answers for sensitive application questions. Never guessed: empty means "ask me".
        "answers": {"salaryExpectation": _str(ans.get("salaryExpectation"), 200), "noticePeriod": _str(ans.get("noticePeriod"), 200),
                    "workAuthorization": _str(ans.get("workAuthorization"), 300), "visaStatus": _str(ans.get("visaStatus"), 300),
                    "relocation": _str(ans.get("relocation"), 300), "expectedStartDate": _str(ans.get("expectedStartDate"), 100)},
        "preferences": {"cities": _strs(prefs.get("cities"), 100), "employmentTypes": _strs(prefs.get("employmentTypes"), 30),
                        "workModes": _strs(prefs.get("workModes"), 30), "minSalary": min_salary or None,
                        "currency": _str(prefs.get("currency"), 5) or "SAR", "needsSponsorship": bool(prefs.get("needsSponsorship")),
                        "openToRelocation": prefs.get("openToRelocation") is not False},
    }


def empty_profile() -> dict:
    return normalize({})


def get_profile(db) -> dict:
    """Earlier versions pre-ticked all 13 starter categories for everyone, which assumed qualifications nobody confirmed.
    A profile whose categories are exactly that untouched default is treated as "no choice made yet"."""
    row = db.one("SELECT data FROM profile WHERE id = 1")
    if not row:
        return empty_profile()
    p = normalize(row["data"])
    if len(p["categories"]) == len(DEFAULT_CATEGORIES) and all(c in p["categories"] for c in DEFAULT_CATEGORIES) and not p["preferredTitles"]:
        p["categories"] = []
    return p


def target_titles(p: dict) -> list[str]:
    """The job titles the user is targeting: tags plus any legacy starter picks, de-duplicated."""
    seen: set[str] = set()
    out = []
    for t in [*p["preferredTitles"], *p["categories"]]:
        k = t.lower()
        if k not in seen:
            seen.add(k)
            out.append(t)
    return out


def save_profile(db, data) -> dict:
    p = normalize(data)
    db.exec("INSERT INTO profile (id, data, updated_at) VALUES (1, %s, %s) ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            (json_param(p), now_iso()))
    return p


def corpus(p: dict) -> str:
    """Flat lowercase text of everything the candidate has actually stated. Used to ground-check AI output."""
    return json.dumps([p["fullName"], p["headline"], p["summary"], p["skills"], p["languages"], p["achievements"], p["yearsExperience"],
                       [[e["title"], e["company"], e["start"], e["end"], e["bullets"]] for e in p["experience"]],
                       p["education"], p["certifications"], p["projects"]], ensure_ascii=False).lower()
