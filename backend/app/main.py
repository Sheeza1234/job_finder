from __future__ import annotations

import base64
import hmac
import time
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from .config import config
from .db import Db, open_db
from .errors import HttpError
from .routers import core
from .services import audit as audit_svc
from .services import credentials

CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"
THROTTLE_WINDOW = 15 * 60
THROTTLE_MAX = 10


def create_app(db: Db | None = None) -> FastAPI:
    db = db or open_db()
    app = FastAPI(title="Saudi Job Finder", docs_url=None, redoc_url=None, openapi_url=None)   # no public schema/docs page
    app.state.db = db
    failures: dict[str, tuple[int, float]] = {}
    try:
        credentials.load(db)
    except Exception:
        pass  # no APP_SECRET or unreadable keys: re-enter in Settings

    @app.get("/healthz")
    def healthz():
        return {"ok": True}   # liveness only: no data, no auth, for container health checks

    @app.middleware("http")
    async def guard(request: Request, call_next):
        path = request.url.path
        if path != "/healthz" and config.app_password:
            ip = request.client.host if request.client else "?"
            count, first = failures.get(ip, (0, 0.0))
            now = time.time()
            if count >= THROTTLE_MAX and now - first < THROTTLE_WINDOW:
                return PlainTextResponse("Too many failed attempts. Try again later.", status_code=429)
            scheme, _, token = (request.headers.get("authorization") or "").partition(" ")
            if scheme == "Basic" and token:
                try:
                    pw = base64.b64decode(token).decode().partition(":")[2]
                except Exception:
                    pw = ""
                if hmac.compare_digest(pw.encode(), config.app_password.encode()):
                    failures.pop(ip, None)
                else:
                    cur = (count, first) if count and now - first < THROTTLE_WINDOW else (0, now)
                    failures[ip] = (cur[0] + 1, cur[1])
                    return PlainTextResponse("Authentication required", status_code=401, headers={"WWW-Authenticate": 'Basic realm="Job Finder"'})
            else:
                return PlainTextResponse("Authentication required", status_code=401, headers={"WWW-Authenticate": 'Basic realm="Job Finder"'})
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = CSP
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["Referrer-Policy"] = "no-referrer"
        entry = audit_svc.request_entry(request.method, path, response.status_code)
        if entry:
            action, entity, ident, detail = entry
            audit_svc.audit(db, action, entity=entity, entity_id=ident, detail=detail)
        return response

    @app.exception_handler(HttpError)
    async def http_error(_req, e: HttpError):
        return JSONResponse({"error": e.message}, status_code=e.status)

    @app.exception_handler(RequestValidationError)
    async def invalid(_req, e: RequestValidationError):
        return JSONResponse({"error": "; ".join(f"{'.'.join(map(str, i['loc'][1:])) or 'body'}: {i['msg']}" for i in e.errors())}, status_code=400)

    @app.exception_handler(Exception)
    async def unexpected(_req, e: Exception):
        return JSONResponse({"error": "Internal error. Check the server log."}, status_code=500)   # details stay in the log

    app.include_router(core.router)

    public = config.public_dir
    if public.is_dir():
        app.mount("/assets", StaticFiles(directory=public / "assets"), name="assets") if (public / "assets").is_dir() else None

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            if path.startswith("api/"):
                raise HttpError(404, "Not found")
            f = (public / path).resolve()
            if path and f.is_file() and public.resolve() in f.parents:   # never serve outside the public folder
                return FileResponse(f)
            return FileResponse(public / "index.html")
    return app
