"""Settings from the environment. Tests set JOBFINDER_NO_DOTENV so a developer's .env never leaks in."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent


def _load_dotenv() -> None:
    if os.environ.get("JOBFINDER_NO_DOTENV"):
        return
    env = ROOT / ".env"
    if not env.is_file():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()
_e = os.environ.get


class Config:
    """Read lazily from the environment so tests can change values between apps."""

    @property
    def port(self) -> int: return int(_e("PORT", "3000"))
    # Loopback by default: a personal tool holding your CV must not listen on the network unless you choose to.
    @property
    def host(self) -> str: return _e("HOST", "127.0.0.1")
    @property
    def data_dir(self) -> Path: return Path(_e("DATA_DIR", str(ROOT / "data")))
    @property
    def public_dir(self) -> Path: return Path(_e("PUBLIC_DIR", str(ROOT / "public")))
    @property
    def app_password(self) -> str: return _e("APP_PASSWORD", "")
    @property
    def app_secret(self) -> str: return _e("APP_SECRET", "")
    # Supabase: the direct Postgres connection string (Project Settings -> Database). Never the anon/service REST keys.
    @property
    def database_url(self) -> str: return _e("DATABASE_URL", "")
    @property
    def jooble_key(self) -> str: return _e("JOOBLE_API_KEY", "")
    @property
    def rapidapi_key(self) -> str: return _e("RAPIDAPI_KEY", "")
    @property
    def max_upload_mb(self) -> int: return max(1, int(float(_e("MAX_UPLOAD_MB", "15"))))


config = Config()
