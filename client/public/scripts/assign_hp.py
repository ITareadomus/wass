# -*- coding: utf-8 -*-
from __future__ import annotations
import json, math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path
from datetime import datetime, timedelta
from task_validation import can_cleaner_handle_task, can_cleaner_handle_apartment, can_cleaner_handle_priority
from assign_utils import (
    NEARBY_TRAVEL_THRESHOLD, NEW_CLEANER_PENALTY_MIN, NEW_TRAINER_PENALTY_MIN,
    TARGET_MIN_LOAD_MIN, FAIRNESS_DELTA_HOURS, LOAD_WEIGHT,
    SAME_BUILDING_BONUS, ROLE_TRAINER_BONUS,
    cleaner_load_minutes, cleaner_load_hours
)

# =============================
# I/O paths
# =============================
BASE = Path(__file__).parent.parent / "data"

INPUT_TASKS = BASE / "output" / "high_priority.json"
INPUT_CONTAINERS = BASE / "output" / "containers.json"
INPUT_CLEANERS = BASE / "cleaners" / "selected_cleaners.json"
INPUT_EO_ASSIGN = BASE / "output" / "early_out_assignments.json"
OUTPUT_ASSIGN = BASE / "output" / "high_priority_assignments.json"

# =============================
# CONFIG - REGOLE CLUSTERING OTTIMIZZATE
CLUSTER_PRIORITY_TRAVEL = 5.0
CLUSTER_EXTENDED_TRAVEL = 10.0
CLUSTER_MAX_TRAVEL = 15.0
ZONE_RADIUS_KM = 0.25  # ~250m, micro-zona
# =============================
BASE_MAX_TASKS = 2  # Base: max 2 task per cleaner
# CLUSTER_PRIORITY_TRAVEL = 5.0  # Cluster prioritario: <= 5' (massima priorità)
# CLUSTER_EXTENDED_TRAVEL = 10.0  # Cluster esteso: <= 10' (infrange limiti tipologia)
ABSOLUTE_MAX_TASKS = 4  # Max assoluto 4 task
ABSOLUTE_MAX_TASKS_IF_BEFORE_18 = 5  # Max 5 task se finisce entro le 18:00
DAILY_TASK_LIMIT = 5  # Limite giornaliero HARD

PREFERRED_TRAVEL = 20.0  # Preferenza per percorsi < 20'
# CLUSTER_MAX_TRAVEL = 15.0  # Cluster: <= 15' (per controllo vicinanza task)

# NUOVO: Limite per tipologia FLESSIBILE (può essere infranto da cluster)
MAX_TASKS_PER_PRIORITY = 2  # Max 2 task High-Priority per cleaner (base, infrangibile da cluster vicini)

HP_HARD_EARLIEST_H = 11
HP_HARD_EARLIEST_M = 0

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
    checkout_dt: Optional[datetime]
    checkin_dt: Optional[datetime]
    is_premium: bool
    apt_type: Optional[str] = None
    address: Optional[str] = None
    alias: Optional[str] = None
    small_equipment: bool = False
    straordinaria: bool = False
    is_hp_soft: bool = False


@dataclass
class Cleaner:
    id: Any
    name: str
    lastname: str
    role: str
    is_premium: bool
    start_time: datetime
    can_do_straordinaria: bool = False
    available_from: Optional[datetime] = None
    last_eo_address: Optional[str] = None
    last_eo_lat: Optional[float] = None
    last_eo_lng: Optional[float] = None
    eo_last_sequence: int = 0
    route: List[Task] = field(default_factory=list)


# -------- Utils --------
def parse_dt(d: Optional[str], t: Optional[str]) -> Optional[datetime]:
    if not d or not t:
        return None
    try:
        return datetime.strptime(f"{d} {t}", "%Y-%m-%d %H:%M")
    except Exception:
        return None


def hhmm_to_dt(ref_date: str, hhmm: str) -> datetime:
    return datetime.strptime(f"{ref_date} {hhmm}", "%Y-%m-%d %H:%M")


def fmt_hhmm(dt: datetime) -> str:
    return dt.strftime("%H:%M")


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
    """
    Due task sono nella stessa 'zona' se:
    - stesso edificio, oppure
    - stessa via, oppure
    - distanza geografica <= ZONE_RADIUS_KM
    """
    # stesso edificio o stessa via = stessa zona
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
    """
    Ritorna True se t1 e t2 sono:
    - nello stesso edificio/via (same_building)
    OPPURE
    - dello stesso cliente/alias e la distanza di viaggio è <= NEARBY_TRAVEL_THRESHOLD.
    """
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
    """
    Modello realistico Milano urbano:
    - Percorsi non rettilinei (1.5x haversine)
    - Velocità variabile per distanza
    - Tempo base preparazione
    """
    # Stesso edificio: 3 minuti per cambio appartamento
    # (raccolta attrezzature, scale/ascensore, spostamento)
    if a_addr and b_addr and same_building(a_addr, b_addr):
        return 3.0

    km = haversine_km(a_lat, a_lng, b_lat, b_lng)

    # Fattore correzione percorsi non rettilinei
    dist_reale = km * 1.5

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

    # Bonus stesso strada (riduce tempo base)
    if a_addr and b_addr and same_street(a_addr, b_addr) and km < 0.10:
        total_time = max(total_time - 2.0, MIN_TRAVEL)

    return max(MIN_TRAVEL, min(MAX_TRAVEL, total_time))


