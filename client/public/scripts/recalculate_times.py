#!/usr/bin/env python3
"""
Script per ricalcolare travel_time, start_time e end_time
quando le task vengono spostate manualmente.
"""

import sys
import json
from datetime import datetime, timedelta
from typing import List, Dict, Any, Tuple, Optional
from math import radians, cos, sin, asin, sqrt


WORK_START_TIME = "10:00"
WORK_END_TIME = "20:00"
MAX_DISTANCE_KM = 50.0
WORK_START_MIN = int(WORK_START_TIME.split(":")[0]) * 60 + int(WORK_START_TIME.split(":")[1])

DEFAULT_PRIORITY_WINDOWS = {
    # Fallback only: real values should be injected from app_settings by backend callers.
    "EO": {"start_min": WORK_START_MIN},
    "HP": {"start_min": WORK_START_MIN},
    "LP": {"start_min": WORK_START_MIN},
}

PRIORITY_ALIASES = {
    "early_out": "EO",
    "high_priority": "HP",
    "low_priority": "LP",
    "EO": "EO",
    "HP": "HP",
    "LP": "LP",
}


def get_priority_min_start(priority_str: Optional[str],
                           priority_windows: Dict[str, Any]) -> Optional[int]:
    """Returns the minimum start time (in minutes) for a given priority, or None."""
    if not priority_str:
        return None
    normalized = PRIORITY_ALIASES.get(priority_str)
    if not normalized:
        return None
    window = priority_windows.get(normalized)
    if not window:
        return None
    return window.get("start_min")


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Calcola la distanza haversine in km tra due coordinate."""
    lat1_r, lng1_r, lat2_r, lng2_r = map(radians, [lat1, lng1, lat2, lng2])
    dlat = lat2_r - lat1_r
    dlng = lng2_r - lng1_r
    a = sin(dlat/2)**2 + cos(lat1_r) * cos(lat2_r) * sin(dlng/2)**2
    c = 2 * asin(sqrt(a))
    return 6371 * c


def same_building(addr1: Optional[str], addr2: Optional[str]) -> bool:
    """Verifica se due indirizzi sono esattamente lo stesso edificio."""
    if not addr1 or not addr2:
        return False
    return addr1.strip().upper() == addr2.strip().upper()


def same_street(addr1: Optional[str], addr2: Optional[str]) -> bool:
    """Verifica se due indirizzi condividono la stessa via."""
    if not addr1 or not addr2:
        return False

    def normalize_street(address: str) -> str:
        parts = [p.strip() for p in address.upper().split(',')]
        return parts[0] if parts else ""

    street1 = normalize_street(addr1)
    street2 = normalize_street(addr2)

    if not street1 or not street2:
        return False

    return street1 == street2


def travel_minutes(lat1: float, lng1: float, lat2: float, lng2: float,
                   addr1: Optional[str], addr2: Optional[str]) -> float:
    """
    Modello realistico Milano urbano:
    - Percorsi non rettilinei (1.5x haversine)
    - Velocità variabile per distanza
    - Tempo base preparazione
    """
    # Stesso edificio: 3 minuti per cambio appartamento
    # (raccolta attrezzature, scale/ascensore, spostamento)
    if same_building(addr1, addr2):
        return 3.0

    dist_km = haversine_km(lat1, lng1, lat2, lng2)

    if dist_km > MAX_DISTANCE_KM:
        return 9999.0

    # Fattore correzione percorsi non rettilinei
    dist_reale = dist_km * 1.5

    # Modello progressivo
    if dist_reale < 0.8:
        travel_time = dist_reale * 6.0  # ~10 km/h a piedi
    elif dist_reale < 2.5:
        travel_time = dist_reale * 10.0  # ~6 km/h misto
    else:
        travel_time = dist_reale * 5.0  # ~12 km/h mezzi

    # Tempo base
    base_time = 5.0
    total_time = base_time + travel_time

    # Bonus stesso strada (riduce tempo base solo se molto vicini)
    if same_street(addr1, addr2) and dist_km < 0.10:
        total_time = max(total_time - 2.0, 3.0)

    # Limiti allineati con optimizer (phase1.ts: MIN_TRAVEL=2, MAX_TRAVEL=45)
    return max(2.0, min(45.0, total_time))


def time_to_minutes(time_str: str) -> int:
    """Converte una stringa HH:MM o HH:MM:SS in minuti dall'inizio della giornata."""
    parts = time_str.split(':')
    h = int(parts[0])
    m = int(parts[1]) if len(parts) > 1 else 0
    return h * 60 + m


