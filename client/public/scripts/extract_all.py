import json
from datetime import datetime
from pathlib import Path
import mysql.connector # Importa il connettore MySQL

# --- CONFIGURAZIONE DATABASE ---
DB_CONFIG = {
    "host": "139.59.132.41",
    "user": "admin",
    "password": "ed329a875c6c4ebdf4e87e2bbe53a15771b5844ef6606dde",
    "database": "adamdb"
}
# --- FINE CONFIGURAZIONE DATABASE ---


# --- PATH ---
# Use a project-relative data folder so the script works on Windows and UNIX
# BASE_DIR points to client/public/data (from workspace root)
BASE_DIR = Path("client/public/data")
INPUT_DIR = BASE_DIR / "input"
OUTPUT_DIR = BASE_DIR / "output"
INPUT_PATH = INPUT_DIR / "daily_tasks.json"
SETTINGS_PATH = INPUT_DIR / "settings.json"
EO_JSON = OUTPUT_DIR / "early_out.json"
HP_JSON = OUTPUT_DIR / "high_priority.json"
LP_JSON = OUTPUT_DIR / "low_priority.json"
DEBUG_JSON = OUTPUT_DIR / "extract_all_debug.json"

# Crea le directory se non esistono
INPUT_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# --- DATABASE FUNCTIONS ---
def update_task_priority_in_db(tasks, priority, work_date):
    """Aggiorna la priority e i reasons dei task già presenti in wass_task_containers"""
    try:
        conn = mysql.connector.connect(**DB_CONFIG)
        cur = conn.cursor()

        updated_count = 0
        for task in tasks:
            # UPDATE della priority e reasons per task_id
            cur.execute("""
                UPDATE wass_task_containers 
                SET priority = %s, reasons = %s
                WHERE date = %s AND task_id = %s
            """, (
                priority,
                json.dumps(task.get("reasons", [])),
                work_date,
                task.get("task_id")
            ))
            updated_count += cur.rowcount

        conn.commit()
        cur.close()
        conn.close()
        print(f"✅ Aggiornati {updated_count} task a priority={priority}")
        return True
    except Exception as e:
        print(f"❌ Errore aggiornando priority {priority} nel DB: {e}")
        return False


def parse_time(t):
    if not t:
        return None
    try:
        return datetime.strptime(t, "%H:%M").time()
    except ValueError:
        return None

# ---- Carica dati principali ----
with open(INPUT_PATH, "r", encoding="utf-8") as f:
    data = json.load(f)

# ---- Carica settings ----
with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
    settings = json.load(f)

# ---- Parametri / default ----
early_out_config = settings.get("early-out", {})
high_priority_config = settings.get("high-priority", {})

eo_time = parse_time(early_out_config.get("eo_time")) or datetime.strptime("10:00", "%H:%M").time()
hp_time = parse_time(high_priority_config.get("hp_time")) or datetime.strptime("15:30", "%H:%M").time()

eo_clients = early_out_config.get("eo_clients") or []
hp_clients = high_priority_config.get("hp_clients") or []
if not isinstance(eo_clients, list):
    raise ValueError("'eo_clients' deve essere una lista di client_id.")
if not isinstance(hp_clients, list):
    raise ValueError("'hp_clients' deve essere una lista di client_id.")

# Strategia deduplica: "eo_wins" (default) oppure "hp_wins"
dedupe_strategy = (settings.get("dedupe_strategy") or "eo_wins").lower()
if dedupe_strategy not in {"eo_wins", "hp_wins"}:
    raise ValueError("dedupe_strategy deve essere 'eo_wins' o 'hp_wins'.")

# ---- Prelevamento data e controllo ----
dates_dict = data.get("dates") or {}
date_keys = list(dates_dict.keys())
if not date_keys:
    raise ValueError("Nessuna data trovata nel JSON in 'dates'.")
if len(date_keys) > 1:
    raise ValueError(f"Il JSON dovrebbe contenere una sola data, trovate: {date_keys}")

date_key = date_keys[0]
tasks_list = (dates_dict[date_key].get("apt") or [])

# ---- Selezioni + motivazioni ----
early_out_selected = []
high_priority_selected = []

# --- Per debug ---
audit_log = []

for task in tasks_list:
    task_id = task.get("task_id")
    client_id = task.get("client_id")
    is_premium = bool(task.get("premium", False))

    eo_reasons = []
    hp_reasons = []
    final_class = None

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

    # --- Classificazione iniziale (prima della deduplica) ---
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

# ---- Deduplica EO vs HP con precedenza ----
eo_ids = {t["task_id"] for t in early_out_selected}
hp_ids = {t["task_id"] for t in high_priority_selected}

if dedupe_strategy == "eo_wins":
    high_priority_selected = [t for t in high_priority_selected if t["task_id"] not in eo_ids]
elif dedupe_strategy == "hp_wins":
    early_out_selected = [t for t in early_out_selected if t["task_id"] not in hp_ids]

# ---- LOW PRIORITY ----
classified_eo = {t["task_id"] for t in early_out_selected}
classified_hp = {t["task_id"] for t in high_priority_selected}
low_priority_selected = []

for task in tasks_list:
    tid = task.get("task_id")
    if tid in classified_eo or tid in classified_hp:
        continue
    low_priority_selected.append({**task, "premium": bool(task.get("premium", False))})

# ---- Aggiorna final_class nel debug dopo la deduplica ----
for entry in audit_log:
    tid = entry["task_id"]
    if tid in classified_eo:
        entry["final_class"] = "EO"
    elif tid in classified_hp:
        entry["final_class"] = "HP"
    else:
        entry["final_class"] = "LP"

# --- 5) Salva i container nel database ---
# Prepara i dati per la funzione save_container_to_db
eo_output = {
    "early_out_tasks": early_out_selected,
    "total_apartments": len(early_out_selected),
    "current_date": date_key
}
hp_output = {
    "high_priority_tasks": high_priority_selected,
    "total_apartments": len(high_priority_selected),
    "current_date": date_key
}
lp_output = {
    "low_priority_tasks": low_priority_selected,
    "total_apartments": len(low_priority_selected),
    "current_date": date_key
}

# Aggiorna le priority nel database (i task sono già stati inseriti da task_extractor)
update_task_priority_in_db(eo_output["early_out_tasks"], "early_out", date_key)
update_task_priority_in_db(hp_output["high_priority_tasks"], "high_priority", date_key)
update_task_priority_in_db(lp_output["low_priority_tasks"], "low_priority", date_key)

# Scrivi solo il debug in JSON
with open(DEBUG_JSON, "w", encoding="utf-8") as f:
    json.dump({"audit": audit_log}, f, indent=2, ensure_ascii=False)

print(f"✅ Container salvati nel database per la data {date_key}")
print(f"Generato:\n- {DEBUG_JSON}")
print(f"Strategia deduplica EO/HP: {dedupe_strategy}")