def can_handle_premium(cleaner: Cleaner, task: Task) -> bool:
    if task.is_premium and not cleaner.is_premium:
        return False
    # Straordinaria requires cleaner with can_do_straordinaria=True
    if task.straordinaria and not cleaner.can_do_straordinaria:
        return False
    return True


# -------- Schedulazione / costo --------
def evaluate_route(cleaner: Cleaner, route: List[Task]) -> Tuple[bool, List[Tuple[datetime, datetime, datetime]]]:
    """
    Valuta se una route è fattibile per un cleaner HP.
    Ritorna: (is_feasible, schedule)
    schedule = [(arrival, start, finish), ...]
    """
    if not route:
        return True, []

    schedule: List[Tuple[datetime, datetime, datetime]] = []

    # Primo task HP
    first = route[0]

    # Calcola l'orario base da cui il cleaner può partire
    base = cleaner.start_time
    if cleaner.available_from:
        base = max(base, cleaner.available_from)

    # Viaggio da EO a HP (solo se ha avuto task EO precedenti)
    if cleaner.last_eo_lat is not None and cleaner.last_eo_lng is not None:
        tt = travel_minutes(cleaner.last_eo_lat, cleaner.last_eo_lng,
                          first.lat, first.lng,
                          cleaner.last_eo_address, first.address)
        arrival = base + timedelta(minutes=tt)
    else:
        # Nessuna task EO precedente: il cleaner può iniziare dal suo start_time
        arrival = base

    # Orario massimo di fine task: 19:00
    max_end_time = datetime(arrival.year, arrival.month, arrival.day, 19, 0)

    # LOGICA STRAORDINARIE vs HP NORMALE:
    # - STRAORDINARIE: ignora TUTTI i vincoli orari di default, rispetta SOLO:
    #   1. checkout_dt dell'appartamento
    #   2. start_time del cleaner (già in 'base')
    #   Lo start_time è il MASSIMO tra arrivo cleaner e checkout appartamento
    # 
    # - HP NORMALE: applica vincolo HP hard earliest (11:00) se necessario
    
    if first.straordinaria:
        # STRAORDINARIE: nessun vincolo orario di default
        # arrival = max(base, checkout_dt se presente)
        if first.checkout_dt:
            arrival = max(arrival, first.checkout_dt)
        # else: arrival rimane = base (start_time cleaner + travel se presente)
    else:
        # HP NORMALE: applica logica con HP hard earliest
        hp_hard_earliest = datetime(arrival.year, arrival.month, arrival.day, HP_HARD_EARLIEST_H, HP_HARD_EARLIEST_M)
        
        if first.checkout_dt:
            # Rispetta il checkout, ma può iniziare prima delle 11:00 se libero
            arrival = max(arrival, first.checkout_dt)
        else:
            # Nessun checkout: applica vincolo HP hard earliest solo se non è libero prima
            if arrival < hp_hard_earliest:
                # Cleaner libero prima delle 11:00: può iniziare subito
                arrival = arrival
            else:
                # Cleaner non libero prima delle 11:00: applica vincolo
                arrival = max(arrival, hp_hard_earliest)

    start = arrival
    finish = start + timedelta(minutes=first.cleaning_time)

    # Check-in strict - INFRANGIBILE
    # SOLO se il check-in è OGGI (stesso giorno del checkout)
    if first.checkin_dt and first.checkout_dt:
        same_day = first.checkin_dt.date() == first.checkout_dt.date()
        if same_day and finish > first.checkin_dt:
            return False, []
    elif first.checkin_dt:
        # Fallback: se non c'è checkout_dt, assume stesso giorno
        if finish > first.checkin_dt:
            return False, []

    # Vincolo orario: nessuna task deve finire dopo le 19:00
    if finish > max_end_time:
        return False, []

    schedule.append((arrival, start, finish))
    prev = first
    cur = finish

    # Task successive
    for i in range(1, len(route)):
        t = route[i]
        tt = travel_minutes(prev.lat, prev.lng, t.lat, t.lng, prev.address, t.address)
        cur += timedelta(minutes=tt)
        arrival = cur

        # Considera checkout se presente
        wait = timedelta(0)
        if t.checkout_dt and arrival < t.checkout_dt:
            wait = t.checkout_dt - arrival
            cur += wait

        start = cur
        finish = start + timedelta(minutes=t.cleaning_time)

        # Check-in strict - INFRANGIBILE
        # SOLO se il check-in è OGGI (stesso giorno del checkout)
        if t.checkin_dt and t.checkout_dt:
            same_day = t.checkin_dt.date() == t.checkout_dt.date()
            if same_day and finish > t.checkin_dt:
                return False, []
        elif t.checkin_dt:
            # Fallback: se non c'è checkout_dt, assume stesso giorno
            if finish > t.checkin_dt:
                return False, []

        # Vincolo orario: nessuna task deve finire dopo le 19:00
        if finish > max_end_time:
            return False, []

        schedule.append((arrival, start, finish))
        prev = t
        cur = finish

    return True, schedule