def minutes_to_time(minutes: int) -> str:
    """Converte minuti dall'inizio della giornata in stringa HH:MM."""
    h = minutes // 60
    m = minutes % 60
    return f"{h:02d}:{m:02d}"


def parse_datetime(dt_str: Optional[str]) -> Optional[datetime]:
    """Parse una stringa datetime ISO."""
    if not dt_str:
        return None
    try:
        return datetime.fromisoformat(dt_str.replace('Z', '+00:00'))
    except:
        return None


def recalculate_cleaner_times(cleaner_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Ricalcola travel_time, start_time, end_time per tutte le task di un cleaner.

    Args:
        cleaner_data: Dati del cleaner con formato:
            {
                "cleaner": {...},
                "tasks": [...],
                "priority_windows": {...}  // opzionale, override dei default
            }

    Returns:
        cleaner_data aggiornato con i nuovi tempi
    """
    tasks = cleaner_data.get("tasks", [])
    if not tasks:
        return cleaner_data

    priority_windows = cleaner_data.get("priority_windows", DEFAULT_PRIORITY_WINDOWS)

    # Usa lo start_time del cleaner se disponibile, altrimenti default a 10:00
    cleaner = cleaner_data.get("cleaner", {})
    cleaner_start_time = cleaner.get("start_time", WORK_START_TIME)
    if not cleaner_start_time:
        cleaner_start_time = WORK_START_TIME
    cleaner_end_time = cleaner.get("end_time", WORK_END_TIME)
    if not cleaner_end_time:
        cleaner_end_time = WORK_END_TIME
    
    work_start_min = time_to_minutes(cleaner_start_time)
    work_end_min = time_to_minutes(cleaner_end_time)

    current_time_min = work_start_min
    prev_lat: Optional[float] = None
    prev_lng: Optional[float] = None
    prev_addr: Optional[str] = None

    for i, task in enumerate(tasks):
        # Estrai dati task (gestisci null values)
        lat_raw = task.get("lat")
        lng_raw = task.get("lng")

        # Converti coordinate, usa 0 se null/invalid
        try:
            lat = float(lat_raw) if lat_raw is not None else 0.0
            lng = float(lng_raw) if lng_raw is not None else 0.0
        except (ValueError, TypeError):
            lat = 0.0
            lng = 0.0

        addr = task.get("address", "")

        # Converti cleaning_time, usa 60 se null/invalid
        try:
            cleaning_time = int(task.get("cleaning_time", 60))
        except (ValueError, TypeError):
            cleaning_time = 60

        # Calcola travel_time (sempre ricalcolato per la rotta corrente del cleaner)
        if i == 0:
            travel_time = 0
        else:
            travel_time = int(round(travel_minutes(
                prev_lat, prev_lng, lat, lng, prev_addr, addr
            )))

        # Aggiungi travel time al tempo corrente
        current_time_min += travel_time

        # Calcola start_time e end_time
        # Verifica vincoli di checkout/checkin
        checkout_time_str = task.get("checkout_time")
        checkin_time_str = task.get("checkin_time")

        # Optional override: first apartment dragged on the timeline (30-min snaps).
        # Only sequence 1 keeps it; leftover values on later tasks are dropped.
        manual_start_min = None
        if i == 0:
            manual_start_str = task.get("manual_start_time")
            if manual_start_str:
                try:
                    manual_start_min = time_to_minutes(str(manual_start_str).strip())
                except (ValueError, AttributeError, TypeError):
                    manual_start_min = None
        elif task.get("manual_start_time"):
            task["manual_start_time"] = None

        # CRITICAL: Start time NON può MAI essere prima del checkout_time
        # Il cleaner può iniziare solo DOPO che la proprietà sia libera
        # (salvo override manuale del primo appartamento)
        
        if i == 0:
            # Prima task: calcola arrivo base (work_start + travel_time già aggiunto a current_time_min)
            arrival_min = current_time_min
            
            # Rispetta SEMPRE il checkout_time se presente
            if checkout_time_str:
                try:
                    checkout_min = time_to_minutes(checkout_time_str)
                    # Lo start_time è il MASSIMO tra arrivo e checkout
                    start_time_min = max(arrival_min, checkout_min)
                except (ValueError, AttributeError):
                    # Se checkout_time non è valido, usa l'arrivo
                    start_time_min = arrival_min
            else:
                start_time_min = arrival_min
            
            # Aggiorna current_time_min per la prossima iterazione
            current_time_min = start_time_min
        else:
            # Task successive: current_time_min già include travel_time
            start_time_min = current_time_min
            
            # CRITICAL: Rispetta SEMPRE il checkout_time se presente (anche per task successive)
            if checkout_time_str:
                try:
                    checkout_min = time_to_minutes(checkout_time_str)
                    # Se il tempo calcolato è prima del checkout, posticipa lo start
                    if start_time_min < checkout_min:
                        start_time_min = checkout_min
                        current_time_min = checkout_min
                except (ValueError, AttributeError):
                    # Se checkout_time non è valido, ignora il vincolo
                    pass

        # Enforce priority time window (HP/LP non possono iniziare prima delle 11:00)
        priority_min = get_priority_min_start(task.get("priority"), priority_windows)
        if priority_min is not None and start_time_min < priority_min:
            start_time_min = priority_min
            current_time_min = start_time_min

        # First-apartment drag override wins over checkout/priority, not over shift start.
        if i == 0 and manual_start_min is not None:
            start_time_min = max(work_start_min, manual_start_min)
            current_time_min = start_time_min

        # End time: start + cleaning_time
        end_time_min = start_time_min + cleaning_time

        # Verifica vincolo checkin (allineato con optimizer Phase 3)
        # Se checkin_date è diverso dal work_date, il vincolo non si applica oggi
        checkin_date_str = task.get("checkin_date")
        if checkin_time_str:
            checkin_min = time_to_minutes(checkin_time_str)
            apply_checkin = True
            if checkin_date_str:
                try:
                    work_date_str = cleaner_data.get("work_date")
                    if work_date_str and checkin_date_str != work_date_str:
                        apply_checkin = False
                except (ValueError, TypeError):
                    pass
            if apply_checkin and end_time_min > checkin_min:
                task["_checkin_violated"] = True

        # Verifica che non superi la fine del turno
        if end_time_min > work_end_min:
            # Non feasible, ma salviamo comunque i tempi calcolati
            pass

        # Aggiorna task
        task["travel_time"] = travel_time
        task["start_time"] = minutes_to_time(start_time_min)
        task["end_time"] = minutes_to_time(end_time_min)
        task["sequence"] = i + 1
        task["followup"] = i > 0

        # Aggiorna per prossima iterazione
        current_time_min = end_time_min
        prev_lat = lat
        prev_lng = lng
        prev_addr = addr

    return cleaner_data


def main():
    """Main entry point. Legge JSON da stdin per evitare ARG_MAX limit."""
    try:
        # Leggi sempre da stdin (evita ARG_MAX e command injection)
        input_data = sys.stdin.read()
        if not input_data:
            print(json.dumps({
                "success": False,
                "error": "No input data provided on stdin"
            }))
            sys.exit(1)

        cleaner_data = json.loads(input_data)

        # Ricalcola tempi
        updated_data = recalculate_cleaner_times(cleaner_data)

        # Output JSON
        print(json.dumps({
            "success": True,
            "cleaner_data": updated_data
        }, indent=2))

    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": str(e)
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()