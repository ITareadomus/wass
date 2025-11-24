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
WORK_END_TIME = "19:00"
MAX_DISTANCE_KM = 50.0


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

    # Limiti: min 3 min, max 50 min
    return max(3.0, min(50.0, total_time))


def time_to_minutes(time_str: str) -> int:
    """Converte una stringa HH:MM in minuti dall'inizio della giornata."""
    h, m = map(int, time_str.split(':'))
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
                "tasks": [...]
            }

    Returns:
        cleaner_data aggiornato con i nuovi tempi
    """
    tasks = cleaner_data.get("tasks", [])
    if not tasks:
        return cleaner_data

    work_start_min = time_to_minutes(WORK_START_TIME)
    work_end_min = time_to_minutes(WORK_END_TIME)

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

        # Calcola travel_time
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

        # CRITICAL: Start time NON può essere prima del checkout_time
        # Il cleaner può iniziare solo DOPO che la proprietà è libera
        
        # Per la prima task (i==0), se ha checkout_time, inizia da lì invece che da work_start
        if i == 0 and checkout_time_str:
            checkout_min = time_to_minutes(checkout_time_str)
            # Posiziona la prima task al checkout_time (mai prima)
            start_time_min = max(work_start_min, checkout_min)
            current_time_min = start_time_min
        else:
            start_time_min = current_time_min
            
            # Per task successive, rispetta comunque il checkout_time se presente
            if checkout_time_str:
                checkout_min = time_to_minutes(checkout_time_str)
                # Se il tempo calcolato è prima del checkout, posticipa lo start
                if start_time_min < checkout_min:
                    start_time_min = checkout_min
                    # Aggiorna anche current_time_min per mantenere coerenza
                    current_time_min = checkout_min

        # End time: start + cleaning_time
        end_time_min = start_time_min + cleaning_time

        # Verifica vincolo checkin (se presente, end_time non può superarlo)
        if checkin_time_str:
            checkin_min = time_to_minutes(checkin_time_str)
            if end_time_min > checkin_min:
                # Non feasible, ma salviamo comunque i tempi calcolati
                pass

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