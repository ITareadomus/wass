import json
import os
import psycopg2
from datetime import datetime, timedelta
from pathlib import Path
import sys

# --- PATH ---
BASE_DIR = Path("client/public/data")
OUTPUT_DIR = BASE_DIR / "output"
EO_JSON = OUTPUT_DIR / "early_out.json"
HP_JSON = OUTPUT_DIR / "high_priority.json"
LP_JSON = OUTPUT_DIR / "low_priority.json"
DEBUG_JSON = OUTPUT_DIR / "extract_all_debug.json"

# Crea le directory se non esistono
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

def get_pg_connection():
    """Stabilisce la connessione al database PostgreSQL."""
    database_url = os.environ.get('DATABASE_URL')
    if not database_url:
        raise Exception("DATABASE_URL environment variable not set")
    return psycopg2.connect(database_url)

def load_tasks_from_db(work_date):
    """Carica i task dal database PostgreSQL per la data specificata."""
    pg_conn = get_pg_connection()
    pg_cur = pg_conn.cursor()

    query = """
        SELECT 
            task_id, logistic_code, client_id, premium, address, lat, lng,
            cleaning_time, checkin_date, checkout_date, checkin_time, checkout_time,
            pax_in, pax_out, small_equipment, operation_id, confirmed_operation,
            straordinaria, type_apt, alias, customer_name, priority, status, reasons
        FROM tasks
        WHERE work_date = %s
        ORDER BY task_id
    """
    pg_cur.execute(query, (work_date,))

    rows = pg_cur.fetchall()
    pg_cur.close()
    pg_conn.close()

    tasks = []
    for row in rows:
        tasks.append({
            "task_id": row[0],
            "logistic_code": row[1],
            "client_id": row[2],
            "premium": row[3],
            "address": row[4],
            "lat": row[5],
            "lng": row[6],
            "cleaning_time": row[7],
            "checkin_date": str(row[8]) if row[8] else None,
            "checkout_date": str(row[9]) if row[9] else None,
            "checkin_time": row[10],
            "checkout_time": row[11],
            "pax_in": row[12],
            "pax_out": row[13],
            "small_equipment": row[14],
            "operation_id": row[15],
            "confirmed_operation": row[16],
            "straordinaria": row[17],
            "type_apt": row[18],
            "alias": row[19],
            "customer_name": row[20],
            "priority": row[21],
            "status": row[22],
            "reasons": row[23] if row[23] else []
        })

    return tasks

def parse_time(t):
    """Converte una stringa orario in oggetto time."""
    if not t:
        return None
    try:
        return datetime.strptime(t, "%H:%M").time()
    except ValueError:
        return None

