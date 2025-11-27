# -*- coding: utf-8 -*-
"""
Helper comuni per assign_eo.py, assign_hp.py, assign_lp.py
"""

# --- COSTANTI GLOBALI TUNABILI ---

NEARBY_TRAVEL_THRESHOLD = 7        # min: soglia per considerare due apt "stesso blocco"
NEARBY_DISTANCE_KM = 0.25          # km: soglia per considerare due apt "molto vicini" (250m)

NEW_CLEANER_PENALTY_MIN = 60       # costo di attivazione per cleaner vuoto
NEW_TRAINER_PENALTY_MIN = 0        # il formatore non è penalizzato per il primo task

TARGET_MIN_LOAD_MIN = 240          # 4 ore = carico minimo "desiderato" per TUTTI
TRAINER_TARGET_MIN_LOAD_MIN = 240  # 4 ore = target specifico per il Formatore

FAIRNESS_DELTA_HOURS = 1.0         # tolleranza di 1h tra cleaner per essere "fair"
LOAD_WEIGHT = 10                   # peso delle ore nel punteggio
SAME_BUILDING_BONUS = -5           # bonus per stessa via (include stesso edificio e blocco vicino)
NEARBY_CLUSTER_BONUS = -8          # bonus moderato per appartamenti molto vicini geograficamente (ridotto da -20)

ROLE_TRAINER_BONUS = -10           # bonus extra per il Formatore (prima -5)


# --- HELPER CARICO ---

def cleaner_load_minutes(cleaner) -> int:
    """
    Carico totale in minuti di un cleaner basato sulle task già assegnate.
    Somma cleaning_time + eventuale travel_time se già presente.
    """
    total = 0
    for t in cleaner.route:
        total += getattr(t, "cleaning_time", 0) or 0
        total += getattr(t, "travel_time", 0) or 0
    return int(total)


def cleaner_load_hours(cleaner) -> float:
    return cleaner_load_minutes(cleaner) / 60.0


# --- CLUSTERING GEOGRAFICO ---

def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Calcola la distanza in km tra due coordinate usando la formula di Haversine.
    """
    import math
    R = 6371.0  # Raggio della Terra in km
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(dl / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


def haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Calcola la distanza in METRI tra due coordinate usando la formula di Haversine.
    Più preciso di haversine_km per distanze brevi (< 1 km).
    """
    import math
    R = 6371000.0  # Raggio della Terra in METRI
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(dl / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


def is_nearby_cluster(task1, task2) -> bool:
    """
    Verifica se due task sono "molto vicine" geograficamente.
    Ritorna True se la distanza è <= NEARBY_DISTANCE_KM (es: Via Tortona e Via Voghera).

    Usa calcolo in METRI per massima precisione su distanze brevi.

    Args:
        task1, task2: Task object con attributi lat, lng

    Returns:
        True se task molto vicine (entro 250m), False altrimenti
    """
    try:
        if not hasattr(task1, 'lat') or not hasattr(task2, 'lat'):
            return False
        if not hasattr(task1, 'lng') or not hasattr(task2, 'lng'):
            return False

        lat1 = float(task1.lat)
        lng1 = float(task1.lng)
        lat2 = float(task2.lat)
        lng2 = float(task2.lng)

        # Usa calcolo in METRI per massima precisione
        distance_meters = haversine_meters(lat1, lng1, lat2, lng2)
        threshold_meters = NEARBY_DISTANCE_KM * 1000  # Converti km in metri
        
        return distance_meters <= threshold_meters
    except (ValueError, TypeError, AttributeError):
        return False


def count_nearby_tasks(cleaner, new_task) -> int:
    """
    Conta quante task esistenti nel route del cleaner sono "molto vicine" alla nuova task.
    Utile per dare priorità ai cleaner che hanno già task nella stessa zona.

    Args:
        cleaner: Cleaner object con attributo route (lista di task)
        new_task: Task object da confrontare

    Returns:
        Numero di task vicine (entro NEARBY_DISTANCE_KM)
    """
    count = 0
    for existing_task in cleaner.route:
        if is_nearby_cluster(existing_task, new_task):
            count += 1
    return count


def recalculate_cleaner_times(cleaner_data, tasks_list):
    """
    Ricalcola travel_time, start_time, end_time per tutte le task di un cleaner.
    Wrapper che chiama recalculate_times.py tramite subprocess.

    Args:
        cleaner_data: Dict con info cleaner {"id", "name", "start_time", ...}
        tasks_list: Lista di task dict da ricalcolare

    Returns:
        Lista di task aggiornate con tempi ricalcolati
    """
    import subprocess
    import json
    from pathlib import Path

    # Prepara il payload per lo script Python
    payload = {
        "cleaner": cleaner_data,
        "tasks": tasks_list
    }

    # Path dello script recalculate_times.py
    script_path = Path(__file__).parent / "recalculate_times.py"

    try:
        # Esegui lo script Python passando il JSON via stdin
        result = subprocess.run(
            ["python3", str(script_path)],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=30
        )

        if result.returncode != 0:
            print(f"⚠️ recalculate_times.py error: {result.stderr}")
            return tasks_list  # Fallback: ritorna task originali

        # Parse output
        output = json.loads(result.stdout)
        if output.get("success"):
            return output["cleaner_data"]["tasks"]
        else:
            print(f"⚠️ recalculate_times.py failed: {output.get('error')}")
            return tasks_list

    except Exception as e:
        print(f"⚠️ Error calling recalculate_times.py: {e}")
        return tasks_list  # Fallback: ritorna task originali