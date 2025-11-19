# -*- coding: utf-8 -*-
from __future__ import annotations
import json, math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path
import sys
from datetime import datetime
from task_validation import can_cleaner_handle_task, can_cleaner_handle_apartment

# =============================
# I/O paths
# =============================
BASE = Path(__file__).parent.parent / "data"

INPUT_CONTAINERS = BASE / "output" / "containers.json"
INPUT_CLEANERS = BASE / "cleaners" / "selected_cleaners.json"
INPUT_EO_ASSIGN = BASE / "output" / "early_out_assignments.json"
INPUT_HP_ASSIGN = BASE / "output" / "high_priority_assignments.json"
OUTPUT_ASSIGN = BASE / "output" / "low_priority_assignments.json"

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

# NUOVO: Limite per tipologia FLESSIBILE (può essere infranto da cluster)
BASE_MAX_TASKS_PER_PRIORITY = 2  # Max 2 task Low-Priority per cleaner (base)

# NUOVO: Limite giornaliero totale
MAX_DAILY_TASKS = 5  # Max 5 task totali per cleaner al giorno (hard limit)
PREFERRED_DAILY_TASKS = 4  # Preferibile max 4 task totali (soft limit)


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
    h, m = hhmm.strip().split(":")
    return int(h) * 60 + int(m)


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
    # Stesso edificio
    if a_addr and b_addr and same_building(a_addr, b_addr):
        return max(MIN_TRAVEL, min(MAX_TRAVEL, SHORT_BASE_MIN))

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
    if task.straordinaria and not cleaner.is_premium:
        return False
    return True


# -------- Schedulazione / costo --------
def evaluate_route(cleaner: Cleaner, route: List[Task]) -> Tuple[bool, List[Tuple[int, int, int]]]:
    """
    Valuta se una route è fattibile per un cleaner LP.
    Ritorna: (is_feasible, schedule)
    schedule = [(arrival, start, finish), ...]
    """
    if not route:
        return True, []

    # Orario massimo di fine task: 19:00 (1140 minuti da mezzanotte)
    MAX_END_TIME = 19 * 60

    schedule: List[Tuple[int, int, int]] = []

    # Primo task LP
    first = route[0]

    # Calcola l'arrivo al primo task
    # available_from è già in minuti da mezzanotte (non serve hhmm_to_min)
    # Se None, usa 10:00 (600 minuti) come default
    work_start_min = cleaner.available_from if cleaner.available_from is not None else 10 * 60

    # Viaggio da ultima posizione a LP
    if cleaner.last_lat is not None and cleaner.last_lng is not None:
        tt = travel_minutes(cleaner.last_lat, cleaner.last_lng,
                          first.lat, first.lng,
                          cleaner.last_address, first.address)
    else:
        tt = 3.0 if same_street(cleaner.last_address, first.address) else 12.0

    arrival = work_start_min + tt
    start = arrival
    finish = start + first.cleaning_time

    # NUOVO: Check-in strict - deve finire prima del check-in
    if hasattr(first, 'checkin_dt') and first.checkin_dt:
        checkin_minutes = first.checkin_dt.hour * 60 + first.checkin_dt.minute
        if finish > checkin_minutes:
            return False, []

    # Vincolo orario: nessuna task deve finire dopo le 19:00
    if finish > MAX_END_TIME:
        return False, []

    schedule.append((int(arrival), int(start), int(finish)))
    cur = finish

    # Task successive
    for i in range(1, len(route)):
        t = route[i]
        prev = route[i - 1]
        tt = travel_minutes(prev.lat, prev.lng, t.lat, t.lng, prev.address, t.address)
        cur += tt
        arrival = cur
        start = cur
        finish = start + t.cleaning_time

        # NUOVO: Check-in strict - deve finire prima del check-in
        if hasattr(t, 'checkin_dt') and t.checkin_dt:
            checkin_minutes = t.checkin_dt.hour * 60 + t.checkin_dt.minute
            if finish > checkin_minutes:
                return False, []

        # Vincolo orario: nessuna task deve finire dopo le 19:00
        if finish > MAX_END_TIME:
            return False, []

        schedule.append((int(arrival), int(start), int(finish)))
        cur = finish

    return True, schedule


