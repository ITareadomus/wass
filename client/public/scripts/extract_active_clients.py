
#!/usr/bin/env python3
"""
Script per estrarre i clienti attivi dal database.
Output: JSON con client_id e customer_name
"""

import json
import psycopg2
from psycopg2.extras import RealDictCursor
import os
import sys

def get_db_connection():
    """Crea connessione al database."""
    return psycopg2.connect(
        host=os.getenv("PGHOST", "ep-old-glade-a2aezwcs.eu-central-1.aws.neon.tech"),
        database=os.getenv("PGDATABASE", "WASS_data"),
        user=os.getenv("PGUSER", "WASS_data_owner"),
        password=os.getenv("PGPASSWORD", "fTaXwWBsNqcc"),
        sslmode="require"
    )

def extract_active_clients():
    """Estrae tutti i clienti attivi che hanno strutture con housekeeping."""
    conn = get_db_connection()
    cursor = conn.cursor(cursor_factory=RealDictCursor)
    
    try:
        # Query per ottenere i clienti attivi dalle strutture con housekeeping
        query = """
            SELECT DISTINCT
                customer_id as client_id,
                customer_name
            FROM (
                SELECT 
                    s.customer_id,
                    c.name as customer_name
                FROM app_structures s
                LEFT JOIN app_customers c ON s.customer_id = c.id
                WHERE s.customer_id IS NOT NULL
                  AND c.name IS NOT NULL
                  AND s.deleted_at IS NULL
                  AND c.deleted_at IS NULL
            ) subquery
            ORDER BY customer_name
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
