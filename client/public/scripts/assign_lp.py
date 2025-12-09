# -*- coding: utf-8 -*-
from __future__ import annotations
import json, math, argparse
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path
import sys
from datetime import datetime
from task_validation import can_cleaner_handle_task, can_cleaner_handle_apartment, can_cleaner_handle_priority
from assign_utils import (
    NEARBY_TRAVEL_THRESHOLD, NEW_CLEANER_PENALTY_MIN, NEW_TRAINER_PENALTY_MIN,
    TARGET_MIN_LOAD_MIN, TRAINER_TARGET_MIN_LOAD_MIN, FAIRNESS_DELTA_HOURS, LOAD_WEIGHT,
    SAME_BUILDING_BONUS, ROLE_TRAINER_BONUS,
    cleaner_load_minutes, cleaner_load_hours
)

# API Client import (required)
try:
    from api_client import ApiClient
    API_AVAILABLE = True
except ImportError:
    API_AVAILABLE = False

# =============================
# I/O paths (kept for reference only)
# =============================
BASE = Path(__file__).parent.parent / "data"
SETTINGS_PATH = BASE / "input" / "settings.json"

# Variabile globale per la data di lavoro e modalità API
WORK_DATE: Optional[str] = None
USE_API: bool = False

# =============================
# CONFIG - REGOLE CLUSTERING OTTIMIZZATE
# =============================
BASE_MAX_TASKS = 2  # Base: max 2 task per cleaner
CLUSTER_PRIORITY_TRAVEL = 5.0
CLUSTER_EXTENDED_TRAVEL = 10.0
CLUSTER_MAX_TRAVEL = 15.0
ZONE_RADIUS_KM = 0.8  # ~800m, zona
ABSOLUTE_MAX_TASKS = 4  # Max assoluto 4 task
ABSOLUTE_MAX_TASKS_IF_BEFORE_18 = 5  # Max 5 task se finisce entro le 18:00

# NUOVO: Limite per tipologia FLESSIBILE (può essere infranto da cluster)
BASE_MAX_TASKS_PER_PRIORITY = 2  # Max 2 task Low-Priority per cleaner (base)

# NUOVO: Limite giornaliero totale
MAX_DAILY_TASKS = 5  # Max 5 task totali per cleaner al giorno (hard limit)
PREFERRED_DAILY_TASKS = 4  # Preferibile max 4 task totali (soft limit)
PREFERRED_TRAVEL = 20.0  # Preferenza per percorsi < 20'

NEARBY_TRAVEL_THRESHOLD = 7  # minuti, soglia per considerare due apt "stesso blocco"

# Travel model (min)
SHORT_RANGE_KM = 0.30
SHORT_BASE_MIN = 3.5
WALK_SLOW_MIN_PER_KM = 16.0

BASE_OVERHEAD_MIN = 6.0
SCALED_OH_KM = 0.50
K_SWITCH_KM = 1.2
WALK_MIN_PER_KM = 12.0
RIDE_MIN_PER_KM = 4.5

EQ_EXTRA_LT05 = 2.0
EQ_EXTRA_GE05 = 1.0

MIN_TRAVEL = 2.0
MAX_TRAVEL = 45.0


@dataclass
class Task:
    task_id: str
    logistic_code: str
    lat: float
    lng: float
    cleaning_time: int
    is_premium: bool
    checkin_dt: Optional[datetime] = None
    checkout_dt: Optional[datetime] = None
    apt_type: Optional[str] = None
    address: Optional[str] = None
    alias: Optional[str] = None
    small_equipment: bool = False
    straordinaria: bool = False


@dataclass
class Cleaner:
    id: Any
    name: str
    lastname: str
    role: str
    is_premium: bool
    can_do_straordinaria: bool = False
    available_from: Optional[int] = None  # in minuti da mezzanotte
    last_address: Optional[str] = None
    last_lat: Optional[float] = None
    last_lng: Optional[float] = None
    last_sequence: int = 0
    route: List[Task] = field(default_factory=list)
    total_daily_tasks: int = 0  # Totale task giornaliere (EO + HP + LP)


# -------- Utils --------
def hhmm_to_min(hhmm: Optional[str], default: str = "10:00") -> int:
    if not hhmm or not isinstance(hhmm, str) or ":" not in hhmm:
        hhmm = default
    # Rimuovi i secondi se presenti (es. "10:30:00" -> "10:30")
    parts = hhmm.strip().split(":")
    h, m = int(parts[0]), int(parts[1])
    return h * 60 + m


def min_to_hhmm(m: float) -> str:
    m = int(round(m))
    return f"{m//60:02d}:{m%60:02d}"


def normalize_addr(s: Optional[str]) -> str:
    s = (s or "").upper()
    for ch in [".", ","]:
        s = s.replace(ch, " ")
    s = " ".join(s.split())
    return s.strip()


def split_street_number(addr: str):
    tokens = addr.split()
    if not tokens:
        return "", None
    last = tokens[-1]
    if any(ch.isdigit() for ch in last):
        return " ".join(tokens[:-1]).strip(), last
    return addr, None


def same_building(a: Optional[str], b: Optional[str]) -> bool:
    na, nb = normalize_addr(a), normalize_addr(b)
    if not na or not nb:
        return False
    sa, ca = split_street_number(na)
    sb, cb = split_street_number(nb)
    return (sa == sb) and (ca is not None) and (cb is not None) and (ca == cb)