def categorize_tasks(tasks, settings):
    """Categorizza i task in EO, HP e LP basandosi sulle impostazioni."""
    early_out_config = settings.get("early-out", {})
    high_priority_config = settings.get("high-priority", {})

    eo_time = parse_time(early_out_config.get("eo_time")) or datetime.strptime("10:00", "%H:%M").time()
    hp_time = parse_time(high_priority_config.get("hp_time")) or datetime.strptime("15:30", "%H:%M").time()

    eo_clients = early_out_config.get("eo_clients") or []
    hp_clients = high_priority_config.get("hp_clients") or []

    dedupe_strategy = (settings.get("dedupe_strategy") or "eo_wins").lower()
    if dedupe_strategy not in {"eo_wins", "hp_wins"}:
        raise ValueError("dedupe_strategy deve essere 'eo_wins' o 'hp_wins'.")

    early_out_selected = []
    high_priority_selected = []
    audit_log = []

    for task in tasks:
        task_id = task.get("task_id")
        client_id = task.get("client_id")
        is_premium = bool(task.get("premium", False))

        eo_reasons = []
        hp_reasons = []
        final_class = None

        # EARLY OUT
        checkout_time_str = task.get("checkout_time")
        checkout_time = parse_time(checkout_time_str)

        if checkout_time and checkout_time <= eo_time:
            eo_reasons.append("checkout_time<=eo_time")
        if client_id in eo_clients:
            eo_reasons.append("client_forced_eo")

        # HIGH PRIORITY
        checkin_date = task.get("checkin_date")
        checkout_date = task.get("checkout_date")
        checkin_time_str = task.get("checkin_time")
        checkin_time = parse_time(checkin_time_str)

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

        # Classificazione iniziale (prima della deduplica)
        if eo_reasons:
            final_class = "EO"
        elif hp_reasons:
            final_class = "HP"
        else:
            final_class = "LP"

        audit_log.append({
            "task_id": task_id,
            "client_id": client_id,
            "premium": is_premium,
            "final_class": final_class,  # verrà aggiornato dopo deduplica
            "reasons": eo_reasons if eo_reasons else (hp_reasons if hp_reasons else ["not_eo", "not_hp"])
        })

        if eo_reasons:
            early_out_selected.append({**task, "premium": is_premium, "reasons": eo_reasons})
        if hp_reasons:
            high_priority_selected.append({**task, "premium": is_premium, "reasons": hp_reasons})

    # Deduplica EO vs HP con precedenza
    eo_ids = {t["task_id"] for t in early_out_selected}
    hp_ids = {t["task_id"] for t in high_priority_selected}

    if dedupe_strategy == "eo_wins":
        high_priority_selected = [t for t in high_priority_selected if t["task_id"] not in eo_ids]
    elif dedupe_strategy == "hp_wins":
        early_out_selected = [t for t in early_out_selected if t["task_id"] not in hp_ids]

    # LOW PRIORITY
    classified_eo = {t["task_id"] for t in early_out_selected}
    classified_hp = {t["task_id"] for t in high_priority_selected}
    low_priority_selected = []

    for task in tasks:
        tid = task.get("task_id")
        if tid in classified_eo or tid in classified_hp:
            continue
        low_priority_selected.append({**task, "premium": bool(task.get("premium", False))})

    # Aggiorna final_class nel debug dopo la deduplica
    for entry in audit_log:
        tid = entry["task_id"]
        if tid in classified_eo:
            entry["final_class"] = "EO"
        elif tid in classified_hp:
            entry["final_class"] = "HP"
        else:
            entry["final_class"] = "LP"

    return early_out_selected, high_priority_selected, low_priority_selected, audit_log, dedupe_strategy

def main():
    # Determina la data di lavoro (dal primo task o default)
    if len(sys.argv) > 1:
        work_date = sys.argv[1]
    else:
        work_date = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")

    # Carica i task dal database
    tasks = load_tasks_from_db(work_date)

    # Carica settings (questo dovrà essere adattato se le settings sono nel DB)
    # Per ora, assumiamo che esista ancora un settings.json per la configurazione
    SETTINGS_PATH = Path("client/public/input/settings.json")
    try:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
            settings = json.load(f)
    except FileNotFoundError:
        print(f"Attenzione: File settings.json non trovato in {SETTINGS_PATH}. Verranno usati valori di default.")
        settings = {}


    # Categorizza
    eo, hp, lp, audit, dedupe_strategy = categorize_tasks(tasks, settings)

    # Salva i file JSON
    with EO_JSON.open("w", encoding="utf-8") as f:
        json.dump({"early_out_tasks": eo, "total_apartments": len(eo)}, f, ensure_ascii=False, indent=2)

    with HP_JSON.open("w", encoding="utf-8") as f:
        json.dump({"high_priority_tasks": hp, "total_apartments": len(hp)}, f, ensure_ascii=False, indent=2)

    with LP_JSON.open("w", encoding="utf-8") as f:
        json.dump({"low_priority_tasks": lp, "total_apartments": len(lp)}, f, ensure_ascii=False, indent=2)

    with DEBUG_JSON.open("w", encoding="utf-8") as f:
        json.dump({"audit": audit, "work_date": work_date, "dedupe_strategy": dedupe_strategy}, f, ensure_ascii=False, indent=2)

    print(
        f"Generati:\n- {EO_JSON}\n- {HP_JSON}\n- {LP_JSON}\n- {DEBUG_JSON}\n"
        f"Strategia deduplica EO/HP: {dedupe_strategy}"
    )

if __name__ == "__main__":
    main()