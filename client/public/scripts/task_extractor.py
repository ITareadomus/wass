import json
import mysql.connector
import sys
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

# ---------- Config DB condivisa ----------
DB_CONFIG = {
    "host": "139.59.132.41",
    "user": "admin",
    "password": "ed329a875c6c4ebdf4e87e2bbe53a15771b5844ef6606dde",
    "database": "adamdb",
}

# ---------- Funzioni per lista operazioni attive (integrazione richiesta) ----------
def get_active_operations():
    """
    Carica le operazioni attive dal database (active=1 e enable_wass=1)
    """
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
    return operation_ids

def save_operations_to_file(operation_ids, output_file="client/public/data/input/operations.json"):
    """
    Salva gli operation_id validi in un file JSON
    """
    operations_data = {
        "timestamp": datetime.now().isoformat(),
        "active_operation_ids": operation_ids,
        "total_operations": len(operation_ids)
    }
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(operations_data, f, indent=4, ensure_ascii=False)
    print(f"Salvati {len(operation_ids)} operation_id validi in {output_file}")
    return operations_data

def refresh_operations_list():
    """
    Aggiorna data/operations.json interrogando direttamente il DB.
    """
    print("Aggiorno la lista delle operazioni attive dal DB...")
    ops = get_active_operations()
    save_operations_to_file(ops)
    print("Lista operazioni aggiornata con successo.")

def load_valid_operation_ids():
    """
    Carica gli operation_id validi dal file data/input/operations.json.
    Se il file manca/non è valido, lo rigenera interrogando il DB.
    """
    try:
        with open("client/public/data/input/operations.json", "r", encoding="utf-8") as f:
            operations_data = json.load(f)
        return operations_data.get("active_operation_ids", [])
    except (FileNotFoundError, json.JSONDecodeError):
        print("operations.json assente/non valido. Lo rigenero dal DB...")
        refresh_operations_list()
        try:
            with open("client/public/data/input/operations.json", "r", encoding="utf-8") as f:
                operations_data = json.load(f)
            return operations_data.get("active_operation_ids", [])
        except Exception as e2:
            print(f"Errore nel caricamento delle operazioni dopo il refresh: {e2}")
            return []

# ---------- Mapping structure_type_id -> type (A..F/X) ----------
def map_structure_type_to_letter(structure_type_id):
    mapping = {1: "A", 2: "B", 3: "C", 4: "D", 5: "E", 6: "F"}
    return mapping.get(structure_type_id, "X")

# ---------- Core ----------
def get_apartments_for_date(selected_date):
    """
    Estrae gli appartamenti per la data indicata,
    restituendo SOLO i campi richiesti con le trasformazioni specificate.
    """
    # filtri operation_id come nel tuo flusso attuale
    valid_operation_ids = load_valid_operation_ids()
    valid_operation_ids.extend([0, None])  # includi anche 0 e NULL
    non_null_operation_ids = [op for op in valid_operation_ids if op is not None]
    operation_placeholders = ','.join(['%s'] * len(non_null_operation_ids)) if non_null_operation_ids else 'NULL'

    connection = mysql.connector.connect(**DB_CONFIG)
    cursor = connection.cursor(dictionary=True)

    # JOIN con app_customers per prendere alias
    # Subquery per cleaning_time mantenuta
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

    # Prepara output con i soli campi richiesti + trasformazioni
    results = []
    for r in rows:
        structure_type_id = r.get("structure_type_id")
        op_id = r.get("operation_id")

        # Se operation_id originale è 0, confirmed_operation = False 
        # e operation_id = 2 (di default è una partenza) (graficamente sarà segnalato con un punto di domanda)
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
            "type": map_structure_type_to_letter(structure_type_id),
            "alias": varchar_to_str(r.get("alias")) if r.get("alias") is not None else None,
            "customer_name": varchar_to_str(r.get("customer_name")) if r.get("customer_name") is not None else None,
        }
        results.append(item)

    return results

def main():
    # Data da CLI o default domani
    if len(sys.argv) > 1:
        selected_date = sys.argv[1]
        print(f"Usando data specifica: {selected_date}")
    else:
        selected_date = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
        print(f"Usando data di default (domani): {selected_date}")

    # Assicurati che operations.json sia aggiornato prima di estrarre i task
    refresh_operations_list()

    apt_data = get_apartments_for_date(selected_date)

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

    with open("client/public/data/input/daily_tasks.json", "w", encoding="utf-8") as f:
        json.dump(output, f, indent=4, ensure_ascii=False)

    print(f"Aggiornato daily_tasks.json con {len(apt_data)} appartamenti per la data {selected_date}.")

if __name__ == "__main__":
    main()