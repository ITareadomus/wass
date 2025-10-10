import json
import mysql.connector
import sys
from datetime import datetime, timedelta
from pathlib import Path

# Configurazione del database (puoi metterla qui direttamente o caricarla da un altro file se vuoi)
db_config = {
    "host": "139.59.132.41",
    "user": "admin",
    "password": "ed329a875c6c4ebdf4e87e2bbe53a15771b5844ef6606dde",
    "database": "adamdb"
}

# Crea il modello base da zero
config = {"db_config": db_config, "cleaners": []}

#ho aggiunto delle colonne nella tabella app_users in cui ho aggiunto un campo per il minimo ore e un altro per il tipo di contratto
#le ore vengono calcolate settimanalmente (da lunedì a domenica) e si resettano ogni lunedì

db_config = config["db_config"]

# Connessione al database
connection = mysql.connector.connect(**db_config)
cursor = connection.cursor(dictionary=True, buffered=True)

# Esegui la query per prendere i parametri dei cleaners
cursor.execute("""
    SELECT id, name, lastname, user_role_id, active, contract_type_id, telegram_id, tw_start
    FROM app_users 
    WHERE user_role_id IN (7, 15) AND active = 1;
""")
results = cursor.fetchall()

# Usa la data passata come parametro, altrimenti calcola domani 
if len(sys.argv) > 1:
    try:
        selected_date_str = sys.argv[1]
        target_date = datetime.strptime(selected_date_str, "%Y-%m-%d").date()
        print(f"📅 DATA SPECIFICATA DALL'INTERFACCIA: {selected_date_str}")
        print(f"✅ Generando dati cleaner per la data: {target_date}")
    except ValueError:
        print(f"❌ Formato data non valido: {sys.argv[1]}. Usando domani come default.")
        target_date = (datetime.now() + timedelta(days=1)).date()
        print(f"📅 Fallback - usando domani: {target_date}")
else:
    target_date = (datetime.now() + timedelta(days=1)).date()
    print(f"📅 NESSUNA DATA SPECIFICATA - usando domani come default: {target_date}")
    print("⚠️ Per usare una data specifica, passa il parametro YYYY-MM-DD")

# Predefiniamo i parametri statici
static_params = {
    "id": None,  # Aggiunto il campo id
    "name": None,
    "lastname": None,
    "role": None,
    "active": False,
    "ranking": 0,
    "counter_hours": 0.0,
    "counter_days": 0,
    "available": False,
    "contract_type": None,
    "telegram_id": None
}


def get_weekly_hours(cursor, user_id):
    """Somma le duration (VARCHAR) della settimana corrente (da lunedì a domenica)."""
    now = datetime.now()
    # Calcola il lunedì della settimana corrente
    monday = now.date() - timedelta(days=now.weekday())
    # Calcola la domenica della settimana corrente
    sunday = monday + timedelta(days=6)

    cursor.execute(
        """
        SELECT duration
        FROM app_housekeeping_report
        WHERE user_id = %s
          AND DATE(updated_at) BETWEEN %s AND %s
    """, (user_id, monday, sunday))
    durations = cursor.fetchall()
    # Assicuriamoci che tutti i risultati siano stati consumati
    cursor.reset()
    print(
        f"user_id={user_id} settimana {monday} - {sunday} durations={[row['duration'] for row in durations]}"
    )
    total = 0.0
    for row in durations:
        val = row["duration"]
        if not val:
            continue
        val = val.strip()
        if ":" in val:  # formato ore:minuti
            try:
                h, m = val.split(":")
                total += int(h) + int(m) / 60
            except Exception:
                continue
        else:
            try:
                total += float(val)
            except Exception:
                continue
    return round(total, 2)


