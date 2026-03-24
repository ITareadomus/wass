# -*- coding: utf-8 -*-
"""
Estrae autisti (route drivers) da ADAM: app_users.user_role_id = 9.
Ore settimana / giorni consecutivi da app_housekeeping_report (come i cleaners).
Salva roster su PostgreSQL via API POST /api/logistics-drivers (tabella lg_drivers).

Uso:
  python extract_logistics_drivers.py [YYYY-MM-DD]
"""
import mysql.connector
import sys
from datetime import datetime, timedelta

from db_config import db_config


def _today():
    return datetime.now().date()


def _monday_of(d):
    return d - timedelta(days=d.weekday())


if len(sys.argv) > 1:
    try:
        selected_date_str = sys.argv[1]
        target_date = datetime.strptime(selected_date_str, "%Y-%m-%d").date()
        print(f"📅 DATA SPECIFICATA: {selected_date_str}")
    except ValueError:
        print(f"❌ Formato data non valido: {sys.argv[1]}. Uso oggi.")
        target_date = _today()
else:
    target_date = _today()
    print(f"📅 NESSUNA DATA — uso oggi: {target_date}")

today = _today()
target_date_str = target_date.strftime("%Y-%m-%d")
day_before_target = target_date - timedelta(days=1)
week_start = _monday_of(target_date)
week_end_excl = week_start + timedelta(days=7)

conn = mysql.connector.connect(**db_config)
cur = conn.cursor(dictionary=True)

cur.execute(
    """
    SELECT id, name, lastname, user_role_id, active, contract_type_id, telegram_id, tw_start
    FROM app_users
    WHERE user_role_id = 9 AND active = 1
"""
)
users = cur.fetchall()

# I veicoli non sono più righe lg_drivers: lista da GET /api/logistics-vehicles (structure_id ADAM).

cur.execute(
    """SELECT user_id,
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
""",
    (week_start, week_end_excl),
)
weekly_hours = {r["user_id"]: float(r["weekly_hours"] or 0.0) for r in cur.fetchall()}

start_window = target_date - timedelta(days=60)
cur.execute(
    """SELECT user_id, DATE(updated_at) AS d
    FROM app_housekeeping_report
    WHERE updated_at >= %s AND updated_at < %s
    GROUP BY user_id, DATE(updated_at)
    ORDER BY user_id, d DESC
""",
    (start_window, target_date),
)
worked_dates = {}
for r in cur.fetchall():
    worked_dates.setdefault(r["user_id"], set()).add(r["d"])

try:
    cur.execute(
        """
        SELECT c.user_id, DATE(COALESCE(c.updated_at, r.updated_at)) AS d
        FROM app_housekeeping_report_collaboration c
        INNER JOIN app_housekeeping_report r ON r.id = c.housekeeping_report_id
        WHERE COALESCE(c.updated_at, r.updated_at) >= %s AND COALESCE(c.updated_at, r.updated_at) < %s
          AND (r.deleted IS NULL OR r.deleted = 0)
        GROUP BY c.user_id, DATE(COALESCE(c.updated_at, r.updated_at))
        """,
        (start_window, target_date),
    )
    for r in cur.fetchall():
        worked_dates.setdefault(r["user_id"], set()).add(r["d"])
except mysql.connector.Error as e:
    print(f"⚠️ app_housekeeping_report_collaboration (giorni lavorati): {e}")


def streak_ending_at(uid, last_day):
    s = worked_dates.get(uid, set())
    if last_day not in s:
        return 0
    cnt = 0
    day = last_day
    while day in s:
        cnt += 1
        day = day - timedelta(days=1)
    return cnt


cur.execute(
    """
    SELECT user_id
    FROM app_attendance
    WHERE status = 1
      AND %s BETWEEN start_date AND stop_date
    GROUP BY user_id
""",
    (target_date,),
)
leave_set = {r["user_id"] for r in cur.fetchall()}

cur.execute(
    """
    SELECT user_id, GROUP_CONCAT(customer_id ORDER BY customer_id) AS preferred_customers
    FROM app_customer_user
    GROUP BY user_id
"""
)
prefs_map = {}
for r in cur.fetchall():
    pref = r.get("preferred_customers") or ""
    if pref:
        prefs_map[r["user_id"]] = [int(x) for x in pref.split(",") if x]
    else:
        prefs_map[r["user_id"]] = []

cur.close()
conn.close()

contract_map = {1: "A", 2: "B", 3: "C", 4: "a chiamata"}

