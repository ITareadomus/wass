
# -*- coding: utf-8 -*-
import json
import mysql.connector
import sys
from datetime import datetime, date
from pathlib import Path

# ---------- Config ----------
BASE_DIR = Path(__file__).parent.parent / "data"
OUTPUT_DIR = BASE_DIR / "output"
OUTPUT_CONVOCAZIONI_TASKS = OUTPUT_DIR / "convocazioni_tasks.json"

# Crea le directory se non esistono
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ---------- Config DB ----------
DB_CONFIG = {
    "host": "139.59.132.41",
    "user": "admin",
    "password": "ed329a875c6c4ebdf4e87e2bbe53a15771b5844ef6606dde",
    "database": "adamdb",
}

# ---------- Utilità ----------
def date_to_str(value):
    if isinstance(value, (datetime, date)):
        return value.strftime('%Y-%m-%d')
    return value

def varchar_to_str(value):
    if value is None:
        return None
    return str(value)

def normalize_coord(coord):
    if coord is None:
        return None
    return str(coord).replace(',', '.').strip()

def map_structure_type_to_letter(structure_type_id):
    mapping = {1: "A", 2: "B", 3: "C", 4: "D", 5: "E", 6: "F"}
    return mapping.get(structure_type_id, "X")

# ---------- Operazioni attive ----------
def get_active_operations():
    connection = mysql.connector.connect(**DB_CONFIG)
    cursor = connection.cursor(dictionary=True)
    cursor.execute("""
        SELECT id
        FROM app_structure_operation
        WHERE active = 1 AND enable_wass = 1
    """)
    results = cursor.fetchall()
    cursor.close()
    connection.close()
    return [row['id'] for row in results]

# ---------- Estrazione task dal DB ----------
def get_tasks_stats_from_db(selected_date):
    print(f"Aggiorno la lista delle operazioni attive dal DB...")
    ops = get_active_operations()
    
    valid_operation_ids = ops + [0, None]
    non_null_operation_ids = [op for op in valid_operation_ids if op is not None]
    operation_placeholders = ','.join(['%s'] * len(non_null_operation_ids)) if non_null_operation_ids else 'NULL'

    connection = mysql.connector.connect(**DB_CONFIG)
    cursor = connection.cursor(dictionary=True)

    base_query = f"""
        SELECT 
            h.id AS task_id,
            s.logistic_code AS logistic_code,
            s.premium AS premium,
            s.structure_type_id,
            h.operation_id
        FROM app_housekeeping h
        JOIN app_structures s ON h.structure_id = s.id
        WHERE h.checkout = %s
          AND h.deleted_at IS NULL
          AND h.deleted_at_client IS NULL
          AND s.lat IS NOT NULL AND s.lng IS NOT NULL
          AND s.lat != '' AND s.lng != ''
          AND s.lat != '0' AND s.lng != '0'
    """

    params = [selected_date]
    if non_null_operation_ids:
        base_query += f" AND (h.operation_id IN ({operation_placeholders}) OR h.operation_id IS NULL OR h.operation_id = 0)"
        params += non_null_operation_ids

    cursor.execute(base_query, params)
    rows = cursor.fetchall()
    cursor.close()
    connection.close()

    stats = {
        "total": 0,
        "premium": 0,
        "standard": 0,
        "straordinarie": 0
    }

    for r in rows:
        op_id = r.get("operation_id")
        premium_bool = True if r.get("premium") in (1, True, "1") else False
        straordinaria_bool = True if op_id == 3 else False

        stats["total"] += 1
        if premium_bool:
            stats["premium"] += 1
        else:
            stats["standard"] += 1
        if straordinaria_bool:
            stats["straordinarie"] += 1

    return stats

# ---------- Main ----------
def main():
    if len(sys.argv) > 1:
        selected_date = sys.argv[1]
        print(f"Usando data specifica: {selected_date}")
    else:
        selected_date = datetime.now().strftime("%Y-%m-%d")
        print(f"Usando data di default (oggi): {selected_date}")

    # Estrai statistiche task dal DB
    print(f"📋 Estrazione statistiche task dal database per {selected_date}...")
    task_stats = get_tasks_stats_from_db(selected_date)
    print(f"✅ Statistiche estratte: {task_stats}")

    # Crea output
    from zoneinfo import ZoneInfo
    output = {
        "metadata": {
            "last_updated": datetime.now(ZoneInfo("Europe/Rome")).isoformat(),
            "date": selected_date
        },
        "task_stats": task_stats
    }

    # Salva file
    with open(OUTPUT_CONVOCAZIONI_TASKS, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\n✅ File convocazioni_tasks.json creato con successo!")
    print(f"   📅 Data: {selected_date}")
    print(f"   📦 Task totali: {task_stats['total']}")
    print(f"   ⭐ Premium: {task_stats['premium']}")
    print(f"   📋 Standard: {task_stats['standard']}")
    print(f"   🔴 Straordinarie: {task_stats['straordinarie']}")
    print(f"   💾 Salvato in: {OUTPUT_CONVOCAZIONI_TASKS}")

if __name__ == "__main__":
    main()
