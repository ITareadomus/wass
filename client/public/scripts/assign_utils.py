# -*- coding: utf-8 -*-
"""
Helper comuni per assign_eo.py, assign_hp.py, assign_lp.py
"""

# --- COSTANTI GLOBALI TUNABILI ---

NEARBY_TRAVEL_THRESHOLD = 7        # min: soglia per considerare due apt "stesso blocco"

NEW_CLEANER_PENALTY_MIN = 60       # costo di attivazione per cleaner vuoto
NEW_TRAINER_PENALTY_MIN = 0        # il formatore non è penalizzato per il primo task

TARGET_MIN_LOAD_MIN = 240          # 4 ore = carico minimo "desiderato" per TUTTI
TRAINER_TARGET_MIN_LOAD_MIN = 240  # 4 ore = target specifico per il Formatore

FAIRNESS_DELTA_HOURS = 1.0         # tolleranza di 1h tra cleaner per essere "fair"
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
    - Devono essere formatori O premium (inclusi straordinari marcati come premium)
    - Escludi cleaners esplicitamente 'Standard'
    - Escludi cleaners con start_time >= 11:00
    - Ritorna ordinati per (straordinari, premium, ore lavorate DESC)
    """
    suitable = []
    for c in all_cleaners:
        # CRITICAL: Escludi cleaners con start_time >= 11:00
        start_time = getattr(c, 'start_time', None)
        if start_time and start_time >= "11:00":
            continue

        role = c.role.strip().lower()
        # Formatore: sempre incluso
        if "formatore" in role or "trainer" in role:
            suitable.append(c)
            continue
        # Premium o Straordinario: includi
        if "premium" in role or "straordinario" in role or c.can_do_straordinaria:
            suitable.append(c)
            continue
        # Standard: escludi da EO
        if "standard" in role:
            continue

    # Ordina: straordinari > premium > ore lavorate DESC
    suitable.sort(
        key=lambda x: (
            not x.can_do_straordinaria,  # Straordinari per primi
            "premium" not in x.role.lower(),
            -getattr(x, 'counter_hours', 0)
        )
    )
    return suitable