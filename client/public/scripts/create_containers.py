# -*- coding: utf-8 -*-
import json
import mysql.connector
import sys
from datetime import datetime, date, timedelta
from pathlib import Path

# ---------- Config ----------
BASE_DIR = Path(__file__).parent.parent / "data"
INPUT_DIR = BASE_DIR / "input"
OUTPUT_DIR = BASE_DIR / "output"
SETTINGS_PATH = INPUT_DIR / "settings.json"
OUTPUT_CONTAINERS = OUTPUT_DIR / "containers.json"

# Crea le directory se non esistono
INPUT_DIR.mkdir(parents=True, exist_ok=True)
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

def parse_time(t):
    if not t:
        return None
    try:
        return datetime.strptime(t, "%H:%M").time()
    except ValueError:
        return None

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

def save_operations_to_file(operation_ids):
    operations_data = {
        "timestamp": datetime.now().isoformat(),
        "active_operation_ids": operation_ids,
        "total_operations": len(operation_ids)
    }
    ops_file = INPUT_DIR / "operations.json"
    with open(ops_file, "w", encoding="utf-8") as f:
        json.dump(operations_data, f, indent=4, ensure_ascii=False)
    print(f"Salvati {len(operation_ids)} operation_id validi in {ops_file}")

# ---------- Estrazione task dal DB ----------
def get_tasks_from_db(selected_date, assigned_task_ids=None):
    if assigned_task_ids is None:
        assigned_task_ids = set()
    
    print(f"Aggiorno la lista delle operazioni attive dal DB...")
    ops = get_active_operations()
    save_operations_to_file(ops)

    valid_operation_ids = ops + [0, None]
    non_null_operation_ids = [op for op in valid_operation_ids if op is not None]
    operation_placeholders = ','.join(['%s'] * len(non_null_operation_ids)) if non_null_operation_ids else 'NULL'

    connection = mysql.connector.connect(**DB_CONFIG)
    cursor = connection.cursor(dictionary=True)

    base_query = f"""
        SELECT 
            h.id AS task_id,
            s.logistic_code AS logistic_code,
            s.customer_id AS client_id,
            s.premium AS premium,
            s.address1 AS address,
            s.lat,
            s.lng,
            (
                SELECT duration_minutes 
                FROM app_structure_timings ast
                WHERE ast.structure_type_id = s.structure_type_id
                    AND ast.customer_id = s.customer_id
                    AND ast.structure_operation_id = (
                        CASE WHEN h.operation_id = 0 THEN 2 ELSE h.operation_id END
                    )
                    AND ast.data_contratto <= CURDATE()
                    AND ast.deleted_at IS NULL
                ORDER BY ABS(DATEDIFF(ast.data_contratto, CURDATE()))
                LIMIT 1
            ) AS cleaning_time,
            h.checkin,
            h.checkout,
            h.checkin_time,
            h.checkout_time,
            h.checkin_pax AS pax_in,
            h.checkout_pax AS pax_out,
            s.structure_type_id,
            h.operation_id,
            c.alias AS alias,
            c.name AS customer_name
        FROM app_housekeeping h
        JOIN app_structures s ON h.structure_id = s.id
        LEFT JOIN app_customers c ON s.customer_id = c.id
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

    results = []
    filtered_count = 0
    for r in rows:
        task_id = r.get("task_id")
        
        # Filtra task già assegnate
        if task_id and task_id in assigned_task_ids:
            filtered_count += 1
            continue
        structure_type_id = r.get("structure_type_id")
        op_id = r.get("operation_id")

        if op_id == 0:
            confirmed_operation = False
            output_operation_id = 2
        else:
            confirmed_operation = True
            output_operation_id = op_id

        premium_bool = True if r.get("premium") in (1, True, "1") else False
        straordinaria_bool = True if output_operation_id == 3 else False
        small_equipment_bool = True if structure_type_id == 1 else False

        item = {
            "task_id": r.get("task_id"),
            "logistic_code": r.get("logistic_code"),
            "client_id": r.get("client_id"),
            "premium": premium_bool,
            "address": r.get("address"),
            "lat": normalize_coord(r.get("lat")),
            "lng": normalize_coord(r.get("lng")),
            "cleaning_time": r.get("cleaning_time"),
            "checkin_date": date_to_str(r.get("checkin")) if r.get("checkin") else None,
            "checkout_date": date_to_str(r.get("checkout")) if r.get("checkout") else None,
            "checkin_time": varchar_to_str(r.get("checkin_time")) if r.get("checkin_time") else None,
            "checkout_time": varchar_to_str(r.get("checkout_time")) if r.get("checkout_time") else None,
            "pax_in": r.get("pax_in"),
            "pax_out": r.get("pax_out"),
            "small_equipment": small_equipment_bool,
            "operation_id": output_operation_id,
            "confirmed_operation": confirmed_operation,
            "straordinaria": straordinaria_bool,
            "type_apt": map_structure_type_to_letter(structure_type_id),
            "alias": varchar_to_str(r.get("alias")) if r.get("alias") is not None else None,
            "customer_name": varchar_to_str(r.get("customer_name")) if r.get("customer_name") is not None else None,
        }
        results.append(item)

    if filtered_count > 0:
        print(f"✅ Filtrate {filtered_count} task già assegnate (rimangono {len(results)})")
    
    return results

# ---------- Classificazione task ----------
def classify_tasks(tasks, selected_date):
    # Carica settings
    with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
        settings = json.load(f)

    early_out_config = settings.get("early-out", {})
    high_priority_config = settings.get("high-priority", {})

    eo_time = parse_time(early_out_config.get("eo_time")) or datetime.strptime("10:00", "%H:%M").time()
    hp_time = parse_time(high_priority_config.get("hp_time")) or datetime.strptime("15:30", "%H:%M").time()

    eo_clients = early_out_config.get("eo_clients") or []
    hp_clients = high_priority_config.get("hp_clients") or []

    dedupe_strategy = (settings.get("dedupe_strategy") or "eo_wins").lower()

    early_out_tasks = []
    high_priority_tasks = []
    low_priority_tasks = []

    for task in tasks:
        task_id = task.get("task_id")
        client_id = task.get("client_id")
        is_premium = task.get("premium")

        eo_reasons = []
        hp_reasons = []

        # EARLY OUT
        checkout_time = parse_time(task.get("checkout_time"))
        if checkout_time and checkout_time <= eo_time:
            eo_reasons.append("checkout_time<=eo_time")
        if client_id in eo_clients:
            eo_reasons.append("client_forced_eo")

        # HIGH PRIORITY
        checkin_date = task.get("checkin_date")
        checkout_date = task.get("checkout_date")
        checkin_time = parse_time(task.get("checkin_time"))

        same_day_turnover = (
            bool(checkin_date) and bool(checkout_date) and (checkin_date == checkout_date)
        )

        in_time_window = (
            checkin_time is not None
            and eo_time is not None
            and hp_time is not None
            and (eo_time < checkin_time <= hp_time)
        )

        if same_day_turnover and in_time_window:
            hp_reasons.append("same_day_checkin_between_eo_hp")

        if is_premium:
            hp_reasons.append("premium")

        if client_id in hp_clients:
            hp_reasons.append("client_forced_hp")

        # Classificazione
        task_with_reasons = {**task, "reasons": []}

        if eo_reasons:
            task_with_reasons["reasons"] = eo_reasons
            task_with_reasons["priority"] = "early_out"
            early_out_tasks.append(task_with_reasons)

        if hp_reasons:
            hp_task = {**task, "reasons": hp_reasons, "priority": "high_priority"}
            high_priority_tasks.append(hp_task)

    # Deduplica
    eo_ids = {t["task_id"] for t in early_out_tasks}
    hp_ids = {t["task_id"] for t in high_priority_tasks}

    if dedupe_strategy == "eo_wins":
        high_priority_tasks = [t for t in high_priority_tasks if t["task_id"] not in eo_ids]
    elif dedupe_strategy == "hp_wins":
        early_out_tasks = [t for t in early_out_tasks if t["task_id"] not in hp_ids]

    # LOW PRIORITY
    classified_eo = {t["task_id"] for t in early_out_tasks}
    classified_hp = {t["task_id"] for t in high_priority_tasks}

    for task in tasks:
        tid = task.get("task_id")
        if tid not in classified_eo and tid not in classified_hp:
            low_priority_tasks.append({**task, "priority": "low_priority", "reasons": ["not_eo", "not_hp"]})

    return early_out_tasks, high_priority_tasks, low_priority_tasks

# ---------- Deduplica intelligente task ----------
def deduplicate_tasks(tasks):
    """
    Rimuove task duplicate (stesso logistic_code) mantenendo quella migliore secondo:
    1. Checkin più recente (data più vicina)
    2. Operation_id confermato
    3. Task_id più alto (fallback)
    """
    from datetime import datetime
    
    # Raggruppa per logistic_code
    by_logistic_code = {}
    for task in tasks:
        code = task.get("logistic_code")
        if code not in by_logistic_code:
            by_logistic_code[code] = []
        by_logistic_code[code].append(task)
    
    # Per ogni gruppo, scegli la migliore
    deduplicated = []
    duplicates_removed = 0
    
    for code, task_group in by_logistic_code.items():
        if len(task_group) == 1:
            # Nessun duplicato
            deduplicated.append(task_group[0])
        else:
            # Duplicati trovati - scegli la migliore
            duplicates_removed += len(task_group) - 1
            
            # Ordina per:
            # 1. checkin_date più recente (None = meno prioritario)
            # 2. confirmed_operation = True
            # 3. task_id più alto
            def task_priority(t):
                # Parse checkin_date
                checkin_str = t.get("checkin_date")
                if checkin_str:
                    try:
                        checkin_dt = datetime.strptime(checkin_str, "%Y-%m-%d")
                        # Inverti per ordinare dal più recente
                        checkin_score = -checkin_dt.timestamp()
                    except:
                        checkin_score = float('inf')  # Data invalida = meno prioritario
                else:
                    checkin_score = float('inf')  # Nessuna data = meno prioritario
                
                # confirmed_operation (True = 0, False = 1 per ordinamento)
                confirmed = t.get("confirmed_operation", False)
                confirmed_score = 0 if confirmed else 1
                
                # task_id più alto
                task_id = t.get("task_id", 0)
                task_id_score = -task_id  # Inverti per ordinare dal più alto
                
                return (checkin_score, confirmed_score, task_id_score)
            
            best_task = min(task_group, key=task_priority)
            deduplicated.append(best_task)
            
            print(f"   🔍 Duplicato {code}: mantenuta task_id={best_task.get('task_id')} "
                  f"(checkin={best_task.get('checkin_date') or 'N/A'}, "
                  f"confirmed={best_task.get('confirmed_operation')})")
    
    if duplicates_removed > 0:
        print(f"✅ Rimosse {duplicates_removed} task duplicate dai containers")
    
    return deduplicated

# ---------- Main ----------
def main():
    import sys

    # Leggi la data da argomento CLI se fornita
    if len(sys.argv) > 1:
        work_date = sys.argv[1]
        print(f"Usando data specifica: {work_date}")
    else:
        work_date = None  # Se non specificata, usa la data corrente

    # Leggi task già assegnate dalla timeline
    assigned_task_ids = set()
    timeline_path = OUTPUT_DIR / "timeline.json"
    if timeline_path.exists():
        try:
            timeline_data = json.loads(timeline_path.read_text(encoding="utf-8"))
            for cleaner_entry in timeline_data.get("cleaners_assignments", []):
                for task in cleaner_entry.get("tasks", []):
                    task_id = task.get("task_id")
                    if task_id:
                        assigned_task_ids.add(int(task_id))
            if assigned_task_ids:
                print(f"✅ Task già assegnate nella timeline: {len(assigned_task_ids)}")
        except Exception as e:
            print(f"⚠️ Errore lettura timeline: {e}")

    # Estrai task dal database
    all_tasks = get_tasks_from_db(work_date, assigned_task_ids)

    # Classifica task (senza deduplica - le task duplicate rimangono visibili)
    print(f"🔄 Classificazione task in containers...")
    early_out, high_priority, low_priority = classify_tasks(all_tasks, work_date)

    # Crea output
    output = {
        "metadata": {
            "last_updated": datetime.now().isoformat(),
            "date": work_date
        },
        "containers": {
            "early_out": {
                "tasks": early_out,
                "count": len(early_out)
            },
            "high_priority": {
                "tasks": high_priority,
                "count": len(high_priority)
            },
            "low_priority": {
                "tasks": low_priority,
                "count": len(low_priority)
            }
        },
        "summary": {
            "total_tasks": len(all_tasks),
            "early_out": len(early_out),
            "high_priority": len(high_priority),
            "low_priority": len(low_priority)
        }
    }

    # Salva file
    with open(OUTPUT_CONTAINERS, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\n✅ File containers.json creato con successo!")
    print(f"   📅 Data: {work_date}")
    print(f"   📦 Task totali: {len(all_tasks)}")
    print(f"   🔴 Early-Out: {len(early_out)}")
    print(f"   🟡 High-Priority: {len(high_priority)}")
    print(f"   🟢 Low-Priority: {len(low_priority)}")
    print(f"   💾 Salvato in: {OUTPUT_CONTAINERS}")

# ---------- Funzione per estrazione task con filtro già assegnate ----------
def extract_tasks_from_db(work_date=None, assigned_task_ids=None):
    """
    Estrae task dal database per la data specificata (o oggi se non specificata)
    Ritorna una lista di task con tutti i campi necessari
    Esclude le task già assegnate nella timeline
    """
    import os
    from dotenv import load_dotenv
    import psycopg2
    from datetime import datetime

    if assigned_task_ids is None:
        assigned_task_ids = set()

    # Carica variabili d'ambiente
    load_dotenv()

    # Connessione al database
    conn = psycopg2.connect(
        host=os.getenv("DB_HOST"),
        database=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
        port=os.getenv("DB_PORT")
    )

    cursor = conn.cursor()

    # Se non specificata, usa la data corrente
    if work_date is None:
        work_date = datetime.now().strftime("%Y-%m-%d")

    print(f"📋 Estrazione task dal database per {work_date}...")

    # Ottieni le operation_ids attive
    ops = get_active_operations()
    save_operations_to_file(ops)

    valid_operation_ids = ops + [0, None]
    non_null_operation_ids = [op for op in valid_operation_ids if op is not None]
    operation_placeholders = ','.join(['%s'] * len(non_null_operation_ids)) if non_null_operation_ids else 'NULL'

    base_query = f"""
        SELECT 
            h.id AS task_id,
            s.logistic_code AS logistic_code,
            s.customer_id AS client_id,
            s.premium AS premium,
            s.address1 AS address,
            s.lat,
            s.lng,
            (
                SELECT duration_minutes 
                FROM app_structure_timings ast
                WHERE ast.structure_type_id = s.structure_type_id
                    AND ast.customer_id = s.customer_id
                    AND ast.structure_operation_id = (
                        CASE WHEN h.operation_id = 0 THEN 2 ELSE h.operation_id END
                    )
                    AND ast.data_contratto <= CURDATE()
                    AND ast.deleted_at IS NULL
                ORDER BY ABS(DATEDIFF(ast.data_contratto, CURDATE()))
                LIMIT 1
            ) AS cleaning_time,
            h.checkin,
            h.checkout,
            h.checkin_time,
            h.checkout_time,
            h.checkin_pax AS pax_in,
            h.checkout_pax AS pax_out,
            s.structure_type_id,
            h.operation_id,
            c.alias AS alias,
            c.name AS customer_name
        FROM app_housekeeping h
        JOIN app_structures s ON h.structure_id = s.id
        LEFT JOIN app_customers c ON s.customer_id = c.id
        WHERE h.checkout = %s
          AND h.deleted_at IS NULL
          AND h.deleted_at_client IS NULL
          AND s.lat IS NOT NULL AND s.lng IS NOT NULL
          AND s.lat != '' AND s.lng != ''
          AND s.lat != '0' AND s.lng != '0'
    """

    params = [work_date]
    if non_null_operation_ids:
        base_query += f" AND (h.operation_id IN ({operation_placeholders}) OR h.operation_id IS NULL OR h.operation_id = 0)"
        params += non_null_operation_ids

    cursor.execute(base_query, params)
    rows = cursor.fetchall()

    tasks = []
    for r in rows:
        structure_type_id = r.get("structure_type_id")
        op_id = r.get("operation_id")

        if op_id == 0:
            confirmed_operation = False
            output_operation_id = 2
        else:
            confirmed_operation = True
            output_operation_id = op_id

        premium_bool = True if r.get("premium") in (1, True, "1") else False
        straordinaria_bool = True if output_operation_id == 3 else False
        small_equipment_bool = True if structure_type_id == 1 else False

        item = {
            "task_id": r.get("task_id"),
            "logistic_code": r.get("logistic_code"),
            "client_id": r.get("client_id"),
            "premium": premium_bool,
            "address": r.get("address"),
            "lat": normalize_coord(r.get("lat")),
            "lng": normalize_coord(r.get("lng")),
            "cleaning_time": r.get("cleaning_time"),
            "checkin_date": date_to_str(r.get("checkin")) if r.get("checkin") else None,
            "checkout_date": date_to_str(r.get("checkout")) if r.get("checkout") else None,
            "checkin_time": varchar_to_str(r.get("checkin_time")) if r.get("checkin_time") else None,
            "checkout_time": varchar_to_str(r.get("checkout_time")) if r.get("checkout_time") else None,
            "pax_in": r.get("pax_in"),
            "pax_out": r.get("pax_out"),
            "small_equipment": small_equipment_bool,
            "operation_id": output_operation_id,
            "confirmed_operation": confirmed_operation,
            "straordinaria": straordinaria_bool,
            "type_apt": map_structure_type_to_letter(structure_type_id),
            "alias": varchar_to_str(r.get("alias")) if r.get("alias") is not None else None,
            "customer_name": varchar_to_str(r.get("customer_name")) if r.get("customer_name") is not None else None,
        }
        tasks.append(item)

    cursor.close()
    conn.close()

    # Filtra task già assegnate
    if assigned_task_ids:
        original_count = len(tasks)
        tasks = [t for t in tasks if t["task_id"] not in assigned_task_ids]
        filtered_count = original_count - len(tasks)
        if filtered_count > 0:
            print(f"✅ Filtrate {filtered_count} task già assegnate (rimangono {len(tasks)})")

    print(f"✅ Estratte {len(tasks)} task dal database")
    return tasks

if __name__ == "__main__":
    main()