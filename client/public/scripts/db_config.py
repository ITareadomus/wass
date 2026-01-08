"""
Database Configuration for Python Scripts

Centralized configuration for MySQL database access.
Uses environment variables with fallback to development defaults.

Environment Variables:
- NODE_ENV: 'development' or 'production'
- MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
"""

import os

# Determine environment
ENV = os.getenv("NODE_ENV", "development")

# MySQL Configuration per environment
MYSQL_CONFIG = {
    "development": {
        "host": "139.59.132.41",
        "port": 3306,
        "user": "wass_svil",
        "password": "REMOVED_PASSWORD",
        "database": "wass_sviluppo",
    },
    "production": {
        "host": "139.59.132.41",
        "port": 3306,
        "user": "admin",
        "password": "REMOVED_MYSQL_PASSWORD",
        "database": "adamdb",
    },
}

def get_mysql_config():
    """Get MySQL configuration for current environment."""
    config = MYSQL_CONFIG.get(ENV, MYSQL_CONFIG["development"])
    
    # Allow environment variable overrides
    return {
        "host": os.getenv("MYSQL_HOST", config["host"]),
        "port": int(os.getenv("MYSQL_PORT", str(config["port"]))),
        "user": os.getenv("MYSQL_USER", config["user"]),
        "password": os.getenv("MYSQL_PASSWORD", config["password"]),
        "database": os.getenv("MYSQL_DATABASE", config["database"]),
    }

# Export config for easy import
db_config = get_mysql_config()

# Log configuration on import (without password)
print(f"📊 Python DB config loaded for environment: {ENV}")
print(f"   MySQL: {db_config['host']}:{db_config['port']}/{db_config['database']}")