def can_add_task(cleaner: Cleaner, task: Task) -> bool:
    """
    Verifica se è possibile aggiungere una task al cleaner secondo le regole:
    1. Premium task -> premium cleaner
    2. Straordinaria -> premium cleaner, deve essere la prima (pos=0)
    3. CLUSTERING: appartamenti vicini (≤10') possono infrangere limiti tipologia
    4. Stessa via o ≤5': massima priorità cluster
    5. Limite giornaliero: max 5 task totali (EO+HP+LP)
    6. FORMATORE: vincoli da settings.json (apartment_types)
    """
    # Validazione tipo appartamento (legge da settings.json)
    if task.apt_type and not can_cleaner_handle_apartment(cleaner.role, task.apt_type):
        return False

    # Formatore max 2 task LP al giorno (totale)
    if cleaner.role.lower() == "formatore":
        if len(cleaner.route) >= 2:
            return False

    if not can_handle_premium(cleaner, task):
        return False

    current_count = len(cleaner.route)

    # Calcola totale task giornaliere (EO+HP già fatte + LP in route)
    total_daily = cleaner.total_daily_tasks + current_count

    # NUOVO: Controllo limite giornaliero HARD (max 5 task totali)
    if total_daily >= MAX_DAILY_TASKS:
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
                          task.address, task.address) <= CLUSTER_PRIORITY_TRAVEL or
             same_street(existing_task.address, task.address))
            for existing_task in cleaner.route
        )

        # Cluster esteso: ≤10' (infrange limite tipologia)
        is_extended_cluster = any(
            (travel_minutes(existing_task.lat, existing_task.lng, task.lat, task.lng,
                          existing_task.address, task.address) <= CLUSTER_EXTENDED_TRAVEL or
             travel_minutes(task.lat, task.lng, existing_task.lat, existing_task.lng,
                          task.address, task.address) <= CLUSTER_EXTENDED_TRAVEL)
            for existing_task in cleaner.route
        )

        # Se è in cluster prioritario: ignora limiti tipologia, rispetta SEMPRE limite giornaliero
        if is_priority_cluster:
            # Verifica limite giornaliero HARD (EO + HP + LP già fatte + questa task)
            if total_daily >= MAX_DAILY_TASKS:
                return False
            # Verifica max assoluto LP
            if current_count >= ABSOLUTE_MAX_TASKS:
                return False
            return True

        # Se è in cluster esteso: ignora limite tipologia, rispetta limiti giornaliero e max assoluto
        if is_extended_cluster:
            # Verifica limite giornaliero HARD
            if total_daily >= MAX_DAILY_TASKS:
                return False
            # Verifica max assoluto LP
            if current_count >= ABSOLUTE_MAX_TASKS:
                return False
            return True

    # NUOVO: Limite LP dinamico in base alle task già assegnate (EO+HP)
    max_lp_allowed = MAX_DAILY_TASKS - cleaner.total_daily_tasks
    dynamic_max_lp = min(BASE_MAX_TASKS_PER_PRIORITY, max_lp_allowed)

    # Se lo spazio rimanente è maggiore di 2, usa quello spazio
    if max_lp_allowed > BASE_MAX_TASKS_PER_PRIORITY:
        dynamic_max_lp = max_lp_allowed

    if current_count >= dynamic_max_lp and not (current_count < BASE_MAX_TASKS):
        # Permetti comunque se è in cluster e sotto max assoluto
        if not (is_priority_cluster or is_extended_cluster):
            return False

    # Regola base: max 2 task
    if current_count < BASE_MAX_TASKS:
        return True

    # 3ª-5ª task: solo se fattibile temporalmente
    if current_count >= BASE_MAX_TASKS and current_count < ABSOLUTE_MAX_TASKS:
        test_route = cleaner.route + [task]
        feasible, schedule = evaluate_route(cleaner, test_route)
        if feasible and schedule:
            last_finish = schedule[-1][2]  # finish time in minuti
            if current_count < ABSOLUTE_MAX_TASKS_IF_BEFORE_18 and last_finish <= 18 * 60:
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
            # Prima task LP: calcola viaggio da ultima posizione
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

        # Scegli la posizione con minor viaggio
        if max_travel < best_travel:
            best_travel = max_travel
            best_pos = pos

    if best_pos is not None:
        return (best_pos, best_travel)

    return None


# -------- Loader --------
def load_cleaners() -> List[Cleaner]:
    data = json.loads(INPUT_CLEANERS.read_text(encoding="utf-8"))
    cleaners: List[Cleaner] = []
    for c in data.get("cleaners", []):
        role = (c.get("role") or "").strip()
        is_premium = bool(c.get("premium", (role.lower() == "premium")))
        can_do_straordinaria = bool(c.get("can_do_straordinaria", False))
        # Includi Formatori in Low-Priority (non li filtriamo)

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