def can_add_task(cleaner: Cleaner, task: Task) -> bool:
    """
    Verifica se è possibile aggiungere una task al cleaner secondo le regole:
    1. Premium task -> premium cleaner
    2. Straordinaria -> premium cleaner, deve essere la prima (pos=0)
    3. CLUSTERING: appartamenti vicini (≤10') possono infrangere limite tipologia
    4. Stessa via o ≤5': massima priorità cluster
    5. Limite giornaliero: max 5 task totali (EO+HP+LP)
    """
    if not can_handle_premium(cleaner, task):
        return False
    # NUOVO: Verifica compatibilità tipo appartamento
    if not can_cleaner_handle_apartment(cleaner.role, task.apt_type):
        return False

    current_count = len(cleaner.route)

    # Calcola totale task giornaliere (EO già fatte + HP in route)
    total_daily = cleaner.eo_last_sequence + current_count

    # Limite giornaliero HARD: max 5 task
    if total_daily >= DAILY_TASK_LIMIT:
        return False

    # Straordinaria deve andare per forza in pos 0
    if task.straordinaria:
        if current_count > 0:
            return False

    # Se il cleaner ha già una straordinaria, non può aggiungerne altre
    if current_count > 0 and cleaner.route[0].straordinaria:
        if task.straordinaria:
            return False

    # CLUSTERING AVANZATO: controlla vicinanza con task esistenti
    if current_count > 0:
        # Cluster prioritario: ≤5' o stessa via
        is_priority_cluster = any(
            (travel_minutes(existing_task.lat, existing_task.lng, task.lat, task.lng,
                          existing_task.address, task.address) <= CLUSTER_PRIORITY_TRAVEL or
             travel_minutes(task.lat, task.lng, existing_task.lat, existing_task.lng,
                          task.address, existing_task.address) <= CLUSTER_PRIORITY_TRAVEL or
             same_street(existing_task.address, task.address))
            for existing_task in cleaner.route
        )

        # Cluster esteso: ≤10' (infrange limite tipologia)
        is_extended_cluster = any(
            (travel_minutes(existing_task.lat, existing_task.lng, task.lat, task.lng,
                          existing_task.address, task.address) <= CLUSTER_EXTENDED_TRAVEL or
             travel_minutes(task.lat, task.lng, existing_task.lat, existing_task.lng,
                          task.address, existing_task.address) <= CLUSTER_EXTENDED_TRAVEL)
            for existing_task in cleaner.route
        )

        # Se è in cluster prioritario: ignora limiti tipologia, rispetta SEMPRE limite giornaliero
        if is_priority_cluster:
            # Verifica limite giornaliero HARD (EO + HP già fatte + questa task)
            if total_daily >= DAILY_TASK_LIMIT:
                return False
            # Verifica max assoluto HP
            if current_count >= ABSOLUTE_MAX_TASKS:
                return False
            return True

        # Se è in cluster esteso: ignora limite tipologia, rispetta limiti giornaliero e max assoluto
        if is_extended_cluster:
            # Verifica limite giornaliero HARD
            if total_daily >= DAILY_TASK_LIMIT:
                return False
            # Verifica max assoluto HP
            if current_count >= ABSOLUTE_MAX_TASKS:
                return False
            return True

    # Regola base: max 2 task
    if current_count < BASE_MAX_TASKS:
        return True

    # 3ª-5ª task: solo se fattibile temporalmente
    if current_count >= BASE_MAX_TASKS and current_count < ABSOLUTE_MAX_TASKS:
        test_route = cleaner.route + [task]
        feasible, schedule = evaluate_route(cleaner, test_route)
        if feasible and schedule:
            last_finish = schedule[-1][2]  # finish datetime
            if current_count < ABSOLUTE_MAX_TASKS_IF_BEFORE_18 and last_finish.hour < 18:
                return True
            elif current_count < ABSOLUTE_MAX_TASKS:
                return True

    return False


