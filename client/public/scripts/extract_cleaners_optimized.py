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
# - target_date = oggi se non specificato da argv
# - counter_days si basa su "ieri" rispetto ad OGGI reale
if len(sys.argv) > 1:
    try:
        selected_date_str = sys.argv[1]
        target_date = datetime.strptime(selected_date_str, "%Y-%m-%d").date()
        print(f"📅 DATA SPECIFICATA DALL'INTERFACCIA: {selected_date_str}")
        print(f"✅ Generando dati cleaner per la data: {target_date}")
    except ValueError:
        print(f"❌ Formato data non valido: {sys.argv[1]}. Usando oggi come default.")
        target_date = _today()
        print(f"📅 Fallback - usando oggi: {target_date}")
else:
    target_date = _today()
    print(f"📅 NESSUNA DATA SPECIFICATA - usando oggi come default: {target_date}")
    print("⚠️ Per usare una data specifica, passa il parametro YYYY-MM-DD")

today = _today()
yesterday = today - timedelta(days=1)

# IMPORTANTE: Calcola la settimana basandosi sulla target_date, NON su oggi
# Questo permette di vedere le ore corrette anche per date future
week_start = _monday_of(target_date)
week_end_excl = week_start + timedelta(days=7)  # [week_start, week_end_excl)

# --- CONNESSIONE DB -----------------------------------------------------
conn = mysql.connector.connect(**db_config)
cur = conn.cursor(dictionary=True)

# 1) Lista cleaners (7=Standard, 13=Formatore, 15=Premium)
cur.execute("""        SELECT id, name, lastname, user_role_id, active, contract_type_id, telegram_id, tw_start
    FROM app_users 
    WHERE user_role_id IN (7, 13, 15) AND active = 1;
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

# --- CARICA START TIME DA PostgreSQL (date-scoped) ----------------
# IMPORTANTE: Ogni cleaner ha uno start_time specifico per ogni data
# Non usare selected_cleaners.json perché è globale e non rispetta le date
custom_start_times = {}
target_date_str = target_date.strftime("%Y-%m-%d")
try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
    import os
    db_url = os.environ.get("DATABASE_URL")
    if db_url:
        from urllib.parse import urlparse
        parsed = urlparse(db_url)
        pg_config = {
            "host": parsed.hostname,
            "port": parsed.port or 5432,
            "user": parsed.username,
            "password": parsed.password,
            "database": parsed.path.lstrip("/")
        }
        try:
            pg_conn = psycopg2.connect(**pg_config)
            pg_cur = pg_conn.cursor(cursor_factory=RealDictCursor)
            # Leggi start_time da PostgreSQL per questa data specifica (date-scoped!)
            pg_cur.execute("""
                SELECT cleaner_id, start_time FROM cleaners
                WHERE work_date = %s AND start_time IS NOT NULL
            """, (target_date_str,))
            for row in pg_cur.fetchall():
                custom_start_times[row["cleaner_id"]] = row["start_time"]
            if custom_start_times:
                print(f"✅ Trovati {len(custom_start_times)} start_time custom da PostgreSQL per {target_date_str}")
            pg_cur.close()
            pg_conn.close()
        except Exception as pg_error:
            print(f"⚠️ Impossibile leggere da PostgreSQL: {pg_error}, continuo con tw_start come default")
    else:
        print(f"⚠️ DATABASE_URL non disponibile, uso tw_start come default")
except ImportError:
    print(f"⚠️ psycopg2 non disponibile, uso tw_start come default")

# --- COSTRUZIONE OUTPUT -------------------------------------------------
cleaners_data = []
contract_map = {1: "A", 2: "B", 3: "C", 4: "a chiamata"}

for u in cleaners:
    cid = u["id"] # cleaner ID
    role_id = u.get("user_role_id")
    if role_id == 15:
        role = "Premium"
    elif role_id == 13:
        role = "Formatore"
    else:
        role = "Standard"
    available = 0 if cid in leave_set else 1

    # Lista ID cleaner autorizzati per task straordinarie
    # Lopez (132), El Hadji (495), Henry (644), Chidi (249)
    straordinaria_authorized = {132, 495, 644, 249}

    # Usa start time custom se disponibile in PostgreSQL, altrimenti None (il backend userà il default 10:00)
    start_time = custom_start_times.get(cid)

    # counter_hours (somma delle ore lavorate nella settimana target, NON ieri)
    # Ogni task nella settimana conta per task_duration in MINUTI diviso 60
    counter_hours = 0.0
    try:
        cur.execute("""
            SELECT SUM(task_duration) / 60.0
            FROM cleaners_day_tasks
            WHERE cleaner_id = %s
              AND work_date >= %s AND work_date < %s
        """, (cid, week_start, week_end_excl))
        row = cur.fetchone()
        counter_hours_value = row[0] if (row and row[0] is not None) else 0.0
        # Ensure it's a float number, not a time string
        counter_hours = float(counter_hours_value) if counter_hours_value is not None else 0.0
    except mysql.connector.Error as e:
        # Se la tabella cleaners_day_tasks non esiste, usa il counter_hours da weekly_hours
        if "doesn't exist" in str(e) or "1146" in str(e):
            counter_hours = weekly_hours.get(cid, 0.0)
            print(f"⚠️ Tabella cleaners_day_tasks non trovata per cleaner {cid}, uso weekly_hours: {counter_hours}")
        else:
            raise


    cleaner = {
        "id": cid,
        "name": u.get("name"),
        "lastname": u.get("lastname"),
        "role": role,
        "active": bool(u.get("active")),
        "ranking": 0,
        "counter_hours": counter_hours,
        "counter_days": int(streak_until_yesterday(cid)),
        "available": bool(available),
        "contract_type": contract_map.get(u.get("contract_type_id"), u.get("contract_type_id")),
        "preferred_customers": prefs_map.get(cid, []),
        "telegram_id": u.get("telegram_id"),
        "start_time": start_time,
        "can_do_straordinaria": cid in straordinaria_authorized,
    }
    cleaners_data.append(cleaner)

# Struttura JSON identica a quella scritta dallo script originale
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

# SALVATAGGIO SU POSTGRESQL VIA API
# Importa api_client e salva i cleaners nel database PostgreSQL
try:
    from api_client import ApiClient
    api = ApiClient()
    result = api.save_cleaners(target_date_str, cleaners_data)
    print(f"✅ Cleaners salvati su PostgreSQL via API: {result.get('message', 'OK')}")
except Exception as api_err:
    print(f"⚠️ Salvataggio API fallito (non bloccante): {api_err}")
    print("   I dati sono stati salvati solo su cleaners.json")