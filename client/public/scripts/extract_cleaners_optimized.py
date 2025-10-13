import json
import mysql.connector
import sys
from datetime import datetime, timedelta
from pathlib import Path

# Configurazione del database (lasciata invariata rispetto allo script originale)
db_config = {
    "host": "139.59.132.41",
    "user": "admin",
    "password": "ed329a875c6c4ebdf4e87e2bbe53a15771b5844ef6606dde",
    "database": "adamdb"
}

# --- UTIL ---------------------------------------------------------------

def _today():
    return datetime.now().date()

def _monday_of(d):
    return d - timedelta(days=d.weekday())

def _daterange(start, end_excl):
    cur = start
    while cur < end_excl:
        yield cur
        cur += timedelta(days=1)

# --- CALCOLO DATE -------------------------------------------------------
# Manteniamo la stessa semantica dello script originale:
# - target_date = domani se non specificato da argv
# - counter_days si basa su "ieri" rispetto ad OGGI reale
if len(sys.argv) > 1:
    try:
        selected_date_str = sys.argv[1]
        target_date = datetime.strptime(selected_date_str, "%Y-%m-%d").date()
        print(f"📅 DATA SPECIFICATA DALL'INTERFACCIA: {selected_date_str}")
        print(f"✅ Generando dati cleaner per la data: {target_date}")
    except ValueError:
        print(f"❌ Formato data non valido: {sys.argv[1]}. Usando domani come default.")
        target_date = (_today() + timedelta(days=1))
        print(f"📅 Fallback - usando domani: {target_date}")
else:
    target_date = (_today() + timedelta(days=1))
    print(f"📅 NESSUNA DATA SPECIFICATA - usando domani come default: {target_date}")
    print("⚠️ Per usare una data specifica, passa il parametro YYYY-MM-DD")

today = _today()
yesterday = today - timedelta(days=1)
week_start = _monday_of(today)
week_end_excl = week_start + timedelta(days=7)  # [week_start, week_end_excl)

# --- CONNESSIONE DB -----------------------------------------------------
conn = mysql.connector.connect(**db_config)
cur = conn.cursor(dictionary=True)

# 1) Lista cleaners (come da originale)
cur.execute("""        SELECT id, name, lastname, user_role_id, active, contract_type_id, telegram_id, tw_start
    FROM app_users 
    WHERE user_role_id IN (7, 15) AND active = 1;
""")
cleaners = cur.fetchall()

# 2) Ore settimanali (set-based, senza DATE(colonna))
cur.execute("""        SELECT user_id,
           ROUND(SUM(
               CASE
                 WHEN duration IS NULL OR duration = '' THEN 0
                 WHEN INSTR(duration, ':') > 0 THEN
                      CAST(SUBSTRING_INDEX(duration, ':', 1) AS DECIMAL(10,2))
                    + CAST(SUBSTRING_INDEX(duration, ':', -1) AS DECIMAL(10,2))/60
                 ELSE CAST(duration AS DECIMAL(10,2))
               END
           ), 2) AS weekly_hours
    FROM app_housekeeping_report
    WHERE updated_at >= %s AND updated_at < %s
    GROUP BY user_id
""", (week_start, week_end_excl))
weekly_rows = cur.fetchall()
weekly_hours = {r["user_id"]: float(r["weekly_hours"] or 0.0) for r in weekly_rows}

# 3) Tutte le date lavorate per ultimi 60 giorni (per streak fino a ieri) – UNA query
start_window = today - timedelta(days=60)
cur.execute("""        SELECT user_id, DATE(updated_at) AS d
    FROM app_housekeeping_report
    WHERE updated_at >= %s AND updated_at < %s
    GROUP BY user_id, DATE(updated_at)
    ORDER BY user_id, d DESC
""", (start_window, today))  # fino a oggi escluso

date_rows = cur.fetchall()
# costruiamo set di date per utente per calcolare streak fino a "ieri"
worked_dates = {}
for r in date_rows:
    worked_dates.setdefault(r["user_id"], set()).add(r["d"])

def streak_until_yesterday(uid):
    s = worked_dates.get(uid, set())
    if yesterday not in s:
        return 0
    # conta indietro finché le date sono consecutive (ieri, -2, -3, ...)
    cnt = 0
    day = yesterday
    while day in s:
        cnt += 1
        day = day - timedelta(days=1)
    return cnt

# 4) Assenze (ferie/malattia/permesso) nella data target – UNA query
cur.execute("""        SELECT user_id
    FROM app_attendance
    WHERE status = 1
      AND %s BETWEEN start_date AND stop_date
    GROUP BY user_id
""", (target_date,))
leave_set = {r["user_id"] for r in cur.fetchall()}

# 5) Preferenze cliente – UNA query
cur.execute("""        SELECT user_id, GROUP_CONCAT(customer_id ORDER BY customer_id) AS preferred_customers
    FROM app_customer_user
    GROUP BY user_id
""" )
prefs_map = {}
for r in cur.fetchall():
    pref = r.get("preferred_customers") or ""
    if pref:
        prefs_map[r["user_id"]] = [int(x) for x in pref.split(",") if x]
    else:
        prefs_map[r["user_id"]] = []

# --- COSTRUZIONE OUTPUT -------------------------------------------------
cleaners_data = []
contract_map = {1: "A", 2: "B", 3: "C", 4: "a chiamata"}

for u in cleaners:
    uid = u["id"]
    role = "Premium" if u.get("user_role_id") == 15 else "Standard"
    available = 0 if uid in leave_set else 1

    cleaner = {
        "id": uid,
        "name": u.get("name"),
        "lastname": u.get("lastname"),
        "role": role,
        "active": bool(u.get("active")),
        "ranking": 0,
        "counter_hours": float(weekly_hours.get(uid, 0.0)),
        "counter_days": int(streak_until_yesterday(uid)),
        "available": bool(available),
        "contract_type": contract_map.get(u.get("contract_type_id"), u.get("contract_type_id")),
        "preferred_customers": prefs_map.get(uid, []),
        "telegram_id": u.get("telegram_id"),
        "start_time": u.get("tw_start"),
    }
    cleaners_data.append(cleaner)

# Struttura JSON identica a quella scritta dallo script originale
target_date_str = target_date.strftime("%Y-%m-%d")
fresh_data = {
    "metadata": {
        "last_updated": datetime.now().isoformat(),
        "db_config": db_config,
        "schema_version": "1.0"
    },
    "dates": {
        target_date_str: {
            "timestamp": datetime.now().isoformat(),
            "cleaners": cleaners_data,
            "total_cleaners": len(cleaners_data),
            "date": target_date_str,
            "data_source": "database_query"
        }
    }
}

# Scrittura su data/cleaners/cleaners.json (stesso percorso dell'originale)
output_path = Path(__file__).resolve().parents[1] / "data" / "cleaners" / "cleaners.json"
output_path.parent.mkdir(parents=True, exist_ok=True)
with output_path.open("w", encoding="utf-8") as f:
    json.dump(fresh_data, f, indent=4)

print(f"✅ File cleaners.json COMPLETAMENTE RESETTATO e aggiornato")
print(f"📅 DATA NEL JSON: {target_date_str}")
print(f"👥 CLEANERS TROVATI: {len(cleaners_data)}")
print(f"🔄 RESET COMPLETATO - Il file contiene SOLO i dati per {target_date_str}")
print(f"Aggiornato data/cleaners/cleaners.json con {len(cleaners_data)} cleaners per la data {target_date_str}.")