def seed_cleaners_from_assignments(cleaners: List[Cleaner]):
    """
    Seed cleaners con informazioni da timeline.json (EO e HP assignments)
    Conta anche il totale task giornaliere per applicare il limite di 5
    """
    # Leggi dalla timeline.json invece che dai file individuali
    timeline_path = OUTPUT_ASSIGN.parent / "timeline.json"
    if not timeline_path.exists():
        # Fallback: prova con i file individuali
        if INPUT_EO_ASSIGN.exists():
            data = json.loads(INPUT_EO_ASSIGN.read_text(encoding="utf-8"))
            blocks = data.get("early_out_tasks_assigned", [])
        elif INPUT_HP_ASSIGN.exists():
            data = json.loads(INPUT_HP_ASSIGN.read_text(encoding="utf-8"))
            blocks = data.get("high_priority_tasks_assigned", [])
        else:
            return
    else:
        # Leggi dalla timeline.json
        timeline_data = json.loads(timeline_path.read_text(encoding="utf-8"))
        blocks = timeline_data.get("cleaners_assignments", [])

    for block in blocks:
        cid = int(block["cleaner"]["id"])
        tasks = block.get("tasks", [])
        if not tasks:
            continue

        # Filtra solo task NON-LP (EO e HP)
        non_lp_tasks = [t for t in tasks if
                        t.get("priority") in ["early_out", "high_priority"] or
                        ("automatic_assignment_lp" not in t.get("reasons", []))]

        if not non_lp_tasks:
            continue

        # Ordina per end_time per trovare l'ultima (gestisci None)
        non_lp_tasks.sort(key=lambda t: t.get("end_time") or "00:00")
        last = non_lp_tasks[-1]

        end_time = hhmm_to_min(last.get("end_time"))
        last_addr = last.get("address")
        last_lat = last.get("lat")
        last_lng = last.get("lng")
        last_seq = last.get("sequence") or len(non_lp_tasks)

        for cl in cleaners:
            if cl.id == cid:
                cl.available_from = end_time
                cl.last_address = last_addr
                cl.last_lat = float(last_lat) if last_lat is not None else None
                cl.last_lng = float(last_lng) if last_lng is not None else None
                cl.last_sequence = int(last_seq)
                # NUOVO: Conta il totale task giornaliere (EO + HP)
                cl.total_daily_tasks = len(non_lp_tasks)
                break


def load_tasks() -> List[Task]:
    data = json.loads(INPUT_CONTAINERS.read_text(encoding="utf-8"))
    tasks: List[Task] = []
    for t in data.get("containers", {}).get("low_priority", {}).get("tasks", []):
        # Parse checkin e checkout datetime
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

    # Ordina: straordinarie first, poi premium
    tasks.sort(key=lambda x: (not x.straordinaria, not x.is_premium))
    return tasks