def get_consecutive_days(cursor, user_id):
    """Conta i giorni lavorati consecutivamente fino a ieri (rispetto a oggi effettivo)."""
    # La data di riferimento è sempre OGGI, indipendentemente dalla data target delle convocazioni
    today = datetime.now().date()
    yesterday = today - timedelta(days=1)

    # Prima verifica: ha lavorato ieri?
    cursor.execute(
        """
        SELECT 1
        FROM app_housekeeping_report
        WHERE user_id = %s AND DATE(updated_at) = %s
        LIMIT 1
    """, (user_id, yesterday))

    worked_yesterday = cursor.fetchone() is not None
    # Assicuriamoci che tutti i risultati siano stati consumati
    cursor.reset()

    if not worked_yesterday:
        # Se non ha lavorato ieri, counter_days = 0
        return 0

    # Se ha lavorato ieri, prendi tutte le date DISTINTE in cui ha lavorato, in ordine decrescente
    cursor.execute(
        """
        SELECT DISTINCT DATE(updated_at) as work_date
        FROM app_housekeeping_report
        WHERE user_id = %s AND DATE(updated_at) <= %s
        ORDER BY work_date DESC
    """, (user_id, yesterday))
    dates = [row["work_date"] for row in cursor.fetchall()]
    # Assicuriamoci che tutti i risultati siano stati consumati
    cursor.reset()

    if not dates:
        return 0  # Non dovrebbe succedere, ma per sicurezza

    # Inizia il conteggio da ieri (primo giorno = 1)
    counter = 1
    prev_day = yesterday

    # Conta i giorni consecutivi a ritroso da ieri
    for d in dates[1:] if len(dates) > 1 else []:
        if d == prev_day - timedelta(days=1):
            counter += 1
            prev_day = d
        else:
            # Trovata una giornata mancante, interrompi il conteggio
            break

    return counter


# Query per recuperare le preferenze customer per tutti i cleaner
print("🔄 Recupero preferenze customer dalla tabella app_customer_user...")

# Prima verifichiamo se la tabella esiste e la sua struttura
cursor.execute("""
    SELECT COUNT(*) as table_exists 
    FROM information_schema.tables 
    WHERE table_schema = 'adamdb' AND table_name = 'app_customer_user'
""")
table_check = cursor.fetchone()

if table_check and table_check['table_exists'] > 0:
    print("✅ Tabella app_customer_user trovata")

    # Verifichiamo la struttura della tabella
    cursor.execute("""
        SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE 
        FROM information_schema.COLUMNS 
        WHERE TABLE_SCHEMA = 'adamdb' AND TABLE_NAME = 'app_customer_user'
        ORDER BY ORDINAL_POSITION
    """)
    columns = cursor.fetchall()
    print(f"📋 Struttura tabella ({len(columns)} colonne):")
    for col in columns:
        print(f"  - {col['COLUMN_NAME']} ({col['DATA_TYPE']}, NULL: {col['IS_NULLABLE']})")

    # Controlliamo quanti record ci sono in totale
    cursor.execute("SELECT COUNT(*) as total_records FROM app_customer_user")
    total_records = cursor.fetchone()
    print(f"📊 Totale record in app_customer_user: {total_records['total_records']}")

    # Controlliamo quanti record ci sono 
    cursor.execute("SELECT COUNT(*) as active_records FROM app_customer_user")
    active_records = cursor.fetchone()
    print(f"📊 Record totali: {active_records['active_records']}")

    # Mostriamo i primi 5 record per debug
    cursor.execute("""
        SELECT id, user_id, customer_id, created_at, updated_at 
        FROM app_customer_user 
        ORDER BY created_at DESC
        LIMIT 5
    """)
    sample_records = cursor.fetchall()
    print(f"🔍 Primi 5 record (più recenti):")
    for record in sample_records:
        print(f"  - ID: {record['id']}, user_id: {record['user_id']}, customer_id: {record['customer_id']}, created: {record['created_at']}")

    # Ora recuperiamo tutti i dati
    cursor.execute("""
        SELECT id, user_id, customer_id, created_at, updated_at, created_by, updated_by 
        FROM app_customer_user 
        ORDER BY user_id, customer_id
    """)
    customer_preferences_results = cursor.fetchall()

    print(f"📋 Trovati {len(customer_preferences_results)} record di preferenze attive")

    # Debug COMPLETO - mostra TUTTI i record per vedere i contenuti
    if customer_preferences_results:
        print("🔍 TUTTI i record trovati nella tabella app_customer_user:")
        print("=" * 80)
        for i, record in enumerate(customer_preferences_results):
            print(f"Record {i+1}:")
            print(f"  - ID: {record['id']}")
            print(f"  - user_id: {record['user_id']} (tipo: {type(record['user_id'])})")
            print(f"  - customer_id: {record['customer_id']} (tipo: {type(record['customer_id'])})")
            print(f"  - created_at: {record['created_at']}")
            print(f"  - updated_at: {record['updated_at']}")
            print(f"  - created_by: {record['created_by']}")
            print(f"  - updated_by: {record['updated_by']}")
            print("-" * 40)

        # Verifica corrispondenza con cleaner
        user_ids_in_preferences = set(row['user_id'] for row in customer_preferences_results)
        cleaner_ids = [cleaner["id"] for cleaner in results]

        print(f"\n📊 ANALISI CORRISPONDENZE:")
        print(f"🎯 User ID nelle preferenze: {sorted(user_ids_in_preferences)}")
        print(f"👥 Cleaner ID disponibili: {sorted(cleaner_ids)}")

        matching_ids = user_ids_in_preferences.intersection(set(cleaner_ids))
        if matching_ids:
            print(f"✅ {len(matching_ids)} cleaner hanno preferenze: {sorted(matching_ids)}")
        else:
            print(f"⚠️ NESSUNA CORRISPONDENZA trovata!")
            print(f"   Questo significa che i user_id nella tabella preferenze non corrispondono agli ID dei cleaner")
    else:
        print("⚠️ Nessuna preferenza customer trovata nella tabella")

