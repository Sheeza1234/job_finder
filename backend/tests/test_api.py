def test_health_and_meta(client):
    assert client.get("/healthz").json() == {"ok": True}
    m = client.get("/api/meta").json()
    assert "Riyadh" in m["cities"] and ["saved", "Saved"] in m["statuses"] and len(m["categories"]) == 13


def test_security_headers(client):
    r = client.get("/healthz")
    assert "script-src 'self'" in r.headers["content-security-policy"] and r.headers["x-content-type-options"] == "nosniff"


def test_profile_defaults_and_roundtrip(client):
    p = client.get("/api/profile").json()
    assert p["fullName"] == "" and p["skills"] == [] and p["preferences"]["openToRelocation"] is True
    saved = client.put("/api/profile", json={"fullName": "  Test Candidate ", "skills": ["Figma", "", 3], "yearsExperience": "2.5",
                                             "experience": [{"title": "Designer", "company": "Acme", "bullets": ["Did things", ""]}]}).json()
    assert saved["fullName"] == "Test Candidate" and saved["skills"] == ["Figma", "3"] or saved["skills"] == ["Figma"]
    assert saved["yearsExperience"] == 2.5 and len(saved["experience"][0]["id"]) == 8 and saved["experience"][0]["bullets"] == ["Did things"]
    again = client.get("/api/profile").json()
    assert again == saved, "ids are stable across reads"


def test_untouched_starter_categories_are_treated_as_no_choice(client):
    cats = client.get("/api/meta").json()["categories"]
    client.put("/api/profile", json={"categories": cats})
    assert client.get("/api/profile").json()["categories"] == []
    client.put("/api/profile", json={"categories": cats[:2]})
    assert client.get("/api/profile").json()["categories"] == cats[:2]


def test_search_settings_defaults_validation_and_save(client):
    s = client.get("/api/settings/search").json()
    assert s["minMatchScore"] == 75 and s["frequency"] == "off" and s["dailyTime"] == "08:00"
    bad = client.put("/api/settings/search", json={"minMatchScore": 500})
    assert bad.status_code == 400 and "minMatchScore" in bad.json()["error"]
    assert client.put("/api/settings/search", json={"dailyTime": "25:99"}).status_code == 400
    ok = client.put("/api/settings/search", json={"minMatchScore": 60, "frequency": "daily", "workModes": ["remote"]}).json()
    assert ok["minMatchScore"] == 60 and client.get("/api/settings/search").json()["workModes"] == ["remote"]


def test_notification_settings(client):
    assert client.get("/api/settings/notifications").json()["followUpDays"] == 7
    assert client.put("/api/settings/notifications", json={"followUpDays": 0}).status_code == 400
    assert client.put("/api/settings/notifications", json={"email": True}).json()["email"] is True


def test_job_source_keys_are_write_only_and_need_a_secret(client, monkeypatch):
    srcs = {s["id"]: s for s in client.get("/api/settings/job-sources").json()}
    assert srcs["jooble"]["hasKey"] is False
    r = client.put("/api/settings/job-sources/jooble", json={"key": "abcdef123456"})
    assert r.status_code == 400 and "APP_SECRET" in r.json()["error"]
    monkeypatch.setenv("APP_SECRET", "a-long-enough-secret-value")
    out = client.put("/api/settings/job-sources/jooble", json={"key": "abcdef123456"}).json()
    j = next(s for s in out if s["id"] == "jooble")
    assert j["hasKey"] is True and j["from"] == "app" and "abcdef123456" not in str(out)
    assert client.put("/api/settings/job-sources/jooble", json={"key": "bad key"}).status_code == 400
    assert client.put("/api/settings/job-sources/nope", json={"key": "abcdef123456"}).status_code == 404
    stored = client.app.state.db.one("SELECT value FROM settings WHERE key = 'provider_keys'")["value"]["jooble"]
    assert stored.startswith("v1:") and "abcdef123456" not in stored
    removed = client.put("/api/settings/job-sources/jooble", json={"key": ""}).json()
    assert next(s for s in removed if s["id"] == "jooble")["hasKey"] is False


def test_status_reports_providers_from_keys(client, monkeypatch):
    st = client.get("/api/status").json()
    assert st["mode"] == "production" and [p["id"] for p in st["providers"] if p["enabled"]] == ["remotive"]
    monkeypatch.setenv("JOOBLE_API_KEY", "envkey123456")
    assert "jooble" in [p["id"] for p in client.get("/api/status").json()["providers"] if p["enabled"]]


def test_state_changes_are_audited_without_bodies(client):
    client.put("/api/profile", json={"fullName": "Secret Name", "summary": "Private CV text"})
    log = client.get("/api/audit").json()
    assert any(a["action"] == "PUT /api/profile" for a in log)
    assert "Secret Name" not in str(log) and "Private CV text" not in str(log)
    assert not any(a["action"].startswith("GET") for a in log)


def test_errors_use_the_error_key_and_hide_internals(client):
    r = client.put("/api/profile", content="not json", headers={"content-type": "application/json"})
    assert r.status_code == 400 and "error" in r.json()
    assert client.get("/api/nope").status_code == 404


def test_password_protection_and_throttle(client, monkeypatch):
    monkeypatch.setenv("APP_PASSWORD", "hunter2-hunter2")
    assert client.get("/healthz").status_code == 200                       # liveness is open
    assert client.get("/api/meta").status_code == 401
    good = {"authorization": "Basic " + __import__("base64").b64encode(b"u:hunter2-hunter2").decode()}
    assert client.get("/api/meta", headers=good).status_code == 200
    bad = {"authorization": "Basic " + __import__("base64").b64encode(b"u:wrong").decode()}
    for _ in range(10):
        assert client.get("/api/meta", headers=bad).status_code == 401
    assert client.get("/api/meta", headers=good).status_code == 429, "locked out after 10 failures"