def same_street(a: Optional[str], b: Optional[str]) -> bool:
    na, nb = normalize_addr(a), normalize_addr(b)
    if not na or not nb:
        return False
    sa, _ = split_street_number(na)
    sb, _ = split_street_number(nb)
    return sa == sb


def same_zone(a_lat: float, a_lng: float, b_lat: float, b_lng: float,
              a_addr: Optional[str] = None, b_addr: Optional[str] = None) -> bool:
    if a_addr and b_addr:
        if same_building(a_addr, b_addr):
            return True
        if same_street(a_addr, b_addr):
            return True

    try:
        km = haversine_km(a_lat, a_lng, b_lat, b_lng)
    except Exception:
        return False

    return km <= ZONE_RADIUS_KM


def is_nearby_same_block(t1: Task, t2: Task) -> bool:
    if same_building(t1.address, t2.address):
        return True

    same_client = (
        getattr(t1, 'client_id', None) == getattr(t2, 'client_id', None)
        or getattr(t1, 'customer_name', None) == getattr(t2, 'customer_name', None)
        or getattr(t1, 'alias', None) == getattr(t2, 'alias', None)
    )

    if not same_client:
        return False

    if travel_minutes(t1.lat, t1.lng, t2.lat, t2.lng, t1.address, t2.address) <= NEARBY_TRAVEL_THRESHOLD:
        return True

    return False


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(dl / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


def travel_minutes(a_lat: float, a_lng: float, b_lat: float, b_lng: float,
                   a_addr: Optional[str] = None, b_addr: Optional[str] = None) -> float:
    if a_addr and b_addr and same_building(a_addr, b_addr):
        return 3.0

    km = haversine_km(a_lat, a_lng, b_lat, b_lng)

    dist_reale = km * 1.5

    if dist_reale < 0.8:
        travel_time = dist_reale * 6.0
    elif dist_reale < 2.5:
        travel_time = dist_reale * 10.0
    else:
        travel_time = dist_reale * 5.0

    base_time = 5.0
    total_time = base_time + travel_time

    if a_addr and b_addr and same_street(a_addr, b_addr) and km < 0.10:
        total_time = max(total_time - 2.0, MIN_TRAVEL)

    return max(MIN_TRAVEL, min(MAX_TRAVEL, total_time))


def can_handle_premium(cleaner: Cleaner, task: Task) -> bool:
    if task.is_premium and not cleaner.is_premium:
        return False
    if task.straordinaria and not cleaner.can_do_straordinaria:
        return False
    return True


# -------- Schedulazione / costo --------
def evaluate_route(cleaner: Cleaner, route: List[Task]) -> Tuple[bool, List[Tuple[int, int, int]]]:
    if not route:
        return True, []

    MAX_END_TIME = 19 * 60

    schedule: List[Tuple[int, int, int]] = []

    first = route[0]

    work_start_min = cleaner.available_from if cleaner.available_from is not None else 10 * 60

    if cleaner.last_lat is not None and cleaner.last_lng is not None:
        tt = travel_minutes(
            cleaner.last_lat, cleaner.last_lng,
            first.lat, first.lng,
            cleaner.last_address, first.address
        )
    else:
        if cleaner.last_sequence == 0 and not cleaner.last_address:
            tt = 0.0
        else:
            tt = 3.0 if same_street(cleaner.last_address, first.address) else 12.0

    arrival = work_start_min + tt

    if first.straordinaria:
        if hasattr(first, 'checkout_dt') and first.checkout_dt:
            checkout_minutes = first.checkout_dt.hour * 60 + first.checkout_dt.minute
            start = max(arrival, checkout_minutes)
            arrival = start
        else:
            start = arrival
    else:
        if hasattr(first, 'checkout_dt') and first.checkout_dt:
            checkout_minutes = first.checkout_dt.hour * 60 + first.checkout_dt.minute
            start = max(arrival, checkout_minutes)
        else:
            start = arrival

    finish = start + first.cleaning_time

    if hasattr(first, 'checkin_dt') and first.checkin_dt:
        if hasattr(first, 'checkout_dt') and first.checkout_dt:
            same_day = first.checkin_dt.date() == first.checkout_dt.date()
        else:
            same_day = True

        if same_day:
            checkin_minutes = first.checkin_dt.hour * 60 + first.checkin_dt.minute
            if finish > checkin_minutes:
                return False, []

    if finish > MAX_END_TIME:
        return False, []

    schedule.append((int(arrival), int(start), int(finish)))
    cur = finish

    for i in range(1, len(route)):
        t = route[i]
        prev = route[i - 1]
        tt = travel_minutes(prev.lat, prev.lng, t.lat, t.lng, prev.address, t.address)
        cur += tt
        arrival = cur
        start = cur
        finish = start + t.cleaning_time

        if hasattr(t, 'checkin_dt') and t.checkin_dt:
            if hasattr(t, 'checkout_dt') and t.checkout_dt:
                same_day = t.checkin_dt.date() == t.checkout_dt.date()
            else:
                same_day = True

            if same_day:
                checkin_minutes = t.checkin_dt.hour * 60 + t.checkin_dt.minute
                if finish > checkin_minutes:
                    return False, []

        if finish > MAX_END_TIME:
            return False, []

        schedule.append((int(arrival), int(start), int(finish)))
        cur = finish

    return True, schedule


def can_add_lp_task(cleaner: Cleaner, all_cleaners: List[Cleaner]) -> bool:
    current_lp_count = len(cleaner.route)
    total_daily = cleaner.total_daily_tasks + current_lp_count

    if total_daily >= MAX_DAILY_TASKS:
        return False

    eo_hp_count = cleaner.total_daily_tasks

    dynamic_max_lp = 0
    if eo_hp_count == 0:
        dynamic_max_lp = 3
    elif eo_hp_count == 1:
        dynamic_max_lp = 3
    elif eo_hp_count == 2:
        dynamic_max_lp = 2
    elif eo_hp_count == 3:
        dynamic_max_lp = 1
    else:
        dynamic_max_lp = 0

    if current_lp_count >= dynamic_max_lp:
        preferred_daily_reached = [
            (c.total_daily_tasks + len(c.route)) >= PREFERRED_DAILY_TASKS
            for c in all_cleaners if c is not cleaner
        ]
        if all(preferred_daily_reached) and total_daily < MAX_DAILY_TASKS:
            if current_lp_count < MAX_DAILY_TASKS - cleaner.total_daily_tasks:
                return True
            else:
                return False
        else:
            return False

    return True


def can_add_task(cleaner: Cleaner, task: Task) -> bool:
    if task.apt_type and not can_cleaner_handle_apartment(cleaner.role, task.apt_type):
        return False

    if not can_handle_premium(cleaner, task):
        return False

    current_count = len(cleaner.route)

    total_daily = cleaner.total_daily_tasks + current_count

    if total_daily >= MAX_DAILY_TASKS:
        return False

    if task.straordinaria:
        if current_count > 0:
            return False

    if current_count > 0 and cleaner.route[0].straordinaria:
        if task.straordinaria:
            return False

    if current_count > 0:
        is_priority_cluster = any(
            (travel_minutes(existing_task.lat, existing_task.lng, task.lat, task.lng,
                          existing_task.address, task.address) <= CLUSTER_PRIORITY_TRAVEL or
             travel_minutes(task.lat, task.lng, existing_task.lat, existing_task.lng,
                          task.address, task.address) <= CLUSTER_PRIORITY_TRAVEL or
             same_street(existing_task.address, task.address))
            for existing_task in cleaner.route
        )

        is_extended_cluster = any(
            (travel_minutes(existing_task.lat, existing_task.lng, task.lat, task.lng,
                          existing_task.address, task.address) <= CLUSTER_EXTENDED_TRAVEL or
             travel_minutes(task.lat, task.lng, existing_task.lat, existing_task.lng,
                          task.address, task.address) <= CLUSTER_EXTENDED_TRAVEL)
            for existing_task in cleaner.route
        )

        if is_priority_cluster:
            if total_daily >= MAX_DAILY_TASKS:
                return False
            if current_count >= ABSOLUTE_MAX_TASKS:
                return False
            return True

        if is_extended_cluster:
            if total_daily >= MAX_DAILY_TASKS:
                return False
            if current_count >= ABSOLUTE_MAX_TASKS:
                return False
            return True

    eo_hp_count = cleaner.total_daily_tasks

    if eo_hp_count == 0:
        dynamic_max_lp = 3
    elif eo_hp_count == 1:
        dynamic_max_lp = 3
    elif eo_hp_count == 2:
        dynamic_max_lp = 2
    elif eo_hp_count == 3:
        dynamic_max_lp = 1
    else:
        dynamic_max_lp = 0

    if current_count >= dynamic_max_lp and not (current_count < BASE_MAX_TASKS):
        if not (is_priority_cluster or is_extended_cluster):
            return False

    if current_count < BASE_MAX_TASKS:
        return True

    if current_count >= BASE_MAX_TASKS and current_count < ABSOLUTE_MAX_TASKS:
        test_route = cleaner.route + [task]
        feasible, schedule = evaluate_route(cleaner, test_route)
        if feasible and schedule:
            last_finish = schedule[-1][2]
            if current_count < ABSOLUTE_MAX_TASKS_IF_BEFORE_18 and last_finish <= 18 * 60:
                return True
            elif current_count < ABSOLUTE_MAX_TASKS:
                return True

    return False


def find_best_position(cleaner: Cleaner, task: Task) -> Optional[Tuple[int, float]]:
    if not can_add_task(cleaner, task):
        return None

    best_pos = None
    best_travel = float('inf')

    if task.straordinaria:
        test_route = [task] + cleaner.route
        feasible, _ = evaluate_route(cleaner, test_route)
        if feasible:
            return (0, 0.0)
        else:
            return None

    for pos in range(len(cleaner.route) + 1):
        test_route = cleaner.route[:pos] + [task] + cleaner.route[pos:]
        feasible, _ = evaluate_route(cleaner, test_route)

        if not feasible:
            continue

        if pos == 0:
            if cleaner.last_lat is not None and cleaner.last_lng is not None:
                travel_to = travel_minutes(cleaner.last_lat, cleaner.last_lng,
                                         task.lat, task.lng,
                                         cleaner.last_address, task.address)
            else:
                travel_to = 3.0 if same_street(cleaner.last_address, task.address) else 12.0

            if len(cleaner.route) > 0:
                next_task = cleaner.route[0]
                travel_from = travel_minutes(task.lat, task.lng, next_task.lat, next_task.lng,
                                            task.address, next_task.address)
            else:
                travel_from = 0.0

            max_travel = max(travel_to, travel_from)
        else:
            prev_task = cleaner.route[pos - 1]
            travel_to = travel_minutes(prev_task.lat, prev_task.lng, task.lat, task.lng,
                                      prev_task.address, task.address)

            if pos < len(cleaner.route):
                next_task = cleaner.route[pos]
                travel_from = travel_minutes(task.lat, task.lng, next_task.lat, next_task.lng,
                                            task.address, next_task.address)
            else:
                travel_from = 0.0

            max_travel = max(travel_to, travel_from)

        if max_travel < best_travel:
            best_travel = max_travel
            best_pos = pos

    if best_pos is not None:
        return (best_pos, best_travel)

    return None


# -------- API Data Loading Functions --------
def load_cleaners_data() -> List[Dict]:
    """Carica dati cleaners da API (unica fonte)."""
    global WORK_DATE
    
    if not API_AVAILABLE:
        raise RuntimeError("API client non disponibile - impossibile procedere")
    
    if not WORK_DATE:
        raise RuntimeError("WORK_DATE non impostata - impossibile procedere")
    
    client = ApiClient()
    cleaners_list = client.get_selected_cleaners(WORK_DATE)
    if cleaners_list:
        print(f"   ✅ Cleaners caricati da API: {len(cleaners_list)}")
        return cleaners_list
    
    print(f"   ⚠️ Nessun cleaner trovato via API per {WORK_DATE}")
    return []


def load_containers_data() -> Dict:
    """Carica dati containers da API (unica fonte)."""
    global WORK_DATE
    
    if not API_AVAILABLE:
        raise RuntimeError("API client non disponibile - impossibile procedere")
    
    if not WORK_DATE:
        raise RuntimeError("WORK_DATE non impostata - impossibile procedere")
    
    client = ApiClient()
    data = client.get_containers(WORK_DATE)
    if data and data.get("containers"):
        print(f"   ✅ Containers caricati da API")
        return data
    
    print(f"   ⚠️ Nessun container trovato via API per {WORK_DATE}")
    return {"containers": {"early_out": {"tasks": []}, "high_priority": {"tasks": []}, "low_priority": {"tasks": []}}}


def load_timeline(work_date: str) -> Dict:
    """Carica timeline da API (unica fonte)."""
    empty_timeline = {
        "metadata": {"date": work_date, "last_updated": datetime.now().isoformat()},
        "cleaners_assignments": [],
        "meta": {"total_cleaners": 0, "used_cleaners": 0, "assigned_tasks": 0}
    }
    
    if not API_AVAILABLE:
        raise RuntimeError("API client non disponibile - impossibile procedere")
    
    try:
        client = ApiClient()
        data = client.get_timeline(work_date)
        if data and data.get("cleaners_assignments") is not None:
            if data.get("metadata", {}).get("date") != work_date:
                print(f"   ⚠️ Timeline data mismatch da API: Expected {work_date}, found {data.get('metadata', {}).get('date')}. Resetting.")
                return empty_timeline
            print(f"   ✅ Timeline caricata da API: {len(data.get('cleaners_assignments', []))} cleaners")
            return data
    except Exception as e:
        print(f"   ⚠️ Errore API timeline: {e}")
    
    return empty_timeline


def save_timeline_via_api(work_date: str, timeline_data: Dict) -> bool:
    """Salva timeline via API (unica destinazione)."""
    if not API_AVAILABLE:
        raise RuntimeError("API client non disponibile - impossibile salvare")
    
    try:
        client = ApiClient()
        client.save_timeline(work_date, timeline_data)
        print(f"   ✅ Timeline salvata via API per {work_date}")
        return True
    except Exception as e:
        print(f"   ❌ Errore salvataggio API timeline: {e}")
        raise


def save_containers_via_api(work_date: str, containers_data: Dict) -> bool:
    """Salva containers via API (unica destinazione)."""
    if not API_AVAILABLE:
        raise RuntimeError("API client non disponibile - impossibile salvare")
    
    try:
        client = ApiClient()
        client.save_containers(work_date, containers_data)
        print(f"   ✅ Containers salvati via API per {work_date}")
        return True
    except Exception as e:
        print(f"   ❌ Errore salvataggio API containers: {e}")
        raise


def get_assigned_logistic_codes_via_api(work_date: str) -> set:
    """Ottiene i logistic codes già assegnati dalla timeline via API."""
    if not API_AVAILABLE:
        raise RuntimeError("API client non disponibile - impossibile procedere")
    
    try:
        client = ApiClient()
        return client.get_assigned_logistic_codes(work_date)
    except Exception as e:
        print(f"   ⚠️ Errore lettura logistic codes da API: {e}")
        return set()


# -------- Loader --------
def load_cleaners() -> List[Cleaner]:
    data = load_cleaners_data()
    cleaners: List[Cleaner] = []
    for c in data:
        role = (c.get("role") or "").strip()
        is_premium = bool(c.get("premium", (role.lower() == "premium")))
        can_do_straordinaria = bool(c.get("can_do_straordinaria", False))

        if not can_cleaner_handle_priority(role, "low_priority"):
            print(f"   ⏭️  Cleaner {c.get('name')} ({role}) escluso da Low-Priority (priority_types settings)")
            continue

        cleaners.append(
            Cleaner(
                id=c.get("id"),
                name=c.get("name") or str(c.get("id")),
                lastname=c.get("lastname", ""),
                role=role or ("Premium" if is_premium else "Standard"),
                is_premium=is_premium,
                can_do_straordinaria=can_do_straordinaria,
            ))
    return cleaners


def seed_cleaners_from_assignments(cleaners: List[Cleaner], work_date: str):
    """
    Seed cleaners con informazioni da timeline via API (EO e HP assignments)
    Conta anche il totale task giornaliere per applicare il limite di 5
    """
    timeline_data = load_timeline(work_date)
    blocks = timeline_data.get("cleaners_assignments", [])

    for block in blocks:
        cid = int(block["cleaner"]["id"])
        tasks = block.get("tasks", [])
        if not tasks:
            continue

        all_sequences = [int(t.get("sequence", 0)) for t in tasks if t.get("sequence")]
        max_sequence = max(all_sequences) if all_sequences else 0

        all_tasks_sorted = sorted(tasks, key=lambda t: t.get("end_time") or "00:00")
        last = all_tasks_sorted[-1] if all_tasks_sorted else None

        if not last:
            continue

        end_time = hhmm_to_min(last.get("end_time"))
        last_addr = last.get("address")
        last_lat = last.get("lat")
        last_lng = last.get("lng")

        for cl in cleaners:
            if cl.id == cid:
                cl.available_from = end_time
                cl.last_address = last_addr
                cl.last_lat = float(last_lat) if last_lat is not None else None
                cl.last_lng = float(last_lng) if last_lng is not None else None
                cl.last_sequence = max_sequence
                cl.total_daily_tasks = len(tasks)
                break


def load_tasks() -> List[Task]:
    data = load_containers_data()
    tasks: List[Task] = []
    for t in data.get("containers", {}).get("low_priority", {}).get("tasks", []):
        checkin_dt = None
        checkout_dt = None

        checkin_date = t.get("checkin_date")
        checkin_time = t.get("checkin_time")
        if checkin_date and checkin_time:
            try:
                checkin_dt = datetime.strptime(f"{checkin_date} {checkin_time}", "%Y-%m-%d %H:%M")
            except:
                pass

        checkout_date = t.get("checkout_date")
        checkout_time = t.get("checkout_time")
        if checkout_date and checkout_time:
            try:
                checkout_dt = datetime.strptime(f"{checkout_date} {checkout_time}", "%Y-%m-%d %H:%M")
            except:
                pass

        tasks.append(
            Task(
                task_id=str(t.get("task_id")),
                logistic_code=str(t.get("logistic_code")),
                lat=float(t.get("lat")),
                lng=float(t.get("lng")),
                cleaning_time=int(t.get("cleaning_time") or 60),
                is_premium=bool(t.get("premium", False)),
                checkin_dt=checkin_dt,
                checkout_dt=checkout_dt,
                apt_type=t.get("type_apt"),
                address=t.get("address"),
                alias=t.get("alias"),
                small_equipment=bool(t.get("small_equipment", False)),
                straordinaria=bool(t.get("straordinaria", False)),
            ))

    tasks.sort(key=lambda x: (not x.straordinaria, not x.is_premium))
    return tasks


# -------- Planner --------
def plan_day(
    tasks: List[Task],
    cleaners: List[Cleaner],
    assigned_logistic_codes: set = None,
) -> Tuple[List[Cleaner], List[Task]]:
    if assigned_logistic_codes is None:
        assigned_logistic_codes = set()

    unassigned: List[Task] = []

    for task in tasks:
        if task.straordinaria:
            straordinaria_cleaners = [
                c for c in cleaners
                if c.can_do_straordinaria and can_cleaner_handle_apartment(c.role, task.apt_type)
            ]

            if not straordinaria_cleaners:
                unassigned.append(task)
                continue

            def get_earliest_time(c):
                if c.available_from is not None:
                    return c.available_from
                return 600

            earliest_cleaner = min(straordinaria_cleaners, key=get_earliest_time)

            result = find_best_position(earliest_cleaner, task)
            if result is None:
                unassigned.append(task)
                continue

            pos, _ = result
            earliest_cleaner.route.insert(pos, task)
            assigned_logistic_codes.add(task.logistic_code)
            continue

    for task in tasks:
        if task.logistic_code in assigned_logistic_codes:
            unassigned.append(task)
            continue

        candidates: List[Tuple[Cleaner, int, float]] = []

        for cleaner in cleaners:
            task_type = (
                "straordinario_apt"
                if task.straordinaria
                else ("premium_apt" if task.is_premium else "standard_apt")
            )
            if not can_cleaner_handle_task(cleaner.role, task_type, cleaner.can_do_straordinaria):
                continue

            if not can_cleaner_handle_apartment(cleaner.role, task.apt_type):
                continue

            if not can_add_lp_task(cleaner, cleaners):
                continue

            result = find_best_position(cleaner, task)
            if result is None:
                continue

            pos, travel = result
            candidates.append((cleaner, pos, travel))

        if not candidates:
            unassigned.append(task)
            continue

        min_travel = min(t_travel for (_, _, t_travel) in candidates)
        MAX_EXTRA_TRAVEL = 10

        candidates = [
            (c, p, t_travel)
            for (c, p, t_travel) in candidates
            if t_travel <= min_travel + MAX_EXTRA_TRAVEL
        ]

        if not candidates:
            unassigned.append(task)
            continue

        building_candidates: List[Tuple[Cleaner, int, float]] = []
        for c, p, t_travel in candidates:
            if c.route and any(
                same_building(ex.address, task.address) or is_nearby_same_block(ex, task)
                for ex in c.route
            ):
                building_candidates.append((c, p, t_travel))

        if building_candidates:
            pool = building_candidates
            effective_load_weight = max(LOAD_WEIGHT - 3, 1)
        else:
            loads_for_fairness: List[float] = []
            for (c, _, _) in candidates:
                role = getattr(c, "role", None)
                load_h = cleaner_load_hours(c)

                if role == "Formatore":
                    loads_for_fairness.append(load_h)
                else:
                    if load_h > 0.0:
                        loads_for_fairness.append(load_h)

            if loads_for_fairness:
                min_load_h = min(loads_for_fairness)
            else:
                min_load_h = 0.0

            fair_candidates: List[Tuple[Cleaner, int, float]] = []
            for (c, p, t_travel) in candidates:
                role = getattr(c, "role", None)
                load_h = cleaner_load_hours(c)

                if role == "Formatore":
                    fair_candidates.append((c, p, t_travel))
                    continue

                if load_h > 0.0 and load_h <= min_load_h + FAIRNESS_DELTA_HOURS:
                    fair_candidates.append((c, p, t_travel))

            pool = fair_candidates or candidates
            effective_load_weight = LOAD_WEIGHT

        low_load_candidates: List[Tuple[Cleaner, int, float]] = [
            (c, p, t_travel)
            for (c, p, t_travel) in pool
            if cleaner_load_minutes(c) < TARGET_MIN_LOAD_MIN
        ]
        if low_load_candidates:
            pool = low_load_candidates

        trainer_low_candidates: List[Tuple[Cleaner, int, float]] = [
            (c, p, t_travel)
            for (c, p, t_travel) in pool
            if getattr(c, "role", None) == "Formatore"
            and cleaner_load_minutes(c) < TRAINER_TARGET_MIN_LOAD_MIN
        ]

        if trainer_low_candidates:
            pool = trainer_low_candidates

        best_choice: Optional[Tuple[Cleaner, int, float]] = None
        best_score: Optional[float] = None

        for c, p, t_travel in pool:
            load_h = cleaner_load_hours(c)

            sb_bonus = 0
            if c.route and any(
                same_building(ex.address, task.address) or is_nearby_same_block(ex, task)
                for ex in c.route
            ):
                sb_bonus = SAME_BUILDING_BONUS

            if len(c.route) == 0:
                role = getattr(c, "role", None)
                if role == "Formatore":
                    activation_penalty = NEW_TRAINER_PENALTY_MIN
                else:
                    activation_penalty = NEW_CLEANER_PENALTY_MIN
            else:
                activation_penalty = 0

            role_bonus = 0
            if getattr(c, "role", None) == "Formatore":
                role_bonus = ROLE_TRAINER_BONUS

            score = (
                t_travel
                + effective_load_weight * load_h
                + sb_bonus
                + activation_penalty
                + role_bonus
            )

            if best_score is None or score < best_score:
                best_score = score
                best_choice = (c, p, t_travel)

        if best_choice is None:
            unassigned.append(task)
            continue

        cleaner, pos, travel = best_choice
        cleaner.route.insert(pos, task)
        assigned_logistic_codes.add(task.logistic_code)

    return cleaners, unassigned


def build_output(cleaners: List[Cleaner], unassigned: List[Task], original_tasks: List[Task], containers_data: Dict) -> Dict[str, Any]:
    cleaners_with_tasks: List[Dict[str, Any]] = []

    for cl in cleaners:
        if not cl.route:
            continue

        feasible, schedule = evaluate_route(cl, cl.route)
        if not feasible or not schedule:
            continue

        tasks_list: List[Dict[str, Any]] = []

        for idx, (t, (arr, start, fin)) in enumerate(zip(cl.route, schedule)):
            overall_seq = cl.last_sequence + idx + 1

            if overall_seq == 1:
                travel_time = 0
            elif idx == 0 and cl.last_sequence >= 1:
                if cl.last_lat is not None and cl.last_lng is not None:
                    hop = travel_minutes(cl.last_lat, cl.last_lng, t.lat, t.lng,
                                       cl.last_address, t.address)
                    travel_time = int(round(hop))
                else:
                    travel_time = 0 if same_street(cl.last_address, t.address) else 12
            else:
                prev = cl.route[idx - 1]
                hop = travel_minutes(prev.lat, prev.lng, t.lat, t.lng, prev.address, t.address)
                travel_time = int(round(hop))

            logistic_code_val = 0
            if t.logistic_code and str(t.logistic_code).lower() != 'none':
                try:
                    logistic_code_val = int(t.logistic_code)
                except (ValueError, TypeError):
                    logistic_code_val = 0

            start_time_str = min_to_hhmm(start)
            end_time_str = min_to_hhmm(fin)
            current_seq = overall_seq

            original_task_data = None

            for container_type in ['early_out', 'high_priority', 'low_priority']:
                container = containers_data.get('containers', {}).get(container_type, {})
                for task in container.get('tasks', []):
                    if str(task.get('task_id')) == str(t.task_id) or str(task.get('logistic_code')) == str(t.logistic_code):
                        original_task_data = task
                        break
                if original_task_data:
                    break

            if not original_task_data:
                original_task_data = {
                    "task_id": str(t.task_id) if t.task_id else "0",
                    "logistic_code": logistic_code_val,
                    "address": t.address,
                    "lat": t.lat,
                    "lng": t.lng,
                    "cleaning_time": t.cleaning_time,
                }

            task_for_timeline = {
                **original_task_data,
                "priority": "low_priority",
                "start_time": start_time_str,
                "end_time": end_time_str,
                "followup": idx > 0,
                "sequence": overall_seq,
                "travel_time": travel_time,
                "straordinaria": bool(original_task_data.get("straordinaria", False)),
                "premium": bool(original_task_data.get("premium", False)),
                "reasons": [
                    *(original_task_data.get("reasons", [])),
                    "automatic_assignment_lp"
                ]
            }

            tasks_list.append(task_for_timeline)


        cleaners_with_tasks.append({
            "cleaner": {
                "id": cl.id,
                "name": cl.name,
                "lastname": cl.lastname,
                "role": cl.role,
                "premium": cl.is_premium
            },
            "tasks": tasks_list
        })

    assigned_task_ids = set()
    for entry in cleaners_with_tasks:
        for t in entry.get("tasks", []):
            assigned_task_ids.add(int(t["task_id"]))

    unassigned_list: List[Dict[str, Any]] = []
    for ot in original_tasks:
        tid = 0
        lc = 0
        if ot.task_id:
            try:
                tid = int(ot.task_id)
            except (ValueError, TypeError):
                tid = 0
        if ot.logistic_code and str(ot.logistic_code).lower() != 'none':
            try:
                lc = int(ot.logistic_code)
            except (ValueError, TypeError):
                lc = 0
        if tid not in assigned_task_ids:
            unassigned_list.append({
                "task_id": tid,
                "logistic_code": lc,
                "reason": "no_eligible_cleaner_or_time_window"
            })

    total_assigned = sum(len(c["tasks"]) for c in cleaners_with_tasks)

    current_ref_date = WORK_DATE or datetime.now().strftime("%Y-%m-%d")

    return {
        "low_priority_tasks_assigned": cleaners_with_tasks,
        "unassigned_tasks": unassigned_list,
        "current_date": current_ref_date,
        "meta": {
            "total_tasks": len(original_tasks),
            "assigned": total_assigned,
            "unassigned": len(original_tasks) - total_assigned,
            "cleaners_used": len(cleaners_with_tasks),
            "max_tasks_per_cleaner": ABSOLUTE_MAX_TASKS,
            "algorithm": "simplified_greedy",
            "notes": [
                "REGOLE LOW PRIORITY OTTIMIZZATE:",
                "1. LIMITE LP DINAMICO: distribuzione equa tra cleaner",
                "2. LIMITE GIORNALIERO: Max 5 task totali (EO+HP+LP), preferibilmente 4",
                "3. RIMOSSO vincolo minimo 2 task: ora accetta anche 1 sola task LP",
                "4. Considera task EO e HP precedenti per calcolare il totale",
                "5. Favorisce cleaners con meno task totali",
                "6. Straordinarie solo a premium cleaner, devono essere la prima task",
                "7. Premium task solo a premium cleaner",
                "8. Check-in strict: deve finire prima del check-in time (INFRANGIBILE)",
                "9. Vincolo orario: nessuna task deve finire dopo le 19:00",
                "10. Seed da EO e HP: disponibilità e posizione dall'ultima task",
                "11. FORMATORE: solo task type_apt A o B, MINIMO 3 task LP",
                "12. CROSS-CONTAINER: Favorisce vicinanza con task EO e HP già assegnate"
            ]
        }
    }


def main():
    global USE_API, WORK_DATE
    
    parser = argparse.ArgumentParser(description='Assegna task Low-Priority ai cleaners')
    parser.add_argument('date', nargs='?', default=None, help='Data nel formato YYYY-MM-DD')
    parser.add_argument('--use-api', action='store_true', help='Usa API HTTP invece di file JSON (REQUIRED)')
    parser.add_argument('--date', dest='date_opt', type=str, help='Data nel formato YYYY-MM-DD')
    args = parser.parse_args()
    
    ref_date = args.date_opt or args.date or datetime.now().strftime("%Y-%m-%d")
    
    USE_API = args.use_api
    WORK_DATE = ref_date
    
    if not USE_API:
        raise SystemExit("❌ --use-api è obbligatorio. Questo script funziona solo in modalità API.")
    
    if not API_AVAILABLE:
        raise SystemExit("❌ API client non disponibile - impossibile procedere")
    
    print(f"🌐 Modalità API attiva (PostgreSQL)")
    print(f"📅 Data di lavoro: {ref_date}")

    cleaners = load_cleaners()
    seed_cleaners_from_assignments(cleaners, ref_date)
    tasks = load_tasks()
    
    containers_data = load_containers_data()

    print(f"📋 Caricamento dati...")
    print(f"   - Cleaner disponibili: {len(cleaners)}")
    print(f"   - Task Low-Priority da assegnare: {len(tasks)}")

    assigned_logistic_codes = get_assigned_logistic_codes_via_api(ref_date)
    if assigned_logistic_codes:
        print(f"📌 Logistic codes già assegnati in timeline: {len(assigned_logistic_codes)}")

    print()
    print(f"🔄 Assegnazione in corso...")

    planners, leftovers = plan_day(tasks, cleaners, assigned_logistic_codes)
    output = build_output(planners, leftovers, tasks, containers_data)

    print()
    print(f"✅ Assegnazione completata!")
    print(f"   - Task assegnati: {output['meta']['assigned']}/{output['meta']['total_tasks']}")
    print(f"   - Cleaner utilizzati: {output['meta']['cleaners_used']}")
    print(f"   - Task non assegnati: {output['meta']['unassigned']}")
    print()

    from datetime import datetime as dt

    timeline_data = load_timeline(ref_date)

    seen_cleaner_ids = {}
    merged_assignments = []

    for entry in timeline_data.get("cleaners_assignments", []):
        cleaner_id = entry.get("cleaner", {}).get("id")
        if cleaner_id is None:
            continue

        if cleaner_id in seen_cleaner_ids:
            existing_entry = seen_cleaner_ids[cleaner_id]
            existing_task_ids = {t.get("task_id") for t in existing_entry["tasks"]}
            new_tasks = [t for t in entry.get("tasks", []) if t.get("task_id") not in existing_task_ids]
            existing_entry["tasks"].extend(new_tasks)
            print(f"   🔧 Merged duplicato cleaner ID {cleaner_id}: +{len(new_tasks)} task")
        else:
            seen_cleaner_ids[cleaner_id] = entry
            merged_assignments.append(entry)

    if len(merged_assignments) < len(timeline_data.get("cleaners_assignments", [])):
        print(f"   ✅ Rimossi {len(timeline_data.get('cleaners_assignments', [])) - len(merged_assignments)} cleaner duplicati")
        timeline_data["cleaners_assignments"] = merged_assignments

    for cleaner_entry in output["low_priority_tasks_assigned"]:
        existing_entry = None
        for entry in timeline_data["cleaners_assignments"]:
            if entry.get("cleaner", {}).get("id") == cleaner_entry["cleaner"]["id"]:
                existing_entry = entry
                break

        if existing_entry:
            existing_task_ids = {t.get("task_id") for t in existing_entry["tasks"]}
            new_tasks = [t for t in cleaner_entry["tasks"] if t.get("task_id") not in existing_task_ids]
            if len(new_tasks) < len(cleaner_entry["tasks"]):
                skipped = len(cleaner_entry["tasks"]) - len(new_tasks)
                print(f"   ⚠️ Skipped {skipped} task duplicate per cleaner {cleaner_entry['cleaner']['name']}")
            existing_entry["tasks"].extend(new_tasks)
            existing_entry["tasks"].sort(key=lambda t: t.get("start_time", "00:00"))
        else:
            timeline_data["cleaners_assignments"].append({
                "cleaner": cleaner_entry["cleaner"],
                "tasks": cleaner_entry["tasks"]
            })

    from recalculate_times import recalculate_cleaner_times
    
    for entry in timeline_data["cleaners_assignments"]:
        tasks_list = entry.get("tasks", [])
        if len(tasks_list) > 1:
            tasks_list.sort(key=lambda t: t.get("start_time") or "00:00")
            updated_entry = recalculate_cleaner_times(entry)
            entry["tasks"] = updated_entry["tasks"]

    total_available_cleaners = len(cleaners)

    used_cleaners = len([c for c in timeline_data["cleaners_assignments"] if len(c.get("tasks", [])) > 0])

    timeline_data["metadata"]["last_updated"] = datetime.now().isoformat()
    timeline_data["metadata"]["date"] = ref_date
    timeline_data["metadata"]["modification_type"] = "auto_assign_low_priority"
    timeline_data["meta"]["total_cleaners"] = total_available_cleaners
    timeline_data["meta"]["used_cleaners"] = used_cleaners
    timeline_data["meta"]["assigned_tasks"] = sum(
        len(c.get("tasks", [])) for c in timeline_data["cleaners_assignments"]
    )

    save_timeline_via_api(ref_date, timeline_data)

    lp_count = sum(1 for c in timeline_data["cleaners_assignments"]
                   if any(t.get("reasons") and "automatic_assignment_lp" in t.get("reasons", []) for t in c.get("tasks", [])))
    print(f"✅ Timeline aggiornata via API")
    print(f"   - Cleaner con assegnazioni LP: {lp_count}")
    print(f"   - Totale task: {timeline_data['meta']['assigned_tasks']}")

    try:
        client = ApiClient()
        containers_data = client.get_containers(ref_date)
        
        if not containers_data or "containers" not in containers_data:
            print(f"⚠️ Nessun container trovato via API per {ref_date}")
        else:
            assigned_task_ids = set()
            for cleaner_entry in output["low_priority_tasks_assigned"]:
                for task in cleaner_entry.get("tasks", []):
                    assigned_task_ids.add(int(task["task_id"]))

            if "low_priority" in containers_data["containers"]:
                original_count = len(containers_data["containers"]["low_priority"].get("tasks", []))
                containers_data["containers"]["low_priority"]["tasks"] = [
                    t for t in containers_data["containers"]["low_priority"].get("tasks", [])
                    if int(t.get("task_id", 0)) not in assigned_task_ids
                ]
                new_count = len(containers_data["containers"]["low_priority"]["tasks"])
                containers_data["containers"]["low_priority"]["count"] = new_count

                if "summary" in containers_data:
                    containers_data["summary"]["low_priority"] = new_count
                    containers_data["summary"]["total_tasks"] = (
                        containers_data["summary"].get("total_tasks", 0) - (original_count - new_count)
                    )

                save_containers_via_api(ref_date, containers_data)
                print(f"✅ Rimosse {original_count - new_count} task da containers (low_priority) via API")
                print(f"   - Task rimaste in low_priority: {new_count}")
                print(f"   💡 Task con logistic_code duplicati rimangono disponibili nei container")
    except Exception as e:
        print(f"⚠️ Errore durante la rimozione delle task dai containers: {e}")


if __name__ == "__main__":
    main()