# -------- Planner --------
def plan_day(tasks: List[Task], cleaners: List[Cleaner], assigned_logistic_codes: set = None) -> Tuple[List[Cleaner], List[Task]]:
    """
    Assegna le task ai cleaner con regole semplificate:
    - Favorisce percorsi < 15'
    - Se non ci sono percorsi < 15', sceglie il minore dei > 15'
    - Max 4 task per cleaner per LP
    - DEDUPLICA: Solo una task per logistic_code viene assegnata
    - CLUSTERING PREVENTIVO: Raggruppa task stesso edificio prima dell'assegnazione
    - CLUSTERING CROSS-CONTAINER: Raggruppa task vicine a quelle già assegnate (EO/HP)
    """
    if assigned_logistic_codes is None:
        assigned_logistic_codes = set()

    unassigned = []

    # CLUSTERING PREVENTIVO CROSS-CONTAINER: Carica task già assegnate dalla timeline
    timeline_path = OUTPUT_ASSIGN.parent / "timeline.json"
    assigned_tasks_by_location = []  # Lista di (lat, lng, address) delle task già assegnate

    if timeline_path.exists():
        try:
            timeline_data = json.loads(timeline_path.read_text(encoding="utf-8"))
            for cleaner_entry in timeline_data.get("cleaners_assignments", []):
                for t in cleaner_entry.get("tasks", []):
                    lat = t.get("lat")
                    lng = t.get("lng")
                    addr = t.get("address")
                    if lat is not None and lng is not None:
                        assigned_tasks_by_location.append((float(lat), float(lng), addr))
            print(f"   🔄 CROSS-CONTAINER: Caricate {len(assigned_tasks_by_location)} task già assegnate")
        except Exception as e:
            print(f"   ⚠️ Errore caricamento timeline per clustering: {e}")

    # CLUSTERING PREVENTIVO: Raggruppa task per vicinanza (edificio o task già assegnate)
    building_groups = {}
    cross_container_groups = {}  # Nuovi gruppi per task vicine a quelle già assegnate

    for task in tasks:
        if task.logistic_code in assigned_logistic_codes:
            continue

        # 1. PRIORITÀ MASSIMA: Controlla se è nello stesso edificio di una task da assegnare
        found_building_group = False
        for group_key, group_tasks in building_groups.items():
            if same_building(group_tasks[0].address, task.address):
                group_tasks.append(task)
                found_building_group = True
                print(f"   🏢 Task {task.task_id} aggiunta al gruppo edificio: {task.address}")
                break

        if found_building_group:
            continue

        # 2. PRIORITÀ ALTA: Controlla se è vicina a una task già assegnata (cross-container)
        found_cross_container = False
        for assigned_lat, assigned_lng, assigned_addr in assigned_tasks_by_location:
            # Stesso edificio con task già assegnata
            if assigned_addr and same_building(assigned_addr, task.address):
                key = f"cross_{assigned_addr}_{assigned_lat}_{assigned_lng}"
                if key not in cross_container_groups:
                    cross_container_groups[key] = []
                cross_container_groups[key].append(task)
                found_cross_container = True
                print(f"   🔄 Task {task.task_id} vicina a edificio già assegnato: {assigned_addr}")
                break
            # Stessa zona (≤800m)
            if same_zone(task.lat, task.lng, assigned_lat, assigned_lng, task.address, assigned_addr):
                key = f"cross_zone_{assigned_lat}_{assigned_lng}"
                if key not in cross_container_groups:
                    cross_container_groups[key] = []
                cross_container_groups[key].append(task)
                found_cross_container = True
                print(f"   🔄 Task {task.task_id} in zona di task già assegnata")
                break

        if found_cross_container:
            continue

        # 3. Nessuna vicinanza: crea nuovo gruppo edificio
        building_groups[task.address or f"task_{task.task_id}"] = [task]

    # Ordina i gruppi: prima cross-container (massima priorità), poi stesso edificio
    all_groups = []
    all_groups.extend(cross_container_groups.values())
    all_groups.extend(building_groups.values())
    sorted_groups = sorted(all_groups, key=lambda g: -len(g))

    # Log statistiche clustering
    if cross_container_groups:
        print(f"   ✅ Gruppi cross-container: {len(cross_container_groups)}")
    if building_groups:
        print(f"   ✅ Gruppi stesso edificio: {len(building_groups)}")

    # Appiattisci mantenendo l'ordine dei gruppi
    ordered_tasks = []
    for group in sorted_groups:
        ordered_tasks.extend(group)

    print(f"   📦 Task ordinate per clustering: {len(ordered_tasks)}")

    for task in ordered_tasks:
        # DEDUPLICA: Skippa task con logistic_code già assegnato
        if task.logistic_code in assigned_logistic_codes:
            print(f"   ⏭️  Skippata task {task.task_id} (logistic_code {task.logistic_code} già assegnato)")
            unassigned.append(task)
            continue

        # PRIORITÀ ASSOLUTA: Cerca se qualche cleaner ha già una task nello stesso edificio (LP, HP o EO)
        same_building_cleaner = None
        same_zone_cleaner = None

        # Leggi timeline una sola volta
        timeline_data = None
        timeline_path = OUTPUT_ASSIGN.parent / "timeline.json"
        if timeline_path.exists():
            try:
                timeline_data = json.loads(timeline_path.read_text(encoding="utf-8"))
            except Exception as e:
                print(f"   ⚠️ Errore caricamento timeline per clustering cross-container: {e}")
                timeline_data = None

        for cleaner in cleaners:
            # 1) Controlla task LP già in route (stesso edificio)
            if any(same_building(existing_task.address, task.address) for existing_task in cleaner.route):
                same_building_cleaner = cleaner
                break

            # 2) CROSS-CONTAINER: controlla tutte le task di questo cleaner in timeline
            if timeline_data:
                for cleaner_entry in timeline_data.get("cleaners_assignments", []):
                    if cleaner_entry["cleaner"]["id"] != cleaner.id:
                        continue

                    for t in cleaner_entry.get("tasks", []):
                        t_addr = t.get("address")
                        t_lat = t.get("lat")
                        t_lng = t.get("lng")

                        # 2a) stesso edificio -> priorità massima
                        if same_building(t_addr, task.address):
                            same_building_cleaner = cleaner
                            priority = t.get("priority", "unknown")
                            print(f"   🔄 CROSS-CONTAINER EDIFICIO: task {task.task_id} vicina a task {priority.upper()} di {cleaner.name}")
                            break

                        # 2b) stessa ZONA -> memorizza come candidato di zona
                        if t_lat is not None and t_lng is not None:
                            if same_zone(float(t_lat), float(t_lng),
                                         task.lat, task.lng,
                                         t_addr, task.address):
                                if same_zone_cleaner is None:
                                    same_zone_cleaner = cleaner
                                    priority = t.get("priority", "unknown")
                                    print(f"   🔄 CROSS-CONTAINER ZONA: task {task.task_id} vicina (zona) a task {priority.upper()} di {cleaner.name}")
                    if same_building_cleaner:
                        break

            if same_building_cleaner:
                break

        # Usa prima stesso edificio, altrimenti stessa zona
        target_cleaner = same_building_cleaner or same_zone_cleaner
        if target_cleaner:
            # VALIDAZIONE: Verifica compatibilità task_type e apartment_type per fast-path cross-container
            task_type = 'straordinario_apt' if task.straordinaria else ('premium_apt' if task.is_premium else 'standard_apt')
            if not can_cleaner_handle_task(target_cleaner.role, task_type, target_cleaner.can_do_straordinaria):
                tipo = "edificio" if same_building_cleaner else "zona"
                print(f"   ⚠️  Cross-container {tipo} cleaner {target_cleaner.name} ({target_cleaner.role}) non può gestire task {task_type} - SKIPPATO fast-path")
            elif not can_cleaner_handle_apartment(target_cleaner.role, task.apt_type):
                tipo = "edificio" if same_building_cleaner else "zona"
                print(f"   ⚠️  Cross-container {tipo} cleaner {target_cleaner.name} ({target_cleaner.role}) non può gestire appartamento {task.apt_type} - SKIPPATO fast-path")
            else:
                result = find_best_position(target_cleaner, task)
                if result is not None:
                    pos, travel = result
                    target_cleaner.route.insert(pos, task)
                    assigned_logistic_codes.add(task.logistic_code)
                    tipo = "edificio" if same_building_cleaner else "zona"
                    print(f"   🧩 Task {task.task_id} assegnata a {target_cleaner.name} (cross-container {tipo}: {task.address})")
                    continue
                else:
                    # Se ha limite raggiunto per LP, ma è in zona, forza comunque l'assegnazione
                    # solo se il limite giornaliero lo permette
                    if same_zone_cleaner:
                        # VALIDAZIONE: Verifica compatibilità task_type e apartment_type per forced assignment
                        task_type = 'straordinario_apt' if task.straordinaria else ('premium_apt' if task.is_premium else 'standard_apt')
                        if not can_cleaner_handle_task(same_zone_cleaner.role, task_type, same_zone_cleaner.can_do_straordinaria):
                            print(f"   ⚠️  Forced assignment a {same_zone_cleaner.name} ({same_zone_cleaner.role}) non può gestire task {task_type} - SKIPPATO")
                        elif not can_cleaner_handle_apartment(same_zone_cleaner.role, task.apt_type):
                            print(f"   ⚠️  Forced assignment a {same_zone_cleaner.name} ({same_zone_cleaner.role}) non può gestire appartamento {task.apt_type} - SKIPPATO")
                        else:
                            current_count = len(same_zone_cleaner.route)
                            total_daily = same_zone_cleaner.total_daily_tasks + current_count

                            # Se non ha superato il limite giornaliero assoluto, forza l'assegnazione
                            if total_daily < MAX_DAILY_TASKS:
                                # Prova ad aggiungere alla fine della route
                                test_route = same_zone_cleaner.route + [task]
                                feasible, _ = evaluate_route(same_zone_cleaner, test_route)
                                if feasible:
                                    same_zone_cleaner.route.append(task)
                                    assigned_logistic_codes.add(task.logistic_code)
                                    print(f"   🔥 Task {task.task_id} FORZATA a {same_zone_cleaner.name} (cross-container zona, limite LP superato ma fattibile)")
                                    continue

                    print(f"   ⚠️  Task {task.task_id} vicina a {target_cleaner.name} ma limite raggiunto e non fattibile")


        # Se non c'è stesso edificio o zona, procedi con logica normale
        candidates = []

        for cleaner in cleaners:
            # VALIDAZIONE: Verifica se il cleaner può gestire questo tipo di task
            task_type = 'straordinario_apt' if task.straordinaria else ('premium_apt' if task.is_premium else 'standard_apt')
            if not can_cleaner_handle_task(cleaner.role, task_type, cleaner.can_do_straordinaria):
                print(f"   ⚠️  Cleaner {cleaner.name} ({cleaner.role}) non può gestire task {task_type} - SKIPPATO (task_id: {task.task_id})")
                continue

            # NUOVO: Validazione tipo appartamento
            if not can_cleaner_handle_apartment(cleaner.role, task.apt_type):
                print(f"   ⚠️  Cleaner {cleaner.name} ({cleaner.role}) non può gestire appartamento {task.apt_type} - SKIPPATO (task_id: {task.task_id}, logistic_code: {task.logistic_code})")
                continue

            if can_add_task(cleaner, task):
                result = find_best_position(cleaner, task)
                if result is not None:
                    pos, travel = result
                    candidates.append((cleaner, pos, travel))
                else:
                    print(f"   ⚠️  Cleaner {cleaner.name} può gestire task {task.task_id} ma find_best_position ha fallito (vincoli temporali)")
            else:
                # Debug: perché can_add_task ha fallito?
                current_lp = len(cleaner.route)
                total_daily = cleaner.total_daily_tasks + current_lp
                print(f"   ⚠️  Cleaner {cleaner.name} non può aggiungere task {task.task_id}: LP={current_lp}, Total daily={total_daily}/{MAX_DAILY_TASKS}")

        if not candidates:
            unassigned.append(task)
            continue

        # Priorità 1: Stesso EDIFICIO (indirizzo completo uguale) - solo nuove assegnazioni
        same_building_candidates = []
        for c, p, t in candidates:
            has_same_building = any(
                same_building(existing_task.address, task.address)
                for existing_task in c.route
            )
            if has_same_building:
                same_building_candidates.append((c, p, t))

        if same_building_candidates:
            # PRIORITÀ MASSIMA: stesso edificio = massima aggregazione
            # Preferisci chi ha già più task (massimo clustering)
            same_building_candidates.sort(key=lambda x: (-len(x[0].route), x[2]))
            chosen = same_building_candidates[0]
        # Priorità 2: stessa ZONA
        elif any(
            any(
                same_zone(ex.lat, ex.lng, task.lat, task.lng, ex.address, task.address)
                for ex in c.route
            )
            for c, _, _ in candidates if c.route
        ):
            zone_candidates = [
                (c, p, t) for c, p, t in candidates
                if any(
                    same_zone(ex.lat, ex.lng, task.lat, task.lng, ex.address, task.address)
                    for ex in c.route
                )
            ]
            zone_candidates.sort(key=lambda x: (-len(x[0].route), x[2]))
            chosen = zone_candidates[0]

        else:
            # Priorità successiva: cleaner con task entro 10 minuti (cluster generico)
            cluster_candidates = []
            for c, p, t in candidates:
                has_cluster = any(
                    travel_minutes(existing_task.lat, existing_task.lng, task.lat, task.lng,
                                   existing_task.address, task.address) <= CLUSTER_MAX_TRAVEL or
                    travel_minutes(task.lat, task.lng, existing_task.lat, existing_task.lng,
                                   task.address, task.address) <= CLUSTER_MAX_TRAVEL
                    for existing_task in c.route
                )
                if has_cluster:
                    cluster_candidates.append((c, p, t))

            if cluster_candidates:
                # Priorità alta a cleaner in cluster
                # NUOVO: preferisci chi ha meno task totali (per evitare di superare 4)
                cluster_candidates.sort(key=lambda x: (
                    x[0].total_daily_tasks + len(x[0].route),  # Totale task (EO+HP+LP)
                    len(x[0].route),  # Task LP
                    x[2]  # Travel time
                ))
                chosen = cluster_candidates[0]
            else:
                # Nessun cluster, usa logica normale
                # Dividi i candidati in due gruppi: < 20' e >= 20'
                preferred = [(c, p, t) for c, p, t in candidates if t < PREFERRED_TRAVEL]
                others = [(c, p, t) for c, p, t in candidates if t >= PREFERRED_TRAVEL]

                # Scegli dal gruppo preferito se esiste, altrimenti dal gruppo altri
                if preferred:
                    # NUOVO: preferisci chi ha meno task totali (per evitare di superare 4)
                    # Ma tra quelli con stesso totale, preferisci chi ha più LP (per aggregare)
                    preferred.sort(key=lambda x: (
                        x[0].total_daily_tasks + len(x[0].route) >= PREFERRED_DAILY_TASKS,  # Evita >= 4
                        x[0].total_daily_tasks + len(x[0].route),  # Totale task
                        -len(x[0].route),  # Più task LP (aggregazione)
                        x[2]  # Travel time
                    ))
                    chosen = preferred[0]
                else:
                    # Stesso per gli altri
                    others.sort(key=lambda x: (
                        x[0].total_daily_tasks + len(x[0].route) >= PREFERRED_DAILY_TASKS,
                        x[0].total_daily_tasks + len(x[0].route),
                        -len(x[0].route),
                        x[2]
                    ))
                    chosen = others[0]

        cleaner, pos, travel = chosen
        cleaner.route.insert(pos, task)
        # Traccia il logistic_code come assegnato
        assigned_logistic_codes.add(task.logistic_code)

    return cleaners, unassigned


