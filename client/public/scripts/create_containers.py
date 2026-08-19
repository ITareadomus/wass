# -*- coding: utf-8 -*-
import json
import mysql.connector
import sys
from datetime import datetime, date, timedelta
from pathlib import Path
import argparse
import subprocess

# ---------- Config ----------
BASE_DIR = Path(__file__).parent.parent / "data"
INPUT_DIR = BASE_DIR / "input"
OUTPUT_DIR = BASE_DIR / "output"
SETTINGS_PATH = INPUT_DIR / "settings.json"
OUTPUT_CONTAINERS = OUTPUT_DIR / "containers.json"

# API-only mode: load ApiClient
USE_API = False
api_client = None

def init_api_client(workflow="housekeeping"):
    global api_client
    try:
        from api_client import ApiClient
        scope = "office" if workflow == "office" else "housekeeping"
        api_client = ApiClient(scope=scope)
        print(f"API client scope: {scope}")
        return api_client.test_connection()
    except Exception as e:
        print(f"⚠️ Failed to initialize API client: {e}")
        return False

# Script paths
EXTRACT_CLEANERS_SCRIPT = Path(__file__).parent / "extract_cleaners_optimized.py"


# Crea le directory se non esistono
INPUT_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ---------- Config DB ----------
from db_config import db_config as DB_CONFIG

# ---------- Utilità ----------
def date_to_str(value):
    if isinstance(value, (datetime, date)):
        return value.strftime('%Y-%m-%d')
    return value

def varchar_to_str(value):
    if value is None:
        return None
    # Treat empty strings as None
    s = str(value).strip()
    return s if s else None

def normalize_time_hhmm(value):
    """Normalizza TIME MySQL / stringhe a HH:MM (compatibile con PG VARCHAR(10))."""
    if value is None:
        return None
    # datetime.timedelta from MySQL TIME
    try:
        from datetime import timedelta
        if isinstance(value, timedelta):
            total = int(value.total_seconds())
            if total < 0:
                return None
            hh = (total // 3600) % 24
            mm = (total % 3600) // 60
            return f"{hh:02d}:{mm:02d}"
    except Exception:
        pass
    s = varchar_to_str(value)
    if not s:
        return None
    # "14:30:00" / "14:30" / "9:05:00"
    parts = s.replace(".", ":").split(":")
    try:
        hh = int(parts[0])
        mm = int(parts[1]) if len(parts) > 1 else 0
        if 0 <= hh <= 23 and 0 <= mm <= 59:
            return f"{hh:02d}:{mm:02d}"
    except (TypeError, ValueError):
        return s
    return s

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


def get_active_operations_logistics():
    """Operazioni WASS Logistics (route drivers) — stesso schema di enable_wass per housekeeping."""
    connection = mysql.connector.connect(**DB_CONFIG)
    cursor = connection.cursor(dictionary=True)
    cursor.execute("""
        SELECT id
        FROM app_structure_operation
        WHERE active = 1 AND enable_wass_route = 1
    """)
    results = cursor.fetchall()
    cursor.close()
    connection.close()
    return [row['id'] for row in results]


def get_active_operations_office():
    """Operazioni consentite per workflow uffici."""
    return [15, 38]

def get_operation_names(operation_ids):
    """Recupera i nomi delle operazioni dalla tabella app_structure_operation_langs"""
    if not operation_ids:
        return {}

    connection = mysql.connector.connect(**DB_CONFIG)
    cursor = connection.cursor(dictionary=True)

    placeholders = ','.join(['%s'] * len(operation_ids))
    query = f"""
        SELECT structure_operation_id, name
        FROM app_structure_operation_langs
        WHERE id_lang = 1 AND structure_operation_id IN ({placeholders})
    """

    cursor.execute(query, operation_ids)
    results = cursor.fetchall()
    cursor.close()
    connection.close()

    # Crea dizionario id -> nome
    operation_names = {}
    for row in results:
        operation_names[row['structure_operation_id']] = row['name']

    return operation_names

# ---------- Estrazione task dal DB ----------
def get_tasks_from_db(selected_date, assigned_task_ids=None, workflow="housekeeping"):
    if assigned_task_ids is None:
        assigned_task_ids = set()

    if workflow == "logistics":
        print(f"Aggiorno la lista delle operazioni attive (enable_wass_route) dal DB...")
        ops = get_active_operations_logistics()
    elif workflow == "office":
        print("Workflow office: filtro operation_id consentiti [15, 38]")
        ops = get_active_operations_office()
    else:
        print(f"Aggiorno la lista delle operazioni attive (enable_wass) dal DB...")
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
                    AND ast.structure_activity_id = h.activity_id
                    AND ast.data_contratto <= h.checkout
                    AND ast.deleted_at IS NULL
                ORDER BY ast.data_contratto DESC
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
            c.name AS customer_name,
            s.customer_structure_reference AS customer_reference
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
            "checkin_time": normalize_time_hhmm(r.get("checkin_time")),
            "checkout_time": normalize_time_hhmm(r.get("checkout_time")),
            "pax_in": r.get("pax_in"),
            "pax_out": r.get("pax_out"),
            "small_equipment": small_equipment_bool,
            "operation_id": output_operation_id,
            "confirmed_operation": confirmed_operation,
            "straordinaria": straordinaria_bool,
            "type_apt": map_structure_type_to_letter(structure_type_id),
            "alias": varchar_to_str(r.get("alias")) if r.get("alias") is not None else None,
            "customer_name": varchar_to_str(r.get("customer_name")) if r.get("customer_name") is not None else None,
            "customer_reference": varchar_to_str(r.get("customer_reference")) if r.get("client_id") == 3 and r.get("customer_reference") is not None else None,
        }
        results.append(item)

    if filtered_count > 0:
        print(f"✅ Filtrate {filtered_count} task già assegnate (rimangono {len(results)})")

    return results

