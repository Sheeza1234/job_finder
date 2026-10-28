import os

os.environ["JOBFINDER_NO_DOTENV"] = "1"
for k in ("APP_PASSWORD", "APP_SECRET", "JOOBLE_API_KEY", "RAPIDAPI_KEY", "HOST", "PUBLIC_DIR"):
    os.environ.pop(k, None)

import pytest
from fastapi.testclient import TestClient

from app.db import Db
from app.main import create_app
from app.migrate import run

TABLES = "profile, documents, jobs, analyses, applications, cv_versions, cover_letters, settings, notifications, audit_logs"


@pytest.fixture(scope="session")
def db():
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL not set (run: docker compose -f backend/docker-compose.test.yml up --build --abort-on-container-exit)")
    d = Db(url)
    run(d)
    yield d
    d.close()


@pytest.fixture()
def client(db, tmp_path, monkeypatch):
    db.exec(f"TRUNCATE {TABLES} RESTART IDENTITY CASCADE")
    monkeypatch.setenv("PUBLIC_DIR", str(tmp_path / "nopublic"))
    with TestClient(create_app(db), raise_server_exceptions=False) as c:
        yield c