def build_output(cleaners: List[Cleaner], unassigned: List[Task], original_tasks: List[Task]) -> Dict[str, Any]:
    cleaners_with_tasks: List[Dict[str, Any]] = []

    for cl in cleaners:
        if not cl.route:
            continue

        # RIMOSSO: Non scartare più cleaner con 1 sola task
        # Ora accettiamo qualsiasi numero di task >= 1

        feasible, schedule = evaluate_route(cl, cl.route)
        if not feasible or not schedule:
            continue

        tasks_list: List[Dict[str, Any]] = []

        for idx, (t, (arr, start, fin)) in enumerate(zip(cl.route, schedule)):
            overall_seq = cl.last_sequence + idx + 1

            # Calcola travel_time
            if overall_seq == 1:
                travel_time = 0
            elif idx == 0 and cl.last_sequence >= 1:
                # Primo LP dopo EO/HP
                if cl.last_lat is not None and cl.last_lng is not None:
                    hop = travel_minutes(cl.last_lat, cl.last_lng, t.lat, t.lng,
                                       cl.last_address, t.address)
                    travel_time = int(round(hop))
                else:
                    travel_time = 0 if same_street(cl.last_address, t.address) else 12
            else:
                # Hop da LP precedente
                prev = cl.route[idx - 1]
                hop = travel_minutes(prev.lat, prev.lng, t.lat, t.lng, prev.address, t.address)
                travel_time = int(round(hop))

            # Gestisci logistic_code che può essere None, 'None' stringa, o un numero
            logistic_code_val = 0
            if t.logistic_code and str(t.logistic_code).lower() != 'none':
                try:
                    logistic_code_val = int(t.logistic_code)
                except (ValueError, TypeError):
                    logistic_code_val = 0

            start_time_str = min_to_hhmm(start)
            end_time_str = min_to_hhmm(fin)
            current_seq = overall_seq

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

            # Se non trovato, usa i dati del dataclass
            if not original_task_data:
                original_task_data = {
                    "task_id": str(t.task_id) if t.task_id else "0",
                    "logistic_code": logistic_code_val,
                    "address": t.address,
                    "lat": t.lat,
                    "lng": t.lng,
                    "cleaning_time": t.cleaning_time,
                }

            # Mantieni TUTTI gli attributi originali + aggiungi campi timeline
            task_for_timeline = {
                **original_task_data,  # Copia TUTTI i campi da containers.json
                # Aggiungi/sovrascrivi campi specifici della timeline
                "priority": "low_priority",
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
                    "automatic_assignment_lp"  # Aggiungi reason timeline
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

    # Usa la data passata come argomento da riga di comando
    if len(sys.argv) > 1:
        current_ref_date = sys.argv[1]
    else:
        from datetime import datetime
        current_ref_date = datetime.now().strftime("%Y-%m-%d")

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
                "1. LIMITE LP DINAMICO: (5 - task_già_assegnate) per cleaner",
                "   - Se cleaner ha 0 task EO+HP: può prendere max 2 task LP (base)",
                "   - Se cleaner ha 1 task EO+HP: può prendere fino a 4 task LP",
                "   - Se cleaner ha 2 task EO+HP: può prendere fino a 3 task LP",
                "   - Se cleaner ha 3 task EO+HP: può prendere fino a 2 task LP",
                "   - Se cleaner ha 4 task EO+HP: può prendere fino a 1 task LP",
                "2. LIMITE GIORNALIERO: Max 5 task totali (EO+HP+LP), preferibilmente 4",
                "3. RIMOSSO vincolo minimo 2 task: ora accetta anche 1 sola task LP",
                "4. Considera task EO e HP precedenti per calcolare il totale",
                "5. Favorisce cleaners con meno task totali (per rispettare limite 4)",
                "6. Straordinarie solo a premium cleaner, devono essere la prima task",
                "7. Premium task solo a premium cleaner",
                "8. Check-in strict: deve finire prima del check-in time (INFRANGIBILE)",
                "9. Vincolo orario: nessuna task deve finire dopo le 19:00",
                "10. Seed da EO e HP: disponibilità e posizione dall'ultima task",
                "11. FORMATORE: solo task type_apt A o B, massimo 2 task LP al giorno",
                "12. CROSS-CONTAINER: Favorisce vicinanza con task EO e HP già assegnate"
            ]
        }
    }