custom_start_times = {}
existing_pg = {}
try:
    import os
    from urllib.parse import urlparse

    import psycopg2
    from psycopg2.extras import RealDictCursor

    db_url = os.environ.get("DATABASE_URL")
    if db_url:
        parsed = urlparse(db_url)
        pg_config = {
            "host": parsed.hostname,
            "port": parsed.port or 5432,
            "user": parsed.username,
            "password": parsed.password,
            "database": parsed.path.lstrip("/"),
            "sslmode": "require",
        }
        pg_conn = psycopg2.connect(**pg_config)
        pg_cur = pg_conn.cursor(cursor_factory=RealDictCursor)
        pg_cur.execute(
            """
            SELECT driver_id, name, lastname, role, active, ranking,
                   counter_hours, counter_days, available, contract_type,
                   preferred_customers, telegram_id, start_time
            FROM lg_drivers
            WHERE work_date = %s
        """,
            (target_date_str,),
        )
        for row in pg_cur.fetchall():
            did = row["driver_id"]
            existing_pg[did] = {
                "id": did,
                "name": row["name"],
                "lastname": row["lastname"],
                "role": row["role"] or "Driver",
                "active": row["active"],
                "ranking": row["ranking"],
                "counter_hours": float(row["counter_hours"]) if row["counter_hours"] else 0.0,
                "counter_days": int(row["counter_days"]) if row["counter_days"] else 0,
                "available": row["available"],
                "contract_type": row["contract_type"],
                "preferred_customers": row["preferred_customers"] or [],
                "telegram_id": row["telegram_id"],
                "start_time": row["start_time"],
            }
            if row["start_time"]:
                custom_start_times[did] = row["start_time"]
        pg_cur.close()
        pg_conn.close()
        if existing_pg:
            print(f"✅ Trovati {len(existing_pg)} driver esistenti in PostgreSQL per {target_date_str}")
except Exception as e:
    print(f"⚠️ Lettura PostgreSQL opzionale fallita: {e}")

drivers_data = []
for u in users:
    cid = u["id"]
    available = 0 if cid in leave_set else 1
    if cid in custom_start_times:
        start_time = custom_start_times[cid]
    else:
        adam_tw = u.get("tw_start")
        start_time = adam_tw if adam_tw else None

    counter_hours = weekly_hours.get(cid, 0.0)
    if target_date > today:
        if cid in worked_dates and day_before_target in worked_dates[cid]:
            counter_days = int(streak_ending_at(cid, day_before_target))
        else:
            counter_days = 0
    else:
        last_reported = None
        if cid in worked_dates:
            candidates = [d for d in worked_dates[cid] if d <= day_before_target]
            if candidates:
                last_reported = max(candidates)
        counter_days = int(streak_ending_at(cid, last_reported)) if last_reported is not None else 0

    drivers_data.append(
        {
            "id": cid,
            "name": u.get("name"),
            "lastname": u.get("lastname"),
            "role": "Driver",
            "active": bool(u.get("active")),
            "ranking": 0,
            "counter_hours": counter_hours,
            "counter_days": counter_days,
            "available": bool(available),
            "contract_type": contract_map.get(u.get("contract_type_id"), u.get("contract_type_id")),
            "preferred_customers": prefs_map.get(cid, []),
            "telegram_id": u.get("telegram_id"),
            "start_time": start_time,
        }
    )

LEGACY_VEHICLE_ID_OFFSET = 900_000_000
adam_ids = {d["id"] for d in drivers_data}
preserved = 0
for did, row in existing_pg.items():
    # Non reimportare pseudo-veicoli o altre righe legacy non più usate.
    if did >= LEGACY_VEHICLE_ID_OFFSET:
        continue
    if str(row.get("role") or "").strip().lower() == "vehicle":
        continue
    if did not in adam_ids:
        cid = did
        counter_hours = weekly_hours.get(cid, float(row.get("counter_hours") or 0))
        if target_date > today:
            if cid in worked_dates and day_before_target in worked_dates[cid]:
                counter_days = int(streak_ending_at(cid, day_before_target))
            else:
                counter_days = 0
        else:
            last_reported = None
            if cid in worked_dates:
                candidates = [d for d in worked_dates[cid] if d <= day_before_target]
                if candidates:
                    last_reported = max(candidates)
            counter_days = int(streak_ending_at(cid, last_reported)) if last_reported is not None else 0
        row = {**row, "counter_hours": counter_hours, "counter_days": counter_days}
        drivers_data.append(row)
        preserved += 1
        print(f"✅ Preservato driver {did} ({row.get('name', '?')}) da PostgreSQL (non in ADAM)")

if preserved:
    print(f"✅ Totale driver preservati da PostgreSQL: {preserved}")

from api_client import ApiClient

api = ApiClient()
print(f"👥 Driver trovati: {len(drivers_data)}")
result = api.save_logistics_drivers(target_date_str, drivers_data)
print(f"🔄 Completato — salvati {len(drivers_data)} driver per {target_date_str}: {result}")
