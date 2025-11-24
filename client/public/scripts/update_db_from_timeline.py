#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Script per aggiornare il database MySQL con le assegnazioni dalla timeline.
Legge timeline.json e aggiorna app_housekeeping con cleaned_by_us, sequence, updated_by, updated_at
"""

import json
import mysql.connector
import sys
from datetime import datetime
from pathlib import Path

# ---------- Config ----------
BASE_DIR = Path(__file__).parent.parent / "data"
OUTPUT_DIR = BASE_DIR / "output"
TIMELINE_PATH = OUTPUT_DIR / "timeline.json"

# ---------- Config DB ----------
DB_CONFIG = {
    "host": "139.59.132.41",
    "user": "admin",
    "password": "ed329a875c6c4ebdf4e87e2bbe53a15771b5844ef6606dde",
    "database": "adamdb",
}

def main():
    # Leggi timeline.json
    if not TIMELINE_PATH.exists():
        print(f"❌ File timeline.json non trovato: {TIMELINE_PATH}")
        sys.exit(1)

    try:
        with open(TIMELINE_PATH, "r", encoding="utf-8") as f:
            timeline_data = json.load(f)
    except Exception as e:
        print(f"❌ Errore lettura timeline.json: {e}")
        sys.exit(1)

    cleaners_assignments = timeline_data.get("cleaners_assignments", [])
    
    # Connessione al database
    print(f"🔌 Connessione al database MySQL...")
    try:
        connection = mysql.connector.connect(**DB_CONFIG)
        cursor = connection.cursor()
    except Exception as e:
        print(f"❌ Errore connessione database: {e}")
        sys.exit(1)

    # CRITICAL: Se timeline è vuota (dopo reset), azzera solo cleaned_by_us e sequence
    if not cleaners_assignments:
        print("⚠️ Nessuna assegnazione trovata in timeline.json")
        print("🔄 RESET: Azzeramento cleaned_by_us e sequence per tutte le task della data...")
        
        work_date = timeline_data.get("metadata", {}).get("date")
        if work_date:
            try:
                reset_query = """
                    UPDATE app_housekeeping
                    SET 
                        cleaned_by_us = NULL,
                        sequence = NULL,
                        updated_by = %s,
                        updated_at = %s
                    WHERE DATE(checkin) = %s AND deleted_at IS NULL
                """
                timestamp_roma = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                updated_by = timeline_data.get("metadata", {}).get("modified_by", ["E68"])
                if isinstance(updated_by, list):
                    updated_by = updated_by[-1] if updated_by else "E68"
                
                cursor.execute(reset_query, (updated_by, timestamp_roma, work_date))
                rows_reset = cursor.rowcount
                connection.commit()
                print(f"✅ RESET completato: {rows_reset} task azzerate per la data {work_date}")
            except Exception as e:
                print(f"❌ Errore durante il reset: {e}")
                connection.rollback()
            finally:
                cursor.close()
                connection.close()
        else:
            print("⚠️ Data non trovata nei metadata, impossibile fare reset")
            cursor.close()
            connection.close()
        return

    # Timestamp Roma per updated_at
    timestamp_roma = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # Username da metadata o default
    updated_by = timeline_data.get("metadata", {}).get("modified_by", ["E68"])
    if isinstance(updated_by, list):
        updated_by = updated_by[-1] if updated_by else "E68"

    total_updated = 0
    total_errors = 0

    print(f"📋 Aggiornamento assegnazioni nel database...")

    for assignment in cleaners_assignments:
        cleaner = assignment.get("cleaner")
        tasks = assignment.get("tasks", [])

        if not cleaner or not tasks:
            continue

        cleaner_id = cleaner.get("id")
        if not cleaner_id:
            continue

        for task in tasks:
            task_id = task.get("task_id")
            sequence = task.get("sequence")

            if not task_id:
                print(f"⚠️ Task senza task_id, skip")
                continue

            if sequence is None:
                print(f"⚠️ Task {task_id} senza sequence, skip")
                continue

            try:
                # Aggiorna il record nel database
                # CRITICAL: Include anche i campi modificabili dal dialog
                query = """
                    UPDATE app_housekeeping
                    SET 
                        cleaned_by_us = %s,
                        sequence = %s,
                        checkout = %s,
                        checkout_time = %s,
                        checkin = %s,
                        checkin_time = %s,
                        checkin_pax = %s,
                        operation_id = %s,
                        updated_by = %s,
                        updated_at = %s
                    WHERE id = %s AND deleted_at IS NULL
                """

                cursor.execute(query, (
                    cleaner_id,
                    sequence,
                    task.get("checkout_date"),  # Timeline usa checkout_date ma DB usa checkout
                    task.get("checkout_time"),
                    task.get("checkin_date"),   # Timeline usa checkin_date ma DB usa checkin
                    task.get("checkin_time"),
                    task.get("pax_in"),         # Timeline usa pax_in ma DB usa checkin_pax
                    task.get("operation_id"),
                    updated_by,
                    timestamp_roma,
                    task_id
                ))

                if cursor.rowcount > 0:
                    total_updated += 1
                    print(f"✅ Task {task_id} → cleaner {cleaner_id}, seq {sequence}")
                else:
                    print(f"⚠️ Task {task_id} non trovata o già cancellata")

            except Exception as e:
                total_errors += 1
                print(f"❌ Errore aggiornamento task {task_id}: {e}")

    # Commit delle modifiche
    try:
        connection.commit()
        print(f"\n✅ COMMIT eseguito con successo!")
    except Exception as e:
        print(f"❌ Errore durante il COMMIT: {e}")
        connection.rollback()
        cursor.close()
        connection.close()
        sys.exit(1)

    # Chiudi connessione
    cursor.close()
    connection.close()

    # Riepilogo
    print(f"\n{'='*60}")
    print(f"📊 RIEPILOGO AGGIORNAMENTO DATABASE")
    print(f"{'='*60}")
    print(f"✅ Task aggiornate: {total_updated}")
    print(f"❌ Errori: {total_errors}")
    print(f"👤 Updated by: {updated_by}")
    print(f"🕐 Timestamp: {timestamp_roma}")
    print(f"{'='*60}")

    if total_updated > 0:
        print(f"\n✅ Aggiornamento completato! Verifica con:")
        print(f"   SELECT * FROM app_housekeeping WHERE updated_by = '{updated_by}' ORDER BY updated_at DESC LIMIT 10;")

if __name__ == "__main__":
    main()