def main():
    if not INPUT_CONTAINERS.exists():
        raise SystemExit(f"Missing input file: {INPUT_CONTAINERS}")
    if not INPUT_CLEANERS.exists():
        raise SystemExit(f"Missing input file: {INPUT_CLEANERS}")

    # Usa la data passata come argomento da riga di comando
    if len(sys.argv) > 1:
        ref_date = sys.argv[1]
        print(f"📅 Usando data da argomento: {ref_date}")
    else:
        # Fallback: usa la data corrente
        from datetime import datetime
        ref_date = datetime.now().strftime("%Y-%m-%d")
        print(f"📅 Nessuna data specificata, usando: {ref_date}")

    cleaners = load_cleaners()
    seed_cleaners_from_assignments(cleaners)
    tasks = load_tasks()

    print(f"📋 Caricamento dati...")
    print(f"   - Cleaner disponibili: {len(cleaners)}")
    print(f"   - Task Low-Priority da assegnare: {len(tasks)}")

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

    existing = {}
    if timeline_path.exists():
        try:
            existing = json.loads(timeline_path.read_text(encoding="utf-8"))
            # Mantieni le assegnazioni esistenti non-LP (rimuovi quelle con task LP)
            if "cleaners_assignments" in existing:
                # Crea un set di cleaner_id che avranno nuove assegnazioni LP
                new_lp_cleaner_ids = set(c["cleaner"]["id"] for c in output["low_priority_tasks_assigned"])
                timeline_data["cleaners_assignments"] = [
                    c for c in existing.get("cleaners_assignments", [])
                    if c["cleaner"]["id"] not in new_lp_cleaner_ids or
                       not any(t.get("reasons") and "automatic_assignment_lp" in t.get("reasons", []) for t in c.get("tasks", []))
                ]
        except Exception as e:
            print(f"Errore nel caricare la timeline esistente: {e}")
            pass


    # Aggiungi le nuove assegnazioni LP organizzate per cleaner
    for cleaner_entry in output["low_priority_tasks_assigned"]:
        # Cerca se esiste già un'entry per questo cleaner
        existing_entry = None
        for entry in timeline_data["cleaners_assignments"]:
            if entry["cleaner"]["id"] == cleaner_entry["cleaner"]["id"]:
                existing_entry = entry
                break

        if existing_entry:
            # Aggiungi le task LP alle task esistenti
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
    # Conta i cleaners totali disponibili
    total_available_cleaners = len(cleaners)

    # Conta i cleaners effettivamente usati (con almeno una task)
    used_cleaners = len([c for c in timeline_data["cleaners_assignments"] if len(c.get("tasks", [])) > 0])

    timeline_data["metadata"]["last_updated"] = dt.now().isoformat()
    timeline_data["metadata"]["date"] = ref_date
    timeline_data["meta"]["total_cleaners"] = total_available_cleaners
    timeline_data["meta"]["used_cleaners"] = used_cleaners
    timeline_data["meta"]["assigned_tasks"] = sum(
        len(c.get("tasks", [])) for c in timeline_data["cleaners_assignments"]
    )

    # Scrivi il file timeline.json
    timeline_path.write_text(json.dumps(timeline_data, ensure_ascii=False, indent=2), encoding="utf-8")
    lp_count = sum(1 for c in timeline_data["cleaners_assignments"]
                   if any(t.get("reasons") and "automatic_assignment_lp" in t.get("reasons", []) for t in c.get("tasks", [])))
    print(f"✅ Aggiornato {timeline_path}")
    print(f"   - Cleaner con assegnazioni LP: {lp_count}")
    print(f"   - Totale task: {timeline_data['meta']['assigned_tasks']}")

    # SPOSTAMENTO: Rimuovi le task assegnate da containers.json
    containers_path = INPUT_CONTAINERS
    if containers_path.exists():
        containers_data = json.loads(containers_path.read_text(encoding="utf-8"))

        # Trova tutti i task_id assegnati (NON logistic_code per permettere duplicati)
        assigned_task_ids = set()
        for cleaner_entry in output["low_priority_tasks_assigned"]:
            for task in cleaner_entry.get("tasks", []):
                assigned_task_ids.add(int(task["task_id"]))

        # Rimuovi le task assegnate dal container low_priority usando task_id
        if "containers" in containers_data and "low_priority" in containers_data["containers"]:
            original_count = len(containers_data["containers"]["low_priority"]["tasks"])
            containers_data["containers"]["low_priority"]["tasks"] = [
                t for t in containers_data["containers"]["low_priority"]["tasks"]
                if int(t.get("task_id", 0)) not in assigned_task_ids
            ]
            new_count = len(containers_data["containers"]["low_priority"]["tasks"])
            containers_data["containers"]["low_priority"]["count"] = new_count

            # Aggiorna summary
            containers_data["summary"]["low_priority"] = new_count
            containers_data["summary"]["total_tasks"] = (
                containers_data["summary"].get("total_tasks", 0) - (original_count - new_count)
            )

            # Scrivi containers.json aggiornato
            containers_path.write_text(json.dumps(containers_data, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"✅ Rimosse {original_count - new_count} task da containers.json (low_priority) usando task_id")
            print(f"   - Task rimaste in low_priority: {new_count}")
            print(f"   💡 Task con logistic_code duplicati rimangono disponibili nei container")


if __name__ == "__main__":
    main()