def find_best_position(cleaner: Cleaner, task: Task) -> Optional[Tuple[int, float]]:
    """
    Trova la migliore posizione per inserire la task.
    Ritorna: (position, travel_time) oppure None se non fattibile

    Regola: favorisce percorsi < 15', altrimenti sceglie il minore dei > 15'
    """
    if not can_add_task(cleaner, task):
        return None

    best_pos = None
    best_travel = float('inf')

    # Straordinaria deve andare per forza in pos 0
    if task.straordinaria:
        test_route = [task] + cleaner.route
        feasible, _ = evaluate_route(cleaner, test_route)
        if feasible:
            return (0, 0.0)
        else:
            return None

    # Prova tutte le posizioni possibili
    for pos in range(len(cleaner.route) + 1):
        test_route = cleaner.route[:pos] + [task] + cleaner.route[pos:]
        feasible, _ = evaluate_route(cleaner, test_route)

        if not feasible:
            continue

        # Calcola il tempo di viaggio max generato da questo inserimento
        if pos == 0:
            # Prima task HP: calcola viaggio da EO a HP
            if cleaner.last_eo_lat is not None and cleaner.last_eo_lng is not None:
                travel_to = travel_minutes(cleaner.last_eo_lat, cleaner.last_eo_lng,
                                         task.lat, task.lng,
                                         cleaner.last_eo_address, task.address)
            else:
                travel_to = 3.0 if same_street(cleaner.last_eo_address, task.address) else 12.0

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

        # Scegli la posizione con minor viaggio
        if max_travel < best_travel:
            best_travel = max_travel
            best_pos = pos

    if best_pos is not None:
        return (best_pos, best_travel)

    return None


# -------- Loader --------
def load_cleaners(ref_date: str) -> List[Cleaner]:
    data = json.loads(INPUT_CLEANERS.read_text(encoding="utf-8"))
    cleaners: List[Cleaner] = []
    for c in data.get("cleaners", []):
        role = (c.get("role") or "").strip()
        is_premium = bool(c.get("premium", (role.lower() == "premium")))
        can_do_straordinaria = bool(c.get("can_do_straordinaria", False))

        # NUOVO: Valida se il cleaner può gestire High-Priority basandosi su settings.json
        if not can_cleaner_handle_priority(role, "high_priority"):
            print(f"   ⏭️  Cleaner {c.get('name')} ({role}) escluso da High-Priority (priority_types settings)")
            continue

        st = (c.get("start_time") or "10:00")
        try:
            h, m = [int(x) for x in st.split(":")]
        except Exception:
            h, m = 10, 0
        start_dt = datetime.strptime(f"{ref_date} {h:02d}:{m:02d}", "%Y-%m-%d %H:%M")

        cleaners.append(
            Cleaner(
                id=c.get("id"),
                name=c.get("name") or str(c.get("id")),
                lastname=c.get("lastname", ""),
                role=role or ("Premium" if is_premium else "Standard"),
                is_premium=is_premium,
                can_do_straordinaria=can_do_straordinaria,
                start_time=start_dt,
            ))
    return cleaners


def seed_cleaners_from_eo(cleaners: List[Cleaner], ref_date: str):
    # Leggi dalla timeline.json invece che da early_out_assignments.json
    timeline_path = OUTPUT_ASSIGN.parent / "timeline.json"
    if not timeline_path.exists():
        # Fallback: prova con il file EO assignments
        if not INPUT_EO_ASSIGN.exists():
            return
        data = json.loads(INPUT_EO_ASSIGN.read_text(encoding="utf-8"))
        blocks = data.get("early_out_tasks_assigned", [])
    else:
        # Leggi dalla timeline.json
        timeline_data = json.loads(timeline_path.read_text(encoding="utf-8"))
        blocks = timeline_data.get("cleaners_assignments", [])

    for block in blocks:
        cid = int(block["cleaner"]["id"])
        tasks = block.get("tasks", [])
        if not tasks:
            continue

        # Filtra solo task EO (con priority="early_out" o reasons che include "automatic_assignment_eo")
        eo_tasks = [t for t in tasks if
                    t.get("priority") == "early_out" or
                    ("automatic_assignment_eo" in t.get("reasons", []))]

        if not eo_tasks:
            continue

        # Ordina per end_time per trovare l'ultima
        eo_tasks.sort(key=lambda t: t.get("end_time", "00:00"))
        last = eo_tasks[-1]

        end_time = last.get("end_time")  # "HH:MM"
        last_addr = last.get("address")
        last_lat = last.get("lat")
        last_lng = last.get("lng")
        last_seq = last.get("sequence") or len(eo_tasks)
        for cl in cleaners:
            if cl.id == cid:
                cl.available_from = hhmm_to_dt(ref_date, end_time)
                cl.last_eo_address = last_addr
                cl.last_eo_lat = float(last_lat) if last_lat is not None else None
                cl.last_eo_lng = float(last_lng) if last_lng is not None else None
                cl.eo_last_sequence = int(last_seq)
                break


