#!/usr/bin/env python3
"""
Script per estrarre i clienti attivi dal database.
Output: JSON con client_id e operation_name
"""

import json
import mysql.connector
import sys
from db_config import db_config


def get_db_connection():
    """Crea connessione al database MySQL."""
    return mysql.connector.connect(**db_config)


def extract_active_clients():
    """Estrae tutti i clienti attivi che hanno strutture con housekeeping."""
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)

    try:
        # Query per ottenere i clienti attivi dalle strutture con housekeeping
        query = """
            SELECT DISTINCT
                s.customer_id AS client_id,
                c.name AS customer_name,
                c.alias AS alias
            FROM app_structures s
            JOIN app_customers c ON c.id = s.customer_id
            WHERE s.customer_id IS NOT NULL AND c.active = 1
              AND c.name IS NOT NULL
              AND s.deleted_at IS NULL
            ORDER BY c.name
        """

        cursor.execute(query)
        clients = cursor.fetchall()
        return [dict(client) for client in clients]
    finally:
        cursor.close()
        conn.close()


if __name__ == "__main__":
    try:
        clients = extract_active_clients()
        # In caso di successo, stampo JSON valido
        print(json.dumps({"success": True, "clients": clients}, indent=2))
    except Exception as e:
        # IMPORTANTE: stampo su stdout e NON su stderr
        print(json.dumps({"success": False, "error": str(e), "clients": []}))
        sys.exit(1)
