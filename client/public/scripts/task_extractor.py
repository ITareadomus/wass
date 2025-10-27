
import json
import mysql.connector
import sys
import os
import psycopg2
from psycopg2.extras import execute_values
from datetime import datetime, date, timedelta

# ---------- Utilità di standardizzazione richieste ----------
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

# ---------- Config DB MySQL (source) ----------
DB_CONFIG = {
    "host": "139.59.132.41",
    "user": "admin",
    "password": "ed329a875c6c4ebdf4e87e2bbe53a15771b5844ef6606dde",
    "database": "adamdb",
}

# ---------- Config DB PostgreSQL (destination) ----------
def get_pg_connection():
    database_url = os.environ.get('DATABASE_URL')
    if not database_url:
        raise Exception("DATABASE_URL environment variable not set")
    return psycopg2.connect(database_url)

# ---------- Funzioni per lista operazioni attive ----------
def get_active_operations():
    """Carica le operazioni attive dal database MySQL e le salva in PostgreSQL"""
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
    operation_ids = [row['id'] for row in results]
    
    # Salva anche in PostgreSQL
    pg_conn = get_pg_connection()
    pg_cur = pg_conn.cursor()
    
    # Pulisci vecchie operazioni
    pg_cur.execute("DELETE FROM operations")
    
    # Inserisci nuove operazioni
    for op_id in operation_ids:
        pg_cur.execute("""
            INSERT INTO operations (id, active, enable_wass)
            VALUES (%s, true, true)
            ON CONFLICT (id) DO UPDATE SET active = true, enable_wass = true
        """, (op_id,))
    
    pg_conn.commit()
    pg_cur.close()
    pg_conn.close()
    
    return operation_ids

def load_valid_operation_ids():
    """Carica gli operation_id validi dal database PostgreSQL"""
    try:
        pg_conn = get_pg_connection()
        pg_cur = pg_conn.cursor()
        pg_cur.execute("SELECT id FROM operations WHERE active = true AND enable_wass = true")
        operation_ids = [row[0] for row in pg_cur.fetchall()]
        pg_cur.close()
        pg_conn.close()
        
        if not operation_ids:
            print("Nessuna operazione trovata in PostgreSQL, aggiorno dal DB MySQL...")
            operation_ids = get_active_operations()
        
        return operation_ids
    except Exception as e:
        print(f"Errore nel caricamento delle operazioni da PostgreSQL: {e}")
        print("Fallback: caricamento da MySQL...")
        return get_active_operations()

# ---------- Mapping structure_type_id -> type (A..F/X) ----------
def map_structure_type_to_letter(structure_type_id):
    mapping = {1: "A", 2: "B", 3: "C", 4: "D", 5: "E", 6: "F"}
    return mapping.get(structure_type_id, "X")

# ---------- Core ----------
def get_apartments_for_date(selected_date):
    """Estrae gli appartamenti per la data indicata dal DB MySQL"""
    valid_operation_ids = load_valid_operation_ids()
    valid_operation_ids.extend([0, None])
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
        results.append(item)

    return results

def save_tasks_to_db(tasks, work_date):
    """Salva i task nel database PostgreSQL"""
    pg_conn = get_pg_connection()
    pg_cur = pg_conn.cursor()
    
    # Elimina i task esistenti per questa data
    pg_cur.execute("DELETE FROM tasks WHERE work_date = %s", (work_date,))
    
    # Prepara i dati per l'inserimento batch
    task_values = []
    for t in tasks:
        task_values.append((
            t["task_id"],
            str(t["logistic_code"]),
            t.get("client_id"),
            t["premium"],
            t.get("address"),
            t.get("lat"),
            t.get("lng"),
            t.get("cleaning_time"),
            t.get("checkin_date"),
            t.get("checkout_date"),
            t.get("checkin_time"),
            t.get("checkout_time"),
            t.get("pax_in"),
            t.get("pax_out"),
            t["small_equipment"],
            t["operation_id"],
            t["confirmed_operation"],
            t["straordinaria"],
            t.get("type_apt"),
            t.get("alias"),
            t.get("customer_name"),
            None,  # priority (sarà assegnata dopo)
            "pending",  # status
            work_date,
            []  # reasons
        ))
    
    # Inserimento batch
    execute_values(pg_cur, """
        INSERT INTO tasks (
            task_id, logistic_code, client_id, premium, address, lat, lng,
            cleaning_time, checkin_date, checkout_date, checkin_time, checkout_time,
            pax_in, pax_out, small_equipment, operation_id, confirmed_operation,
            straordinaria, type_apt, alias, customer_name, priority, status,
            work_date, reasons
        ) VALUES %s
    """, task_values)
    
    pg_conn.commit()
    pg_cur.close()
    pg_conn.close()
    
    print(f"✅ Salvati {len(tasks)} task nel database PostgreSQL per la data {work_date}")

def main():
    if len(sys.argv) > 1:
        selected_date = sys.argv[1]
        print(f"Usando data specifica: {selected_date}")
    else:
        selected_date = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
        print(f"Usando data di default (domani): {selected_date}")

    # Aggiorna le operazioni attive
    get_active_operations()

    # Estrai i task
    apt_data = get_apartments_for_date(selected_date)

    # Salva nel database PostgreSQL
    save_tasks_to_db(apt_data, selected_date)

    # Mantieni anche il salvataggio JSON per retrocompatibilità temporanea
    output = {
        "metadata": {
            "last_updated": datetime.now().isoformat(),
            "schema_version": "1.0"
        },
        "dates": {
            selected_date: {
                "timestamp": datetime.now().isoformat(),
                "apt": apt_data,
                "total_apartments": len(apt_data),
                "date": selected_date
            }
        }
    }

    import os
    os.makedirs("client/public/data/input", exist_ok=True)
    with open("client/public/data/input/daily_tasks.json", "w", encoding="utf-8") as f:
        json.dump(output, f, indent=4, ensure_ascii=False)

    print(f"Aggiornato database e daily_tasks.json con {len(apt_data)} appartamenti per la data {selected_date}.")

if __name__ == "__main__":
    main()
