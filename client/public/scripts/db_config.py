"""
Database Configuration for Python Scripts

Centralized configuration for MySQL database access.
Uses environment variables loaded from .env.local in development,
or from system env vars in production (DigitalOcean App Platform).

Environment Variables:
- NODE_ENV: 'development' or 'production'
- DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
"""

import os
import sys
from pathlib import Path


def _configure_stdio_utf8() -> None:
    """Avoid UnicodeEncodeError on Windows consoles (cp1252) when printing emoji/logs."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if not callable(reconfigure):
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


_configure_stdio_utf8()

# Load .env.local in development (like Node.js dotenv does)
ENV = os.getenv("NODE_ENV", "development")

if ENV != "production":
    # Find .env.local relative to this script (in project root)
    script_dir = Path(__file__).resolve().parent
    project_root = script_dir.parent.parent.parent  # client/public/scripts -> project root
    env_file = project_root / ".env.local"
    
    if env_file.exists():
        # Simple .env parser (no external dependency needed)
        # Override existing env vars in development (like dotenv with override: true)
        with open(env_file, "r") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    key = key.strip()
                    value = value.strip()
                    os.environ[key] = value


def get_mysql_config():
    """Get MySQL configuration from environment variables."""
    return {
        "host": os.getenv("DB_HOST", ""),
        "port": int(os.getenv("DB_PORT", "3306")),
        "user": os.getenv("DB_USER", ""),
        "password": os.getenv("DB_PASSWORD", ""),
        "database": os.getenv("DB_NAME", ""),
    }


# Export config for easy import
db_config = get_mysql_config()

# Log configuration on import (without password)
if db_config["host"]:
    print(f"[db] Python DB config loaded for environment: {ENV}")
    print(f"   MySQL: {db_config['host']}:{db_config['port']}/{db_config['database']}")
else:
    print("[db] Python DB config: MySQL credentials not found in environment")