def load_tasks() -> Tuple[List[Task], str]:
    data = json.loads(INPUT_CONTAINERS.read_text(encoding="utf-8"))
    tasks: List[Task] = []
    for t in data.get("containers", {}).get("high_priority", {}).get("tasks", []):
        checkout_dt = parse_dt(t.get("checkout_date"), t.get("checkout_time"))
        checkin_dt = parse_dt(t.get("checkin_date"), t.get("checkin_time"))
        is_hp_soft = (checkin_dt is None and checkout_dt is None)

        tasks.append(
            Task(
                task_id=str(t.get("task_id")),
                logistic_code=str(t.get("logistic_code")),
                lat=float(t.get("lat")),
                lng=float(t.get("lng")),
                cleaning_time=int(t.get("cleaning_time") or 60),
                checkout_dt=checkout_dt,
                checkin_dt=checkin_dt,
                is_premium=bool(t.get("premium", False)),
                apt_type=t.get("type_apt"),
                address=t.get("address"),
                alias=t.get("alias"),
                small_equipment=bool(t.get("small_equipment", False)),
                straordinaria=bool(t.get("straordinaria", False)),
                is_hp_soft=is_hp_soft,
            ))

    # Determina ref_date dal primo task
    ref_date = None
    for t in tasks: # Iterate over the loaded tasks
        ref = t.checkin_dt or t.checkout_dt
        if ref:
            ref_date = ref.strftime("%Y-%m-%d")
            break

    if ref_date is None:
        ref_date = datetime.now().strftime("%Y-%m-%d")

    return tasks, ref_date


