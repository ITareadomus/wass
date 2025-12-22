# -*- coding: utf-8 -*-
"""
Helper comuni per assign_eo.py, assign_hp.py, assign_lp.py
"""
from typing import List, Callable, Any
from collections import deque

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


# --- COSTANTI CLUSTER GIORNALIERO ---

CLUSTER_NEAR_MIN = 10              # min: soglia per cluster "normale" (grafo connesso)
CLUSTER_VERY_NEAR_MIN = 5          # min: soglia per sbloccare la 4ª task
BASE_MAX_TASKS_PER_DAY = 3         # max task/giorno normalmente
ABSOLUTE_MAX_TASKS_PER_DAY = 4     # max assoluto task/giorno (solo con cluster)


# --- HELPER CLUSTER GIORNALIERO ---

def is_connected_cluster(tasks: List[Any], travel_minutes_fn: Callable[[Any, Any], int], threshold_min: int) -> bool:
    """
    Verifica se le task formano un grafo connesso con soglia threshold_min.
    Due task sono collegate se travel_minutes_fn(t1, t2) <= threshold_min.
    Ritorna True se tutte le task sono raggiungibili da qualsiasi altra.
    """
    if len(tasks) <= 1:
        return True
    
    adj = {i: [] for i in range(len(tasks))}
    for i in range(len(tasks)):
        for j in range(i + 1, len(tasks)):
            travel = travel_minutes_fn(tasks[i], tasks[j])
            if travel <= threshold_min:
                adj[i].append(j)
                adj[j].append(i)
    
    visited = set()
    queue = deque([0])
    visited.add(0)
    
    while queue:
        node = queue.popleft()
        for neighbor in adj[node]:
            if neighbor not in visited:
                visited.add(neighbor)
                queue.append(neighbor)
    
    return len(visited) == len(tasks)


def has_edge_within(tasks: List[Any], candidate: Any, travel_minutes_fn: Callable[[Any, Any], int], threshold_min: int) -> bool:
    """
    Ritorna True se il candidato è entro threshold_min da almeno una task in tasks.
    """
    if not tasks:
        return True
    
    for t in tasks:
        if travel_minutes_fn(candidate, t) <= threshold_min:
            return True
    return False


def can_add_task_daily(daily_tasks: List[Any], candidate: Any, travel_minutes_fn: Callable[[Any, Any], int], extra_count: int = 0) -> bool:
    """
    Verifica se è possibile aggiungere una task al totale giornaliero del cleaner.
    
    Args:
        daily_tasks: Lista di task disponibili come oggetti (per cluster check)
        candidate: Task candidata da aggiungere
        travel_minutes_fn: Funzione per calcolare travel time tra due task
        extra_count: Numero di task aggiuntive da fasi precedenti (senza oggetti disponibili)
    
    Regole:
    - Se totale < 3 → puoi aggiungere
    - Se totale == 3 → puoi aggiungere la 4ª solo se:
        1. daily_tasks è un cluster connesso a 10 min
        2. candidate è ≤ 5 min da almeno una task in daily_tasks
        3. daily_tasks + candidate resta un cluster connesso a 10 min
    - Se totale >= 4 → stop
    
    Nota: extra_count conta task da fasi precedenti che non sono disponibili come oggetti.
    Il cluster check viene fatto solo sulle task disponibili (daily_tasks).
    """
    n = len(daily_tasks)
    total = n + extra_count
    
    # Limite assoluto: mai più di 4 task
    if total >= ABSOLUTE_MAX_TASKS_PER_DAY:
        return False
    
    # Se abbiamo meno di 3 task totali, possiamo sempre aggiungere
    if total < BASE_MAX_TASKS_PER_DAY:
        return True
    
    # Se siamo esattamente a 3 task totali, possiamo aggiungere la 4ª solo con cluster
    if total == BASE_MAX_TASKS_PER_DAY:
        # Se non abbiamo task come oggetti per il cluster check, blocchiamo
        if not daily_tasks:
            return False
        
        # Cluster check sulle task disponibili
        if not is_connected_cluster(daily_tasks, travel_minutes_fn, CLUSTER_NEAR_MIN):
            return False
        if not has_edge_within(daily_tasks, candidate, travel_minutes_fn, CLUSTER_VERY_NEAR_MIN):
            return False
        if not is_connected_cluster(daily_tasks + [candidate], travel_minutes_fn, CLUSTER_NEAR_MIN):
            return False
        return True
    
    return False


def get_daily_tasks_count(cleaner) -> int:
    """
    Ritorna il numero totale di task giornaliere del cleaner.
    Cerca prima daily_tasks, poi total_daily_tasks + route.
    """
    if hasattr(cleaner, 'daily_tasks') and cleaner.daily_tasks is not None:
        return len(cleaner.daily_tasks)
    total = getattr(cleaner, 'total_daily_tasks', 0)
    route_count = len(getattr(cleaner, 'route', []))
    return total + route_count


def get_daily_tasks_list(cleaner) -> List[Any]:
    """
    Ritorna la lista di tutte le task giornaliere del cleaner.
    Se daily_tasks esiste, la usa. Altrimenti concatena le task da diverse fasi.
    """
    if hasattr(cleaner, 'daily_tasks') and cleaner.daily_tasks is not None:
        return list(cleaner.daily_tasks)
    return list(getattr(cleaner, 'route', []))


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