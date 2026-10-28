"""Entry point: python -m app.server"""
import os
import sys

import uvicorn

from .bind import assert_safe_bind
from .config import config

if __name__ == "__main__":
    try:
        assert_safe_bind(config.host, config.app_password, os.environ.get("ALLOW_INSECURE") == "true")
    except RuntimeError as e:
        print(e, file=sys.stderr)
        sys.exit(1)
    from .main import create_app
    app = create_app()
    print(f"Job Finder running at http://{config.host}:{config.port}")
    if not config.app_password:
        print("Note: APP_PASSWORD not set - fine while only reachable from this computer.")
    uvicorn.run(app, host=config.host, port=config.port, log_level="warning")
