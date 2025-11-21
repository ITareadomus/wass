
# -*- coding: utf-8 -*-
"""
Helper comuni per assign_eo.py, assign_hp.py, assign_lp.py
"""

# --- COSTANTI GLOBALI TUNABILI ---

NEARBY_TRAVEL_THRESHOLD = 7        # min: soglia per considerare due apt "stesso blocco"
NEW_CLEANER_PENALTY_MIN = 60       # costo di attivazione per cleaner vuoto (prima 30)
NEW_TRAINER_PENALTY_MIN = 0        # il formatore non è penalizzato per il primo task
TARGET_MIN_LOAD_MIN = 240          # 4 ore = carico minimo "desiderato" (prima 180)
FAIRNESS_DELTA_HOURS = 1.0         # tolleranza di 1h tra cleaner per essere "fair"
LOAD_WEIGHT = 10                   # peso delle ore nel punteggio
SAME_BUILDING_BONUS = -5           # bonus per cluster edificio/blocco
ROLE_TRAINER_BONUS = -5            # bonus extra per Formatore (solo LP)


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
