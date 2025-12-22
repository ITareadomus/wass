# -*- coding: utf-8 -*-
"""
Helper comuni per assign_eo.py, assign_hp.py, assign_lp.py
"""

# --- COSTANTI GLOBALI TUNABILI ---

NEARBY_TRAVEL_THRESHOLD = 5        # min: soglia per considerare due apt "stesso blocco" (da 7)

NEW_CLEANER_PENALTY_MIN = 45       # costo di attivazione per cleaner vuoto (da 60)
NEW_TRAINER_PENALTY_MIN = 0        # il formatore non è penalizzato per il primo task

TARGET_MIN_LOAD_MIN = 240          # 4 ore = carico minimo "desiderato" per TUTTI
TRAINER_TARGET_MIN_LOAD_MIN = 240  # 4 ore = target specifico per il Formatore

FAIRNESS_DELTA_HOURS = 0.5         # tolleranza di 30' tra cleaner per essere "fair" (da 1.0)
LOAD_WEIGHT = 10                   # peso delle ore nel punteggio
SAME_BUILDING_BONUS = -5           # bonus per cluster edificio/blocco

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


def get_cleaners_for_eo(all_cleaners):
    """
    Filtra i cleaners adatti per le task Early-Out:
    - Escludi SOLO cleaners con start_time >= 11:00
    - Include TUTTI gli altri cleaners (Formatori, Premium, Standard)
    - Ritorna ordinati per (straordinari, premium, ore lavorate DESC)
    """
    suitable = []
    for c in all_cleaners:
        # CRITICAL: Escludi cleaners con start_time >= 11:00
        start_time = getattr(c, 'start_time', None)
        if start_time and start_time >= "11:00":
            continue

        # Include TUTTI i cleaners con start_time < 11:00
        suitable.append(c)

    # Ordina: straordinari > premium > standard > ore lavorate DESC
    suitable.sort(
        key=lambda x: (
            not x.can_do_straordinaria,  # Straordinari per primi
            "premium" not in x.role.lower(),  # Premium dopo straordinari
            "standard" in x.role.lower(),  # Standard per ultimi
            -getattr(x, 'counter_hours', 0)
        )
    )
    return suitable