# -------- Planner --------
def plan_day(
    tasks: List[Task],
    cleaners: List[Cleaner],
    assigned_logistic_codes: set = None,
) -> Tuple[List[Cleaner], List[Task]]:
    """
    Assegna le task High-Priority con:
    - STRAORDINARIE: possono iniziare prima delle 11:00, assegnate al cleaner
      con start_time minore che ha can_do_straordinaria=True
    - HARD CLUSTER edificio/via o "stesso blocco" (same_building + is_nearby_same_block)
    - FAIRNESS: evita che un cleaner abbia molte più task degli altri,
      ignorando i cleaner vuoti
    - TARGET MINIMO 3 TASK: se possibile, favorisce cleaner con 1–2 task.

    Usa:
      - find_best_position(cleaner, task)
    """

    if assigned_logistic_codes is None:
        assigned_logistic_codes = set()

    unassigned: List[Task] = []

    for task in tasks:
        # STRAORDINARIE: logica dedicata
        if task.straordinaria:
            # Filtra solo cleaner che possono fare straordinarie
            straordinaria_cleaners = [
                c for c in cleaners
                if c.can_do_straordinaria and can_cleaner_handle_apartment(c.role, task.apt_type)
            ]
            
            if not straordinaria_cleaners:
                unassigned.append(task)
                continue
            
            # Trova cleaner con start_time minore (datetime)
            earliest_cleaner = min(straordinaria_cleaners, key=lambda c: c.start_time)
            
            # Verifica se può prendere la task (pos 0)
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
            # Validazione tipo di task (premium / straordinaria / standard)
            task_type = (
                "straordinario_apt"
                if task.straordinaria
                else ("premium_apt" if task.is_premium else "standard_apt")
            )
            if not can_cleaner_handle_task(cleaner.role, task_type, cleaner.can_do_straordinaria):
                continue

            # Validazione tipo appartamento
            if not can_cleaner_handle_apartment(cleaner.role, task.apt_type):
                continue

            result = find_best_position(cleaner, task)
            if result is None:
                continue

            pos, travel = result
            candidates.append((cleaner, pos, travel))

        if not candidates:
            unassigned.append(task)
            continue

        # 🔪 TAGLIA candidati con travel troppo alto rispetto al minimo
        min_travel = min(t_travel for (_, _, t_travel) in candidates)
        MAX_EXTRA_TRAVEL = 10  # minuti oltre il minimo consentiti

        candidates = [
            (c, p, t_travel)
            for (c, p, t_travel) in candidates
            if t_travel <= min_travel + MAX_EXTRA_TRAVEL
        ]

        if not candidates:
            unassigned.append(task)
            continue

        # HARD CLUSTER edificio/via/blocco
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
            # FAIRNESS basata sulle ore, ignora cleaner vuoti
            loads_for_fairness: List[float] = []
            for (c, _, _) in candidates:
                load_h = cleaner_load_hours(c)
                if load_h > 0.0:
                    loads_for_fairness.append(load_h)

            if loads_for_fairness:
                min_load_h = min(loads_for_fairness)
            else:
                min_load_h = 0.0

            fair_candidates: List[Tuple[Cleaner, int, float]] = []
            for (c, p, t_travel) in candidates:
                load_h = cleaner_load_hours(c)
                if load_h > 0.0 and load_h <= min_load_h + FAIRNESS_DELTA_HOURS:
                    fair_candidates.append((c, p, t_travel))

            pool = fair_candidates or candidates
            effective_load_weight = LOAD_WEIGHT

        # TARGET MINIMO DI CARICO (≈ 3 ore)
        low_load_candidates: List[Tuple[Cleaner, int, float]] = [
            (c, p, t_travel)
            for (c, p, t_travel) in pool
            if cleaner_load_minutes(c) < TARGET_MIN_LOAD_MIN
        ]
        if low_load_candidates:
            pool = low_load_candidates

        # Scoring finale con ore + penalità attivazione
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

            # penalità di attivazione per cleaner vuoti
            if len(c.route) == 0:
                activation_penalty = NEW_CLEANER_PENALTY_MIN
            else:
                activation_penalty = 0

            score = (
                t_travel
                + effective_load_weight * load_h
                + sb_bonus
                + activation_penalty
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


def build_output(cleaners: List[Cleaner], unassigned: List[Task], original_tasks: List[Task]) -> Dict[str, Any]:
    cleaners_with_tasks: List[Dict[str, Any]] = []

    for cl in cleaners:
        if not cl.route:
            continue

        # HP: accetta anche 1 sola task (task urgenti)
        # Non applicare vincolo minimo per High-Priority

        feasible, schedule = evaluate_route(cl, cl.route)
        if not feasible or not schedule:
            continue

        tasks_list: List[Dict[str, Any]] = []

        for idx, (t, (arr, start, fin)) in enumerate(zip(cl.route, schedule)):
            overall_seq = cl.eo_last_sequence + idx + 1

            # Calcola travel_time
            if overall_seq == 1:
                travel_time = 0
            elif idx == 0 and cl.eo_last_sequence >= 1:
                # Primo HP dopo EO
                if cl.last_eo_lat is not None and cl.last_eo_lng is not None:
                    hop = travel_minutes(cl.last_eo_lat, cl.last_eo_lng, t.lat, t.lng,
                                       cl.last_eo_address, t.address)
                    travel_time = int(round(hop))
                else:
                    travel_time = 0 if same_street(cl.last_eo_address, t.address) else 12
            else:
                # Hop da HP precedente
                prev = cl.route[idx - 1]
                hop = travel_minutes(prev.lat, prev.lng, t.lat, t.lng, prev.address, t.address)
                travel_time = int(round(hop))

            # Carica i dati originali completi della task da containers.json
            containers_data = json.loads(INPUT_CONTAINERS.read_text(encoding="utf-8"))
            original_task_data = None

            # Cerca la task nei containers
            for container_type in ['early_out', 'high_priority', 'low_priority']:
                container = containers_data.get('containers', {}).get(container_type, {})
                for task in container.get('tasks', []):
                    if str(task.get('task_id')) == str(t.task_id) or str(task.get('logistic_code')) == str(t.logistic_code):
                        original_task_data = task
                        break
                if original_task_data:
                    break

            # Se non trovato, crea struttura base
            if not original_task_data:
                original_task_data = {
                    "task_id": int(t.task_id),
                    "logistic_code": int(t.logistic_code),
                    "address": t.address,
                    "lat": t.lat,
                    "lng": t.lng,
                    "premium": t.is_premium,
                    "cleaning_time": t.cleaning_time,
                }

            start_time_str = fmt_hhmm(start)
            end_time_str = fmt_hhmm(fin)

            # Mantieni TUTTI gli attributi originali + aggiungi campi timeline
            task_for_timeline = {
                **original_task_data,  # Copia TUTTI i campi da containers.json
                # Aggiungi/sovrascrivi campi specifici della timeline
                "priority": "high_priority",
                "start_time": start_time_str,
                "end_time": end_time_str,
                "followup": idx > 0,
                "sequence": overall_seq,
                "travel_time": travel_time,
                # Normalizza ESPLICITAMENTE i campi straordinaria e premium
                "straordinaria": bool(original_task_data.get("straordinaria", False)),
                "premium": bool(original_task_data.get("premium", False)),
                "reasons": [
                    *(original_task_data.get("reasons", [])),  # Mantieni reasons originali
                    "automatic_assignment_hp"  # Aggiungi reason timeline
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

    # Trova le task assegnate usando task_id (NON logistic_code per permettere duplicati)
    assigned_task_ids = set()
    for entry in cleaners_with_tasks:
        for t in entry.get("tasks", []):
            assigned_task_ids.add(int(t["task_id"]))

    # Unassigned list
    unassigned_list: List[Dict[str, Any]] = []
    for ot in original_tasks:
        tid = int(ot.task_id)
        lc = int(ot.logistic_code)
        if tid not in assigned_task_ids:
            unassigned_list.append({
                "task_id": tid,
                "logistic_code": lc,
                "reason": "no_eligible_cleaner_or_time_window"
            })

    total_assigned = sum(len(c["tasks"]) for c in cleaners_with_tasks)

    # Usa la data passata come argomento da riga di comando
    import sys
    if len(sys.argv) > 1:
        current_ref_date = sys.argv[1]
    else:
        # Fallback to ref_date loaded from tasks if no command line arg
        _, ref_date_from_tasks = load_tasks() # Reload tasks to get ref_date
        current_ref_date = ref_date_from_tasks


    return {
        "high_priority_tasks_assigned": cleaners_with_tasks,
        "unassigned_tasks": unassigned_list,
        "current_date": current_ref_date,
        "meta": {
            "total_tasks": len(original_tasks),
            "assigned": total_assigned,
            "unassigned": len(original_tasks) - total_assigned,
            "cleaners_used": len(cleaners_with_tasks),
            "max_tasks_per_cleaner": 3,
            "algorithm": "simplified_greedy",
            "notes": [
                "REGOLE HIGH-PRIORITY OTTIMIZZATE:",
                "1. Max 2 task HP per cleaner",
                "2. NESSUN vincolo minimo (può assegnare anche 1 sola task)",
                "3. Considera finestre checkout/checkin e tempi percorrenza",
                "4. Considera task EO precedenti (disponibilità e posizione)",
                "5. Straordinarie solo a premium cleaner, devono essere la prima task",
                "6. Premium task solo a premium cleaner",
                "7. Check-in strict: deve finire prima del check-in time",
                "8. HP hard earliest: 11:00",
                "9. Vincolo orario: nessuna task deve finire dopo le 19:00",
                "10. CROSS-CONTAINER: Favorisce vicinanza con task EO già assegnate"
            ]
        }
    }


def main():
    if not INPUT_CONTAINERS.exists(): # Check for containers.json
        raise SystemExit(f"Missing input file: {INPUT_CONTAINERS}")
    if not INPUT_CLEANERS.exists():
        raise SystemExit(f"Missing input file: {INPUT_CLEANERS}")

    # Usa la data passata come argomento da riga di comando
    import sys
    if len(sys.argv) > 1:
        ref_date = sys.argv[1]
        print(f"📅 Usando data da argomento: {ref_date}")
    else:
        # Fallback: carica la data dai task
        tasks_temp, ref_date = load_tasks()
        print(f"📅 Data estratta dai task: {ref_date}")

    tasks, _ = load_tasks() # Reload tasks to get the correct ref_date
    cleaners = load_cleaners(ref_date)
    seed_cleaners_from_eo(cleaners, ref_date)

    print(f"📋 Caricamento dati...")
    print(f"   - Cleaner disponibili: {len(cleaners)}")
    print(f"   - Task High-Priority da assegnare: {len(tasks)}")

    # Leggi i logistic_code già assegnati dalla timeline
    assigned_logistic_codes = set()
    timeline_path = OUTPUT_ASSIGN.parent / "timeline.json"
    if timeline_path.exists():
        try:
            timeline_data = json.loads(timeline_path.read_text(encoding="utf-8"))
            for cleaner_entry in timeline_data.get("cleaners_assignments", []):
                for task in cleaner_entry.get("tasks", []):
                    logistic_code = str(task.get("logistic_code"))
                    if logistic_code:
                        assigned_logistic_codes.add(logistic_code)
            if assigned_logistic_codes:
                print(f"📌 Logistic codes già assegnati in timeline: {len(assigned_logistic_codes)}")
        except Exception as e:
            print(f"⚠️ Errore lettura timeline per deduplica: {e}")

    print()
    print(f"🔄 Assegnazione in corso...")

    planners, leftovers = plan_day(tasks, cleaners, assigned_logistic_codes)
    output = build_output(planners, leftovers, tasks)

    print()
    print(f"✅ Assegnazione completata!")
    print(f"   - Task assegnati: {output['meta']['assigned']}/{output['meta']['total_tasks']}")
    print(f"   - Cleaner utilizzati: {output['meta']['cleaners_used']}")
    print(f"   - Task non assegnati: {output['meta']['unassigned']}")
    print()

    # Update timeline.json con struttura organizzata per cleaner
    from datetime import datetime as dt
    timeline_path = OUTPUT_ASSIGN.parent / "timeline.json"

    # Carica timeline esistente o crea nuova struttura
    timeline_data = {
        "metadata": {
            "last_updated": dt.now().isoformat(),
            "date": ref_date
        },
        "cleaners_assignments": [],
        "meta": {
            "total_cleaners": 0,
            "total_tasks": 0
        }
    }

    if timeline_path.exists():
        try:
            existing = json.loads(timeline_path.read_text(encoding="utf-8"))
            # Mantieni le assegnazioni esistenti non-HP (rimuovi quelle con task HP)
            if "cleaners_assignments" in existing:
                # Crea un set di cleaner_id che avranno nuove assegnazioni HP
                new_hp_cleaner_ids = set(c["cleaner"]["id"] for c in output["high_priority_tasks_assigned"])
                timeline_data["cleaners_assignments"] = [
                    c for c in existing.get("cleaners_assignments", [])
                    if c["cleaner"]["id"] not in new_hp_cleaner_ids or
                       not any(t.get("reasons") and "automatic_assignment_hp" in t.get("reasons", []) for t in c.get("tasks", []))
                ]
        except Exception as e:
            print(f"⚠️ Errore nel leggere la timeline esistente: {e}")
            timeline_data["cleaners_assignments"] = [] # Reset assignments on error

    # Aggiungi le nuove assegnazioni HP organizzate per cleaner
    for cleaner_entry in output["high_priority_tasks_assigned"]:
        # Cerca se esiste già un'entry per questo cleaner
        existing_entry = None
        for entry in timeline_data["cleaners_assignments"]:
            if entry["cleaner"]["id"] == cleaner_entry["cleaner"]["id"]:
                existing_entry = entry
                break

        if existing_entry:
            # Aggiungi le task HP alle task esistenti
            existing_entry["tasks"].extend(cleaner_entry["tasks"])
            # Ordina le task per orario di inizio (start_time)
            existing_entry["tasks"].sort(key=lambda t: t.get("start_time", "00:00"))
        else:
            # Crea nuova entry
            timeline_data["cleaners_assignments"].append({
                "cleaner": cleaner_entry["cleaner"],
                "tasks": cleaner_entry["tasks"]
            })

    # Aggiorna meta
    # Conta i cleaners effettivamente usati (con almeno una task)
    used_cleaners = len([c for c in timeline_data["cleaners_assignments"] if len(c.get("tasks", [])) > 0])

    timeline_data["metadata"]["last_updated"] = dt.now().isoformat()
    timeline_data["metadata"]["date"] = ref_date
    timeline_data["meta"]["total_cleaners"] = len(cleaners)  # Tutti i cleaners disponibili
    timeline_data["meta"]["used_cleaners"] = used_cleaners  # Cleaners effettivamente usati
    timeline_data["meta"]["assigned_tasks"] = sum(
        len(c.get("tasks", [])) for c in timeline_data["cleaners_assignments"]
    )

    # Scrivi il file timeline.json
    try:
        timeline_path.write_text(json.dumps(timeline_data, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"✅ Aggiornato {timeline_path}")
    except Exception as e:
        print(f"❌ Errore nella scrittura di {timeline_path}: {e}")


    hp_count = len([c for c in timeline_data["cleaners_assignments"]
                   if any(t.get("reasons") and "automatic_assignment_hp" in t.get("reasons", []) for t in c.get("tasks", []))])
    print(f"   - Cleaner con assegnazioni HP: {hp_count}")
    print(f"   - Totale task assegnate: {timeline_data['meta']['assigned_tasks']}")

    # SPOSTAMENTO: Rimuovi le task assegnate da containers.json
    containers_path = INPUT_CONTAINERS
    if containers_path.exists():
        try:
            containers_data = json.loads(containers_path.read_text(encoding="utf-8"))

            # Trova tutti i task_id assegnati (NON logistic_code per permettere duplicati)
            assigned_task_ids = set()
            for cleaner_entry in output["high_priority_tasks_assigned"]:
                for task in cleaner_entry.get("tasks", []):
                    assigned_task_ids.add(int(task["task_id"]))

            # Rimuovi le task assegnate dal container high_priority usando task_id
            if "containers" in containers_data and "high_priority" in containers_data["containers"]:
                original_count = len(containers_data["containers"]["high_priority"]["tasks"])
                containers_data["containers"]["high_priority"]["tasks"] = [
                    t for t in containers_data["containers"]["high_priority"]["tasks"]
                    if int(t.get("task_id", 0)) not in assigned_task_ids
                ]
                new_count = len(containers_data["containers"]["high_priority"]["tasks"])
                containers_data["containers"]["high_priority"]["count"] = new_count

                # Aggiorna summary
                if "summary" in containers_data:
                    containers_data["summary"]["high_priority"] = new_count
                    containers_data["summary"]["total_tasks"] = (
                        containers_data["summary"].get("total_tasks", 0) - (original_count - new_count)
                    )

                # Scrivi containers.json aggiornato
                containers_path.write_text(json.dumps(containers_data, ensure_ascii=False, indent=2), encoding="utf-8")
                print(f"✅ Rimosse {original_count - new_count} task da containers.json (high_priority) usando task_id")
                print(f"   - Task rimaste in high_priority: {new_count}")
                print(f"   💡 Task con logistic_code duplicati rimangono disponibili nei container")
            else:
                print(f"   ℹ️ Nessuna sezione 'high_priority' trovata in containers.json per la rimozione delle task.")
        except Exception as e:
            print(f"❌ Errore durante la rimozione delle task assegnate da containers.json: {e}")
    else:
        print(f"   ℹ️ containers.json non trovato, impossibile rimuovere le task assegnate.")


if __name__ == "__main__":
    main()