
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Script per trasferire le assegnazioni della timeline sul database ADAM (wass_housekeeping)
"""

import json
import mysql.connector
import sys
from datetime import datetime
from pathlib import Path

# =============================
# CONFIG DB
# =============================
DB_CONFIG = {
    "host": "139.59.132.41",
    "user": "admin",
    "password": "ed329a875c6c4ebdf4e87e2bbe53a15771b5844ef6606dde",
    "database": "adamdb",
}

# =============================
# PATHS
# =============================
BASE = Path(__file__).parent.parent / "data"
TIMELINE_PATH = BASE / "output" / "timeline.json"


def transfer_to_adam(work_date: str, username: str = "system"):
    """
    Trasferisce le assegnazioni dalla timeline al database ADAM
    
    Args:
        work_date: Data in formato YYYY-MM-DD
        username: Username dell'utente che effettua il trasferimento
    """
    
    # Carica timeline.json
    if not TIMELINE_PATH.exists():
        print(f"❌ File timeline non trovato: {TIMELINE_PATH}")
        return {
            "success": False,
            "message": "File timeline non trovato"
        }
    
    try:
        timeline_data = json.loads(TIMELINE_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"❌ Errore lettura timeline: {e}")
        return {
            "success": False,
            "message": f"Errore lettura timeline: {e}"
        }
    
    cleaners_assignments = timeline_data.get("cleaners_assignments", [])
    
    if not cleaners_assignments:
        print("⚠️ Nessuna assegnazione trovata nella timeline")
        return {
            "success": False,
            "message": "Nessuna assegnazione trovata"
        }
    
    # Connessione al database
    try:
        connection = mysql.connector.connect(**DB_CONFIG)
        cursor = connection.cursor()
    except Exception as e:
        print(f"❌ Errore connessione database: {e}")
        return {
            "success": False,
            "message": f"Errore connessione database: {e}"
        }
    
    total_updated = 0
    total_errors = 0
    errors = []
    
    print(f"🔄 Trasferimento assegnazioni per {work_date}...")
    
    try:
        for cleaner_entry in cleaners_assignments:
            cleaner_id = cleaner_entry.get("cleaner", {}).get("id")
            
            for task in cleaner_entry.get("tasks", []):
                try:
                    task_id = task.get("task_id")
                    
                    if not task_id:
                        continue
                    
                    # Prepara i dati da salvare
                    update_data = {
                        "checkout": task.get("checkout_date"),
                        "checkout_time": task.get("checkout_time"),
                        "checkin": task.get("checkin_date"),
                        "checkin_time": task.get("checkin_time"),
                        "checkin_pax": task.get("pax_in"),
                        "operation_id": task.get("operation_id"),
                        "cleaned_by_us": cleaner_id,
                        "sequence": task.get("sequence"),
                        "updated_by": username,
                        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    }
                    
                    # Query di update sulla tabella wass_housekeeping
                    query = """
                        UPDATE wass_housekeeping 
                        SET 
                          checkout = %s,
                          checkout_time = %s,
                          checkin = %s,
                          checkin_time = %s,
                          checkin_pax = %s,
                          operation_id = %s,
                          cleaned_by_us = %s,
                          sequence = %s,
                          updated_by = %s,
                          updated_at = %s
                        WHERE id = %s
                    """
                    
                    values = (
                        update_data["checkout"],
                        update_data["checkout_time"],
                        update_data["checkin"],
                        update_data["checkin_time"],
                        update_data["checkin_pax"],
                        update_data["operation_id"],
                        update_data["cleaned_by_us"],
                        update_data["sequence"],
                        update_data["updated_by"],
                        update_data["updated_at"],
                        task_id
                    )
                    
                    cursor.execute(query, values)
                    connection.commit()
                    total_updated += 1
                    
                    logistic_code = task.get("logistic_code", "N/A")
                    print(f"✅ Task {logistic_code} (ID: {task_id}) trasferita su ADAM")
                    
                except Exception as task_error:
                    total_errors += 1
                    error_msg = f"Task {task.get('logistic_code', 'N/A')}: {str(task_error)}"
                    errors.append(error_msg)
                    print(f"❌ {error_msg}")
        
        print(f"\n✅ Trasferimento completato!")
        print(f"   - Task aggiornate: {total_updated}")
        print(f"   - Errori: {total_errors}")
        
        return {
            "success": True,
            "message": f"Trasferimento completato: {total_updated} task aggiornate{f', {total_errors} errori' if total_errors > 0 else ''}",
            "stats": {
                "updated": total_updated,
                "errors": total_errors,
                "errorDetails": errors
            }
        }
        
    except Exception as e:
        print(f"❌ Errore durante il trasferimento: {e}")
        return {
            "success": False,
            "message": f"Errore durante il trasferimento: {e}"
        }
    finally:
        cursor.close()
        connection.close()


def main():
    """Entry point dello script"""
    
    # Leggi data da argomento da riga di comando
    if len(sys.argv) > 1:
        work_date = sys.argv[1]
    else:
        work_date = datetime.now().strftime("%Y-%m-%d")
        print(f"⚠️ Nessuna data specificata, usando oggi: {work_date}")
    
    # Leggi username (opzionale)
    username = sys.argv[2] if len(sys.argv) > 2 else "system"
    
    # Esegui trasferimento
    result = transfer_to_adam(work_date, username)
    
    # Stampa risultato come JSON
    print(json.dumps(result, indent=2))
    
    # Exit code basato sul successo
    sys.exit(0 if result["success"] else 1)


if __name__ == "__main__":
    main()