else:
    print("❌ Tabella app_customer_user NON trovata nel database!")
    customer_preferences_results = []

# Recupera clienti e salva nel file customers.json
print("📋 Recupero informazioni clienti...")

# Query per ottenere tutti i clienti attivi
cursor.execute("""
    SELECT id, name 
    FROM app_customers 
    WHERE deleted_at IS NULL
    ORDER BY id
""")

customers_data = cursor.fetchall()
customers_dict = {}

# Clienti prioritari (IDs specifici)
priority_customer_ids = [2, 3, 9]

for customer in customers_data:
    customer_id = str(customer['id'])
    # Usa sempre il nome reale dal database
    customer_name = customer['name'] if customer['name'] else f"Cliente {customer_id}"

    # Determina se è prioritario basandosi solo sull'ID
    if customer['id'] in priority_customer_ids:
        customer_type = "priority"
    else:
        customer_type = "standard"

    customers_dict[customer_id] = {
        "name": customer_name,
        "type": customer_type
    }

print(f"✅ Trovati {len(customers_dict)} clienti totali con nomi reali dal database")

cleaners_data = []
for cleaner in results:
    cleaner_id = cleaner["id"]

    # Prima, mostra TUTTI i periodi di ferie/malattia per questo cleaner per debug
    cursor.execute(
        """
        SELECT start_date, stop_date, status, id
        FROM app_attendance
        WHERE user_id = %s AND status = 1
        ORDER BY start_date;
    """, (cleaner_id,))
    all_periods = cursor.fetchall()

    if all_periods:
        print(f"🔍 DEBUG - Cleaner {cleaner_id} ({cleaner.get('name', '')} {cleaner.get('lastname', '')}) - TUTTI i periodi di ferie/malattia attivi:")
        for period in all_periods:
            print(f"    📅 ID:{period['id']} - Dal {period['start_date']} al {period['stop_date']} (status: {period['status']})")
        print(f"    🎯 Data target da controllare: {target_date}")

    # Ora controlla se il cleaner è in ferie/permesso/malattia per la data target specifica
    # La query BETWEEN verifica che target_date sia compresa tra start_date e stop_date (inclusi)
    cursor.execute(
        """
        SELECT start_date, stop_date, status, id
        FROM app_attendance
        WHERE user_id = %s AND %s BETWEEN start_date AND stop_date AND status = 1;
    """, (cleaner_id, target_date))
    attendance_result = cursor.fetchone()

    # Se è presente in app_attendance per la data target con status=1, è in ferie/malattia/permesso
    on_leave = attendance_result is not None

    if on_leave:
        # Verifica esplicita che la data target sia effettivamente nel periodo
        period_start = attendance_result['start_date']
        period_end = attendance_result['stop_date']
        is_in_period = period_start <= target_date <= period_end

        print(f"🚫 Cleaner {cleaner_id} ({cleaner.get('name', '')} {cleaner.get('lastname', '')}) NON DISPONIBILE:")
        print(f"   📅 Periodo trovato: {period_start} - {period_end} (ID: {attendance_result['id']})")
        print(f"   🎯 Data target: {target_date}")
        print(f"   ✅ Status: {attendance_result['status']}")
        print(f"   🔍 Verifica periodo: {target_date} è tra {period_start} e {period_end}? {'SÌ' if is_in_period else 'NO'}")

        # Controllo di sicurezza aggiuntivo
        if not is_in_period:
            print(f"   ⚠️ ATTENZIONE: Query BETWEEN ha restituito risultato ma verifica manuale fallisce!")
    else:
        print(f"✅ Cleaner {cleaner_id} ({cleaner.get('name', '')} {cleaner.get('lastname', '')}) DISPONIBILE per {target_date}")
        if all_periods:
            print(f"   ℹ️ Ha {len(all_periods)} periodi di ferie/malattia ma nessuno include la data {target_date}")

    # Mappa contract_type_id numerico a lettera
    contract_type_db = cleaner.get("contract_type_id", static_params["contract_type"])
    contract_map = {1: "A", 2: "B", 3: "C", 4: "a chiamata"}
    contract_type = contract_map.get(contract_type_db, contract_type_db)

    counter_hours = get_weekly_hours(cursor, cleaner_id)
    counter_days = get_consecutive_days(cursor, cleaner_id)

    # Recupera le preferenze customer per questo specifico cleaner
    print(f"🔍 Recupero preferenze customer per cleaner ID: {cleaner_id}")
    cursor.execute("""
        SELECT customer_id
        FROM app_customer_user
        WHERE user_id = %s
    """, (cleaner_id,))
    preferred_customers_rows = cursor.fetchall()
    preferred_customers = [row["customer_id"] for row in preferred_customers_rows]

    if preferred_customers:
        print(f"  ✅ Cleaner {cleaner_id} ({cleaner.get('name', '')} {cleaner.get('lastname', '')}): {len(preferred_customers)} customer preferiti: {preferred_customers}")
    else:
        print(f"  ℹ️ Cleaner {cleaner_id} ({cleaner.get('name', '')} {cleaner.get('lastname', '')}): nessuna preferenza customer")

    cleaner_data = {
        "id": cleaner_id,
        "name": cleaner.get("name", static_params["name"]),
        "lastname": cleaner.get("lastname", static_params["lastname"]),
        "role": "Premium" if cleaner.get("user_role_id") == 15 else "Standard"
                if cleaner.get("user_role_id") == 7 else "Standard", # Modificato qui per default a "Standard"
        "active": cleaner.get("active") == 1,
        "ranking": static_params["ranking"],
        "counter_hours": counter_hours,
        "counter_days": counter_days,
        "available": not on_leave,
        "contract_type": contract_type,
        "preferred_customers": preferred_customers,
        "telegram_id": cleaner.get("telegram_id", static_params["telegram_id"]),
        "start_time": cleaner.get("tw_start")
    }
    cleaners_data.append(cleaner_data)


cursor.close()
connection.close()

# Aggiorna il JSON con i cleaners
config["cleaners"] = cleaners_data

# Calcola la data target per la struttura
target_date_str = target_date.strftime("%Y-%m-%d")

# Reset completo del JSON - crea una struttura completamente nuova con solo la data corrente
print(f"🔄 Reset completo del file modello_cleaners.json per la data {target_date_str}...")
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

# Sovrascrive completamente il file cleaners.json con solo i dati della data corrente
output_path = Path(__file__).resolve().parents[1] / "data" / "cleaners" / "cleaners.json"
output_path.parent.mkdir(parents=True, exist_ok=True)
with output_path.open("w", encoding="utf-8") as f:
    json.dump(fresh_data, f, indent=4)

print(f"✅ File cleaners.json COMPLETAMENTE RESETTATO e aggiornato")
print(f"📅 DATA NEL JSON: {target_date_str}")
print(f"👥 CLEANERS TROVATI: {len(results)}")
print(f"🔄 RESET COMPLETATO - Il file contiene SOLO i dati per {target_date_str}")

print(f"Aggiornato data/cleaners/cleaners.json con {len(results)} cleaners per la data {target_date_str}.")