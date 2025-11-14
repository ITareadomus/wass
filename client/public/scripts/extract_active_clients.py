
#!/usr/bin/env python3
"""
Script per estrarre i clienti attivi dal database.
Output: JSON con client_id e operation_name
"""

import json
import mysql.connector
import os
import sys

def get_db_connection():
    """Crea connessione al database MySQL."""
    return mysql.connector.connect(
        host=os.getenv("DB_HOST", "139.59.132.41"),
        database=os.getenv("DB_NAME", "adamdb"),
        user=os.getenv("DB_USER", "admin"),
        password=os.getenv("DB_PASSWORD", "ed329a875c6c4ebdf4e87e2bbe53a15771b5844ef6606dde"),
        port=int(os.getenv("DB_PORT", "3306"))
    )

def extract_active_clients():
    """Estrae tutti i clienti attivi che hanno strutture con housekeeping."""
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)
    
    try:
        # Query per ottenere i clienti attivi dalle strutture con housekeeping
        query = """
            SELECT DISTINCT
                s.customer_id as client_id,
                s.operation_name
            FROM app_structures s
            WHERE s.customer_id IS NOT NULL
              AND s.operation_name IS NOT NULL
              AND s.deleted_at IS NULL
            ORDER BY s.operation_name
        """
        
        cursor.execute(query)
        clients = cursor.fetchall()
        
        # Converti in lista di dict
        clients_list = [dict(client) for client in clients]
        
        return clients_list
        
    finally:
        cursor.close()
        conn.close()

def main():
    try:
        clients = extract_active_clients()
        print(json.dumps(clients, indent=2))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