# ---------- Classificazione task ----------
def classify_tasks(tasks, selected_date, use_api=False):
    # Carica settings da API o filesystem
    if use_api:
        from api_client import load_settings_from_api
        settings = load_settings_from_api()
    else:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
            settings = json.load(f)

    early_out_config = settings.get("early-out", {})
    high_priority_config = settings.get("high-priority", {})

    hp_start_time = parse_time(high_priority_config.get("hp_start_time"))
    hp_end_time = parse_time(high_priority_config.get("hp_end_time"))
    if hp_start_time is None or hp_end_time is None:
        raise ValueError(
            "Priority settings invalid: high-priority.hp_start_time and "
            "high-priority.hp_end_time are required in HH:MM format"
        )
    if hp_end_time < hp_start_time:
        raise ValueError(
            "Priority settings invalid: high-priority.hp_end_time must be "
            "greater than or equal to hp_start_time"
        )

    eo_clients = {str(client_id).strip() for client_id in (early_out_config.get("eo_clients") or [])}
    hp_clients = {str(client_id).strip() for client_id in (high_priority_config.get("hp_clients") or [])}

    dedupe_strategy = settings.get("dedupe_strategy")
    if dedupe_strategy not in ("eo_wins", "hp_wins"):
        raise ValueError("Priority settings invalid: dedupe_strategy must be eo_wins or hp_wins")

    early_out_tasks = []
    high_priority_tasks = []
    low_priority_tasks = []

    def is_truthy(value):
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value == 1
        if isinstance(value, str):
            return value.strip().lower() in ("true", "1", "yes")
        return False

    for task in tasks:
        task_id = task.get("task_id")
        client_id = str(task.get("client_id")).strip() if task.get("client_id") is not None else None
        is_premium = is_truthy(task.get("premium"))

        eo_reasons = []
        hp_reasons = []

        # EARLY OUT
        checkout_time = parse_time(task.get("checkout_time"))

        if checkout_time is not None and checkout_time < hp_start_time:
            eo_reasons.append("checkout_before_hp_start")

        if client_id is not None and client_id in eo_clients:
            eo_reasons.append("client_forced_eo")

        # HIGH PRIORITY
        checkin_date = task.get("checkin_date")
        checkout_date = task.get("checkout_date")
        checkin_time = parse_time(task.get("checkin_time"))

        same_day_turnover = (
            bool(checkin_date) and bool(checkout_date) and (checkin_date == checkout_date)
        )

        if same_day_turnover and checkin_time is not None and (hp_start_time <= checkin_time <= hp_end_time):
            hp_reasons.append("same_day_checkin_between_hp_start_hp_end")

        if is_premium:
            hp_reasons.append("premium")

        if client_id is not None and client_id in hp_clients:
            hp_reasons.append("client_forced_hp")

        eo_match = bool(eo_reasons)
        hp_match = bool(hp_reasons)
        reasons = eo_reasons + hp_reasons

        if eo_match and hp_match:
            priority = "early_out" if dedupe_strategy == "eo_wins" else "high_priority"
        elif eo_match:
            priority = "early_out"
        elif hp_match:
            priority = "high_priority"
        else:
            priority = "low_priority"
            reasons = ["not_eo", "not_hp"]

        task_with_priority = {**task, "priority": priority, "reasons": reasons}
        if priority == "early_out":
            early_out_tasks.append(task_with_priority)
        elif priority == "high_priority":
            high_priority_tasks.append(task_with_priority)
        else:
            low_priority_tasks.append(task_with_priority)

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
                        # Normalizza formato ISO (es. "2025-12-13T00:00:00.000Z" -> "2025-12-13")
                        normalized_date = checkin_str.split('T')[0] if 'T' in checkin_str else checkin_str
                        checkin_dt = datetime.strptime(normalized_date, "%Y-%m-%d")
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
    global USE_API
    
    parser = argparse.ArgumentParser(description='Crea containers.json per una data specifica.')
    parser.add_argument('--date', type=str, help='Data nel formato YYYY-MM-DD (es. 2025-11-17)')
    parser.add_argument('--skip-extract', action='store_true', help='Salta estrazione cleaners (usa quelli già presenti)')
    parser.add_argument('--use-api', action='store_true', help='Usa API per salvare i dati (OBBLIGATORIO)')
    parser.add_argument(
        '--workflow',
        type=str,
        choices=['housekeeping', 'office', 'logistics'],
        default='housekeeping',
        help='housekeeping: enable_wass (default). office: operation_id [15,38]. logistics: enable_wass_route → /api/logistics-containers',
    )
    args = parser.parse_args()
    workflow = getattr(args, 'workflow', 'housekeeping') or 'housekeeping'

    target_date = args.date if args.date else None
    if target_date:
        print(f"Usando data specifica: {target_date}")
    else:
        target_date = datetime.now().strftime('%Y-%m-%d')
        print(f"Nessuna data specificata, usando oggi: {target_date}")
    
    # API mode initialization
    if args.use_api:
        if init_api_client(workflow):
            print("✅ API client connesso - salvataggio via API")
            USE_API = True
        else:
            raise RuntimeError("❌ Errore: --use-api specificato ma API non disponibile")
    else:
        raise RuntimeError("❌ Errore: --use-api è obbligatorio. Lo script usa solo API, non filesystem.")

    # Estrai i cleaners per la data target SOLO se non usiamo dati salvati
    if not args.skip_extract:
        print("Estraggo i cleaners dal database...")
        subprocess.run(
            [sys.executable, str(EXTRACT_CLEANERS_SCRIPT), "--date", target_date],
            check=True,
        )
    else:
        print("⏭️ Salto estrazione cleaners (--skip-extract attivo), uso selected_cleaners.json esistente")


    # Leggi timeline da API per aggiornare i dati delle task assegnate (solo housekeeping)
    assigned_task_ids = set()
    timeline_data = None

    if workflow != "logistics":
        try:
            timeline_data = api_client.load_timeline(target_date)
            if timeline_data:
                for cleaner_entry in timeline_data.get("cleaners_assignments", []):
                    for task in cleaner_entry.get("tasks", []):
                        task_id = task.get("task_id")
                        if task_id:
                            assigned_task_ids.add(int(task_id))
                if assigned_task_ids:
                    print(f"✅ Task già assegnate nella timeline: {len(assigned_task_ids)}")
        except Exception as e:
            print(f"⚠️ Errore lettura timeline da API: {e}")
    else:
        print("⏭️ Workflow logistics: salto lettura/merge timeline housekeeping")

    # Estrai TUTTE le task dal database (anche quelle assegnate per aggiornarle)
    all_tasks_from_db = get_tasks_from_db(
        target_date, assigned_task_ids=set(), workflow=workflow
    )  # Non filtrare

    # CRITICAL: Preserva timeline aggiornando SOLO i dati modificati dal DB
    if workflow != "logistics" and timeline_data and assigned_task_ids:
        db_tasks_map = {}
        for task in all_tasks_from_db:
            tid = task.get("task_id")
            try:
                tid_int = int(tid)
            except (TypeError, ValueError):
                continue
            db_tasks_map[tid_int] = task
        updated_count = 0

        for cleaner_entry in timeline_data.get("cleaners_assignments", []):
            for task in cleaner_entry.get("tasks", []):
                task_id = task.get("task_id")
                try:
                    task_id_int = int(task_id) if task_id is not None else None
                except (TypeError, ValueError):
                    task_id_int = None
                if task_id_int and task_id_int in db_tasks_map:
                    fresh_data = db_tasks_map[task_id_int]

                    # CRITICAL: Campi da aggiornare dal DB (NON toccare campi timeline)
                    # Preserva: start_time, end_time, travel_time, sequence, followup, priority, reasons
                    fields_to_update = [
                        "logistic_code", "client_id", "premium", "address", "lat", "lng",
                        "cleaning_time", "checkin_date", "checkout_date", "checkin_time",
                        "checkout_time", "pax_in", "pax_out", "small_equipment",
                        "operation_id", "confirmed_operation", "straordinaria",
                        "type_apt", "alias", "customer_name", "customer_reference"
                    ]

                    for field in fields_to_update:
                        if field in fresh_data:
                            task[field] = fresh_data[field]

                    updated_count += 1

        if updated_count > 0:
            # Salva timeline via API preservando metadata e struttura
            # skip_recalculate=True: solo patch campi ADAM, senza ricalcolo orari
            # (evita timeout HTTP e non deve cambiare start/end/travel in modalità apt)
            if "metadata" not in timeline_data or timeline_data["metadata"] is None:
                timeline_data["metadata"] = {}
            timeline_data["metadata"]["last_updated"] = datetime.now().isoformat()
            # NON cambiare la data - mantieni quella della timeline
            api_client.save_timeline(target_date, timeline_data, skip_recalculate=True)
            print(f"✅ Aggiornate {updated_count} task in timeline via API (preservati campi timeline: start_time, end_time, travel_time, sequence; skipRecalculate)")

    # Filtra le task già assegnate per containers.json (solo housekeeping)
    if workflow != "logistics":
        all_tasks = [t for t in all_tasks_from_db if t["task_id"] not in assigned_task_ids]
    else:
        all_tasks = list(all_tasks_from_db)

    # Classifica task (senza deduplica - le task duplicate rimangono visibili)
    print(f"🔄 Classificazione task in containers...")
    early_out, high_priority, low_priority = classify_tasks(all_tasks, target_date, use_api=True)

    # Crea output
    output = {
        "metadata": {
            "last_updated": datetime.now().isoformat(),
            "date": target_date
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

    # Salva containers via API
    if workflow == "logistics":
        api_client.save_logistics_containers(target_date, output)
        print(f"\n✅ Logistics containers salvati via API con successo!")
    else:
        api_client.save_containers(target_date, output)
        print(f"\n✅ Containers salvati via API con successo!")
    print(f"   📅 Data: {target_date}")
    print(f"   📦 Task totali: {len(all_tasks)}")
    print(f"   🔴 Early-Out: {len(early_out)}")
    print(f"   🟡 High-Priority: {len(high_priority)}")
    print(f"   🟢 Low-Priority: {len(low_priority)}")

# ---------- Funzione per estrazione task con filtro già assegnate ----------
def extract_tasks_from_db(work_date=None, assigned_task_ids=None, workflow="housekeeping"):
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

    if workflow == "logistics":
        ops = get_active_operations_logistics()
    elif workflow == "office":
        ops = get_active_operations_office()
    else:
        ops = get_active_operations()

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
                    AND ast.structure_activity_id = h.activity_id
                    AND ast.data_contratto <= h.checkout
                    AND ast.deleted_at IS NULL
                ORDER BY ast.data_contratto DESC
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
            c.name AS customer_name,
            s.customer_structure_reference AS customer_reference
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
            "checkin_time": normalize_time_hhmm(r.get("checkin_time")),
            "checkout_time": normalize_time_hhmm(r.get("checkout_time")),
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