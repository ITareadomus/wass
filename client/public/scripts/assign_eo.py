# -*- coding: utf-8 -*-
from __future__ import annotations
import json, math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path
from datetime import datetime
from task_validation import can_cleaner_handle_task, can_cleaner_handle_apartment, can_cleaner_handle_priority
from assign_utils import (
    NEARBY_TRAVEL_THRESHOLD, NEW_CLEANER_PENALTY_MIN, NEW_TRAINER_PENALTY_MIN,
    TARGET_MIN_LOAD_MIN, FAIRNESS_DELTA_HOURS, LOAD_WEIGHT,
    SAME_BUILDING_BONUS, ROLE_TRAINER_BONUS,
    cleaner_load_minutes, cleaner_load_hours, get_cleaners_for_eo
)

# =============================
# I/O paths
# =============================
BASE = Path(__file__).parent.parent / "data"
SETTINGS_PATH = BASE / "input" / "settings.json"

INPUT_CONTAINERS = BASE / "output" / "containers.json"
INPUT_CLEANERS = BASE / "cleaners" / "selected_cleaners.json"
OUTPUT_ASSIGN = BASE / "output" / "early_out_assignments.json"

# =============================
# CONFIG - REGOLE CLUSTERING OTTIMIZZATE
# =============================
BASE_MAX_TASKS = 2  # Base: max 2 task per cleaner
CLUSTER_PRIORITY_TRAVEL = 5.0  # Cluster prioritario: <= 5' (massima priorità)
CLUSTER_EXTENDED_TRAVEL = 10.0  # Cluster esteso: <= 10' (infrange limiti tipologia)
ABSOLUTE_MAX_TASKS = 4  # Max assoluto 4 task
ABSOLUTE_MAX_TASKS_IF_BEFORE_18 = 5  # Max 5 task se finisce entro le 18:00
DAILY_TASK_LIMIT = 5  # Limite giornaliero HARD

# NUOVO: Limite per tipologia FLESSIBILE (può essere infranto da cluster)
MAX_TASKS_PER_PRIORITY = 2  # Max 2 task Early-Out per cleaner (base, infrangibile da cluster vicini)

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

# NUOVO: Configurazione zona geografica
ZONE_RADIUS_KM = 0.8 # Raggio per definire una "zona" (circa 1 km)


@dataclass
class Task:
    task_id: str
    logistic_code: str
    lat: float
    lng: float
    cleaning_time: int
    checkout_time: int
    checkin_time: int
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
    home_lat: Optional[float] = None
    home_lng: Optional[float] = None
    start_time: str = "10:00"
    route: List[Task] = field(default_factory=list)


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

def is_nearby_same_block(t1: Task, t2: Task) -> bool:
    """
    True se:
    - stesso edificio/via (same_building)
    OPPURE
    - stesso cliente/alias e travel_minutes <= NEARBY_TRAVEL_THRESHOLD

    Serve per clusterizzare casi tipo 618/619 (EXP) o 1537/1236 (TBR).
    """
    # stesso edificio/via
    if same_building(t1.address, t2.address):
        return True

    # stesso cliente (vari modi)
    same_client = (
        getattr(t1, 'client_id', None) == getattr(t2, 'client_id', None)
        or getattr(t1, 'customer_name', None) == getattr(t2, 'customer_name', None)
        or getattr(t1, 'alias', None) == getattr(t2, 'alias', None)
    )
    if not same_client:
        return False

    # vicini in termini di viaggio
    if travel_minutes(t1, t2) <= NEARBY_TRAVEL_THRESHOLD:
        return True

    return False


def same_zone(a: Optional["Task"], b: Optional["Task"]) -> bool:
    """
    Due task sono nella stessa 'zona' se:
    - stesso edificio, oppure
    - stessa via, oppure
    - distanza geografica <= ZONE_RADIUS_KM
    """
    if a is None or b is None:
        return False

    # stesso edificio o stessa via = stessa zona
    if same_building(a.address, b.address):
        return True
    if same_street(a.address, b.address):
        return True

    try:
        km = haversine_km(a.lat, a.lng, b.lat, b.lng)
    except Exception:
        return False

    return km <= ZONE_RADIUS_KM


# === CALCOLO DISTANZE E TEMPI ===
def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(dl / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


def travel_minutes(a: Optional[Task], b: Optional[Task]) -> float:
    """
    Modello realistico Milano urbano:
    - Percorsi non rettilinei (1.5x haversine)
    - Velocità variabile per distanza
    - Tempo base preparazione
    """
    if a is None or b is None:
        return 0.0

    # Stesso edificio: 3 minuti per cambio appartamento
    # (raccolta attrezzature, scale/ascensore, spostamento)
    if same_building(a.address, b.address):
        return 3.0

    km = haversine_km(a.lat, a.lng, b.lat, b.lng)

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

    # Penalità small_equipment
    if getattr(a, "small_equipment", False) or getattr(b, "small_equipment", False):
        total_time += (EQ_EXTRA_LT05 if km < 0.5 else EQ_EXTRA_GE05)

    # Bonus stesso strada (riduce tempo base)
    if same_street(a.address, b.address) and km < 0.10:
        total_time = max(total_time - 2.0, MIN_TRAVEL)

    return max(MIN_TRAVEL, min(MAX_TRAVEL, total_time))


def can_handle_premium(cleaner: Cleaner, task: Task) -> bool:
    # Premium task requires premium cleaner
    if task.is_premium and not cleaner.is_premium:
        return False
    # Straordinaria requires cleaner with can_do_straordinaria=True
    if task.straordinaria and not cleaner.can_do_straordinaria:
        return False
    return True


# -------- Schedulazione / costo --------
def evaluate_route(route: List[Task], cleaner_start_time_min: Optional[int] = None) -> Tuple[bool, List[Tuple[int, int, int]]]:
    """
    Valuta se una route è fattibile e ritorna lo schedule.
    Ritorna: (is_feasible, schedule)

    Args:
        route: Lista di task da valutare
        cleaner_start_time_min: Start time del cleaner in minuti (per straordinarie)
    """
    if not route:
        return True, []

    # Orario massimo di fine task: 19:00 (1140 minuti da mezzanotte)
    MAX_END_TIME = 19 * 60  # 19:00 in minuti

    schedule: List[Tuple[int, int, int]] = []
    prev: Optional[Task] = None

    # Per straordinarie: usa lo start_time del cleaner come base
    if cleaner_start_time_min is not None and route and route[0].straordinaria:
        cur = float(cleaner_start_time_min)
    else:
        cur = 0.0

    for i, t in enumerate(route):
        tt = travel_minutes(prev, t)
        cur += tt
        arrival = cur

        # LOGICA STRAORDINARIE vs EO NORMALE:
        # - STRAORDINARIE: iniziano allo start_time del cleaner (se fornito)
        #   oppure al checkout_time se successivo
        # - EO NORMALE: rispetta vincolo eo_start_time (10:00) e checkout_time

        if t.straordinaria:
            # STRAORDINARIE: iniziano allo start_time del cleaner
            # ma rispettano il checkout_time se successivo
            start = max(arrival, t.checkout_time)
            cur = start
        else:
            # EO NORMALE: start_time NON può MAI essere prima del checkout_time
            wait = max(0.0, t.checkout_time - arrival)
            cur += wait
            start = cur

        finish = start + t.cleaning_time

        # Check-in strict: applica SOLO se il check-in è lo stesso giorno del checkout
        if hasattr(t, "checkin_dt") and t.checkin_dt and hasattr(t, "checkout_dt") and t.checkout_dt:
            same_day = t.checkin_dt.date() == t.checkout_dt.date()
            if same_day:
                effective_checkin_limit = t.checkin_dt.hour * 60 + t.checkin_dt.minute
                if finish > effective_checkin_limit:
                    return False, []
        elif hasattr(t, "checkin_dt") and t.checkin_dt:
            # Fallback: se non c'è checkout_dt, assume stesso giorno
            effective_checkin_limit = t.checkin_dt.hour * 60 + t.checkin_dt.minute
            if finish > effective_checkin_limit:
                return False, []

        # Vincolo orario: nessuna task deve finire dopo le 19:00
        if finish > MAX_END_TIME:
            return False, []


        schedule.append((int(arrival), int(start), int(finish)))
        prev = t
        cur = finish

    return True, schedule


def can_add_task(cleaner: Cleaner, task: Task) -> bool:
    """
    Verifica se è possibile aggiungere una task al cleaner secondo le regole:
    1. Premium task -> premium cleaner
    2. Straordinaria -> premium cleaner, deve essere la prima (pos=0)
    3. CLUSTERING: appartamenti vicini (≤10') possono infrangere limiti tipologia
    4. Stessa via o ≤5': massima priorità cluster
    5. Limite giornaliero: max 5 task totali
    """
    # Check premium/straordinaria
    if not can_handle_premium(cleaner, task):
        return False

    # NUOVO: Check tipo appartamento
    if not can_cleaner_handle_apartment(cleaner.role, task.apt_type):
        return False

    current_count = len(cleaner.route)

    # Limite giornaliero HARD: max 5 task
    if current_count >= DAILY_TASK_LIMIT:
        return False

    # Straordinaria deve essere la prima
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
            (travel_minutes(existing_task, task) <= CLUSTER_PRIORITY_TRAVEL or
             travel_minutes(task, existing_task) <= CLUSTER_PRIORITY_TRAVEL or
             same_street(existing_task.address, task.address))
            for existing_task in cleaner.route
        )

        # Cluster esteso: ≤10' (infrange limite tipologia)
        is_extended_cluster = any(
            (travel_minutes(existing_task, task) <= CLUSTER_EXTENDED_TRAVEL or
             travel_minutes(task, existing_task) <= CLUSTER_EXTENDED_TRAVEL)
            for existing_task in cleaner.route
        )

        # NUOVO: Cluster geografico
        is_geo_cluster = any(same_zone(existing_task, task) for existing_task in cleaner.route)

        # Se è in cluster prioritario o geografico: ignora limiti tipologia, rispetta SEMPRE limite giornaliero
        if is_priority_cluster or is_geo_cluster:
            # Verifica limite giornaliero HARD
            if current_count >= DAILY_TASK_LIMIT:
                return False
            # Verifica max assoluto (anche se in cluster)
            if current_count >= ABSOLUTE_MAX_TASKS:
                return False
            return True

        # Se è in cluster esteso: ignora limite tipologia, rispetta limiti giornaliero e max assoluto
        if is_extended_cluster:
            # Verifica limite giornaliero HARD
            if current_count >= DAILY_TASK_LIMIT:
                return False
            # Verifica max assoluto
            if current_count >= ABSOLUTE_MAX_TASKS:
                return False
            return True

    # Regola base: max 2 task
    if current_count < BASE_MAX_TASKS:
        return True

    # 3ª-5ª task: solo se fattibile temporalmente
    if current_count >= BASE_MAX_TASKS and current_count < ABSOLUTE_MAX_TASKS:
        test_route = cleaner.route + [task]
        cleaner_start_min = hhmm_to_min(cleaner.start_time) if hasattr(cleaner, 'start_time') and cleaner.start_time else None
        feasible, schedule = evaluate_route(test_route, cleaner_start_min)
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

    # Ottieni lo start_time del cleaner in minuti
    cleaner_start_min = hhmm_to_min(cleaner.start_time) if hasattr(cleaner, 'start_time') and cleaner.start_time else None

    # Straordinaria deve andare per forza in pos 0
    if task.straordinaria:
        test_route = [task] + cleaner.route
        feasible, _ = evaluate_route(test_route, cleaner_start_min)
        if feasible:
            return (0, 0.0)
        else:
            return None

    # Prova tutte le posizioni possibili
    for pos in range(len(cleaner.route) + 1):
        test_route = cleaner.route[:pos] + [task] + cleaner.route[pos:]
        feasible, _ = evaluate_route(test_route, cleaner_start_min)

        if not feasible:
            continue

        # Calcola il tempo di viaggio max generato da questo inserimento
        prev_task = cleaner.route[pos - 1] if pos > 0 else None
        next_task = cleaner.route[pos] if pos < len(cleaner.route) else None

        travel_to = travel_minutes(prev_task, task) if prev_task else 0.0
        travel_from = travel_minutes(task, next_task) if next_task else 0.0
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
    all_cleaners: List[Cleaner] = []
    for c in data.get("cleaners", []):
        role = (c.get("role") or "").strip()
        is_premium = bool(c.get("premium", (role.lower() == "premium")))
        can_do_straordinaria = bool(c.get("can_do_straordinaria", False))

        # NUOVO: Valida se il cleaner può gestire Early-Out basandosi su settings.json
        if not can_cleaner_handle_priority(role, "early_out"):
            print(f"   ⏭️  Cleaner {c.get('name')} ({role}) escluso da Early-Out (priority_types settings)")
            continue

        cleaner = Cleaner(
            id=c.get("id"),
            name=c.get("name") or str(c.get("id")),
            lastname=c.get("lastname", ""),
            role=role or ("Premium" if is_premium else "Standard"),
            is_premium=is_premium,
            can_do_straordinaria=can_do_straordinaria,
            home_lat=c.get("home_lat"),
            home_lng=c.get("home_lng"),
        )
        # Aggiungi start_time al cleaner per il filtro
        cleaner.start_time = c.get("start_time", "10:00")
        all_cleaners.append(cleaner)

    # Filtra usando get_cleaners_for_eo (esclude start_time >= 11:00)
    cleaners = get_cleaners_for_eo(all_cleaners)

    excluded_count = len(all_cleaners) - len(cleaners)
    if excluded_count > 0:
        print(f"   ⏭️  {excluded_count} cleaner(s) esclusi da EO per start_time >= 11:00")

    return cleaners


def load_tasks() -> List[Task]:
    data = json.loads(INPUT_CONTAINERS.read_text(encoding="utf-8"))

    # Carica settings per leggere eo_start_time dinamicamente
    try:
        settings = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except Exception:
        settings = {}

    early_out_cfg = settings.get("early-out", {}) if isinstance(settings, dict) else {}
    eo_start_str = early_out_cfg.get("eo_start_time") or "10:00"
    eo_start_min = hhmm_to_min(eo_start_str, default="10:00")
    tasks: List[Task] = []
    for t in data.get("containers", {}).get("early_out", {}).get("tasks", []):
        # Checkout reale dell'appartamento (in minuti)
        real_checkout_min = hhmm_to_min(t.get("checkout_time"), default=eo_start_str)

        # Il vincolo effettivo è il massimo tra EO start e checkout reale
        checkout = max(eo_start_min, real_checkout_min)

        checkin = hhmm_to_min(t.get("checkin_time"), default="23:59")

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
                cleaning_time=int(t.get("cleaning_time") or 45),
                checkout_time=checkout,
                checkin_time=checkin,
                is_premium=bool(t.get("premium", False)),
                checkin_dt=checkin_dt,
                checkout_dt=checkout_dt,
                apt_type=t.get("type_apt"),
                address=t.get("address"),
                alias=t.get("alias"),
                small_equipment=bool(t.get("small_equipment", False)),
                straordinaria=bool(t.get("straordinaria", False)),
            ))

    # Ordina: straordinarie first, poi premium, poi per checkout
    tasks.sort(key=lambda x: (not x.straordinaria, not x.is_premium, x.checkout_time))
    return tasks


# -------- Planner --------
def plan_day(
    tasks: List[Task],
    cleaners: List[Cleaner],
    assigned_logistic_codes: set = None,
) -> Tuple[List[Cleaner], List[Task]]:
    """
    Assegna le task Early-Out con:
    - STRAORDINARIE: possono iniziare prima delle 10:00, assegnate al cleaner
      con start_time minore che ha can_do_straordinaria=True
    - HARD CLUSTER edificio/via o "stesso blocco" (same_building + is_nearby_same_block)
    - FAIRNESS: evita che un cleaner abbia molte più task degli altri,
      ignorando i cleaner vuoti (non forziamo a usarli per forza)
    - TARGET MINIMO 3 TASK: se possibile, favorisce cleaner con 1–2 task
      prima di aumentare ancora chi ne ha già 4.

    Usa:
      - find_best_position(cleaner, task) -> (pos, travel) o None
      - same_building(address, address)
      - is_nearby_same_block(t1, t2)
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

            # Trova cleaner con start_time minore
            earliest_cleaner = min(straordinaria_cleaners, key=lambda c: hhmm_to_min(getattr(c, 'start_time', '10:00') if isinstance(getattr(c, 'start_time', None), str) else '10:00'))

            # Verifica se può prendere la task (pos 0 FORZATO)
            result = find_best_position(earliest_cleaner, task)
            if result is None:
                unassigned.append(task)
                continue

            # STRAORDINARIA: SEMPRE in posizione 0, ignora result[0]
            earliest_cleaner.route.insert(0, task)
            assigned_logistic_codes.add(task.logistic_code)
            
            # CRITICO: Marca la straordinaria per preservare la posizione
            task._is_straordinaria_first = True
            continue

    for task in tasks:
        # dedup su logistic_code cross-container
        if task.logistic_code in assigned_logistic_codes:
            unassigned.append(task)
            continue

        candidates: List[Tuple[Cleaner, int, float]] = []

        # 1) Trova tutti i cleaner che POSSONO prendere la task (vincoli gestiti da find_best_position)
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

        # HARD CLUSTER edificio/via/blocco: stesso edificio o vicino + stesso cliente
        building_candidates: List[Tuple[Cleaner, int, float]] = []
        for c, p, t_travel in candidates:
            if c.route and any(
                same_building(ex.address, task.address) or is_nearby_same_block(ex, task)
                for ex in c.route
            ):
                building_candidates.append((c, p, t_travel))

        if building_candidates:
            pool = building_candidates
            effective_load_weight = max(LOAD_WEIGHT - 3, 1)  # cluster: carico pesa un po' meno
        else:
            # ---------------------------------------------------------
            # 3) FAIRNESS basata sulle ore, ignora cleaner vuoti
            # ---------------------------------------------------------
            loads_for_fairness: List[float] = []
            for (c, _, _) in candidates:
                load_h = cleaner_load_hours(c)
                if load_h > 0.0:
                    loads_for_fairness.append(load_h)

            if loads_for_fairness:
                min_load_h = min(loads_for_fairness)
            else:
                # tutti vuoti -> niente fairness, andiamo di travel+cluster
                min_load_h = 0.0

            fair_candidates: List[Tuple[Cleaner, int, float]] = []
            for (c, p, t_travel) in candidates:
                load_h = cleaner_load_hours(c)
                # consideriamo fair chi ha già qualcosa e non è troppo sopra il minimo
                if load_h > 0.0 and load_h <= min_load_h + FAIRNESS_DELTA_HOURS:
                    fair_candidates.append((c, p, t_travel))

            pool = fair_candidates or candidates
            effective_load_weight = LOAD_WEIGHT

        # -------------------------------------------------------------
        # 4) TARGET MINIMO DI CARICO (≈ 3 ore)
        # -------------------------------------------------------------
        low_load_candidates: List[Tuple[Cleaner, int, float]] = [
            (c, p, t_travel)
            for (c, p, t_travel) in pool
            if cleaner_load_minutes(c) < TARGET_MIN_LOAD_MIN
        ]

        if low_load_candidates:
            pool = low_load_candidates

        # -------------------------------------------------------------
        # 5) Scelta finale con ore + penalità attivazione
        # -------------------------------------------------------------
        best_choice: Optional[Tuple[Cleaner, int, float]] = None
        best_score: Optional[float] = None

        for c, p, t_travel in pool:
            load_h = cleaner_load_hours(c)

            # bonus cluster soft (anche fuori dal cluster duro)
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

        # Per Early-Out accettiamo anche 1 sola task (task urgenti)
        # Nessun vincolo minimo qui

        cleaner_start_min = hhmm_to_min(cl.start_time) if hasattr(cl, 'start_time') and cl.start_time else None
        feasible, schedule = evaluate_route(cl.route, cleaner_start_min)
        if not feasible or not schedule:
            continue

        tasks_list: List[Dict[str, Any]] = []
        prev_finish_time = None

        for idx, (t, (arr, start, fin)) in enumerate(zip(cl.route, schedule)):
            travel_time = 0
            if idx > 0 and prev_finish_time is not None:
                travel_time = arr - prev_finish_time

            # Carica i dati originali completi della task da containers.json
            containers_data = json.loads(INPUT_CONTAINERS.read_text(encoding="utf-8"))
            original_task_data = None

            # Cerca la task nei containers
            for container_type in ['early_out', 'high_priority', 'low_priority']:
                container = containers_data.get('containers', {}).get(container_type, {})
                for task_data in container.get('tasks', []):
                    if str(task_data.get('task_id')) == str(t.task_id) or str(task_data.get('logistic_code')) == str(t.logistic_code):
                        original_task_data = task_data
                        break
                if original_task_data:
                    break

            # Se non trovato nei containers, usa i dati del dataclass
            if not original_task_data:
                original_task_data = {field.name: getattr(t, field.name) for field in Task.__dataclass_fields__.values()}

            start_time_str = min_to_hhmm(start)
            end_time_str = min_to_hhmm(fin)

            # Mantieni TUTTI gli attributi originali + aggiungi campi timeline
            task_for_timeline = {
                **original_task_data,  # Copia TUTTI i campi da containers.json
                # Aggiungi/sovrascrivi campi specifici della timeline
                "priority": "early_out", # <-- Modifica: aggiungi priority
                "start_time": start_time_str,
                "end_time": end_time_str,
                "followup": idx > 0,
                "sequence": idx + 1,
                "travel_time": travel_time,
                # Normalizza ESPLICITAMENTE i campi straordinaria e premium
                "straordinaria": bool(original_task_data.get("straordinaria", False) or original_task_data.get("is_straordinaria", False)),
                "premium": bool(original_task_data.get("premium", False)),
                "reasons": [
                    *(original_task_data.get("reasons", [])),  # Mantieni reasons originali
                    "automatic_assignment_eo"  # Aggiungi reason timeline
                ]
            }

            tasks_list.append(task_for_timeline)
            prev_finish_time = fin

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
                "address": ot.address,
                "premium": ot.is_premium,
                "straordinaria": ot.straordinaria,
                "cleaning_time": ot.cleaning_time,
                "checkout_time": min_to_hhmm(ot.checkout_time),
                "checkin_time": min_to_hhmm(ot.checkin_time),
                "alias": ot.alias,
                "apt_type": ot.apt_type,
                "reason": "no feasible assignment under simplified rules"
            })

    total_assigned = sum(len(c["tasks"]) for c in cleaners_with_tasks)

    # Usa la data passata come argomento da riga di comando
    import sys
    if len(sys.argv) > 1:
        ref_date = sys.argv[1]
    else:
        from datetime import datetime
        ref_date = datetime.now().strftime("%Y-%m-%d")

    return {
        "early_out_tasks_assigned": cleaners_with_tasks,
        "unassigned_tasks": unassigned_list,
        "current_date": ref_date,
        "meta": {
            "total_tasks": len(original_tasks),
            "assigned": total_assigned,
            "unassigned": len(original_tasks) - total_assigned,
            "cleaners_used": len(cleaners_with_tasks),
            "max_tasks_per_cleaner": 3,
            "algorithm": "simplified_greedy",
            "notes": [
                "REGOLE EARLY-OUT OTTIMIZZATE:",
                "1. Max 2 task EO per cleaner (3 se travel <= 10' o stessa zona)",
                "2. NO vincolo minimo task (può assegnare anche 1 sola task)",
                "3. Favorisce distribuzione: meglio 1 task per cleaner che aggregare",
                "4. Cluster esteso a 15' (favorisce aggregazione quando possibile)",
                "5. Straordinarie solo a premium cleaner, devono essere la prima task",
                "6. Premium task solo a premium cleaner",
                "7. Check-in strict: deve finire prima del check-in time (INFRANGIBILE)",
                "8. Vincolo orario: nessuna task deve finire dopo le 19:00",
                "9. CROSS-CONTAINER: Favorisce vicinanza geografica anche tra container diversi"
            ]
        }
    }


def main():
    if not INPUT_CONTAINERS.exists():
        raise SystemExit(f"Missing input file: {INPUT_CONTAINERS}")
    if not INPUT_CLEANERS.exists():
        raise SystemExit(f"Missing input file: {INPUT_CLEANERS}")

    cleaners = load_cleaners()
    tasks = load_tasks()

    print(f"📋 Caricamento dati...")
    print(f"   - Cleaner disponibili: {len(cleaners)}")
    print(f"   - Task Early-Out da assegnare: {len(tasks)}")

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
                print(f"   - Logistic codes già assegnati in timeline: {len(assigned_logistic_codes)}")
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

    # Usa la data passata come argomento da riga di comando
    import sys
    if len(sys.argv) > 1:
        ref_date = sys.argv[1]
    else:
        from datetime import datetime
        ref_date = datetime.now().strftime("%Y-%m-%d")
        print(f"📅 Nessuna data specificata, usando: {ref_date}")

    # Update timeline.json con struttura organizzata per cleaner
    from datetime import datetime as dt
    timeline_path = OUTPUT_ASSIGN.parent / "timeline.json"

    # Carica timeline esistente o crea nuova struttura
    timeline_data_output = {
        "metadata": {
            "last_updated": dt.now().isoformat(),
            "date": ref_date,
            "modification_type": "auto_assign_early_out" # <-- Aggiornato qui
        },
        "cleaners_assignments": [],
        "meta": {
            "total_cleaners": 0,
            "used_cleaners": 0,
            "assigned_tasks": 0
        }
    }

    if timeline_path.exists():
        try:
            existing = json.loads(timeline_path.read_text(encoding="utf-8"))
            # MANTIENI TUTTI i cleaner esistenti;
            # il filtraggio delle vecchie EO lo facciamo dentro il blocco existing_entry
            if "cleaners_assignments" in existing:
                timeline_data_output["cleaners_assignments"] = existing.get("cleaners_assignments", [])
        except Exception as e:
            print(f"⚠️ Errore nel caricamento della timeline esistente: {e}")

    # Aggiungi le nuove assegnazioni EO organizzate per cleaner
    for cleaner_entry in output["early_out_tasks_assigned"]:
        # Cerca se esiste già un'entry per questo cleaner (es. task spostate manualmente in timeline)
        existing_entry = None
        for entry in timeline_data_output["cleaners_assignments"]:
            try:
                if int(entry.get("cleaner", {}).get("id")) == int(cleaner_entry["cleaner"]["id"]):
                    existing_entry = entry
                    break
            except Exception:
                continue

        if existing_entry:
            # DEDUPLICA: filtra le nuove task che non sono già presenti (usando task_id)
            existing_task_ids = {
                int(t.get("task_id"))
                for t in existing_entry.get("tasks", [])
                if t.get("task_id") is not None
            }
            new_tasks_filtered = [
                t for t in cleaner_entry.get("tasks", [])
                if t.get("task_id") is not None
                and int(t.get("task_id")) not in existing_task_ids
            ]

            # Se non ci sono nuove task da aggiungere, passa oltre
            if not new_tasks_filtered:
                continue

            # Task già presenti per questo cleaner (manuali + EO esistenti)
            existing_entry_tasks = existing_entry.get("tasks", [])

            # --- 1) Trova l'ultimo orario di fine reale --------------------
            if existing_entry_tasks:
                # Ordina per end_time per trovare la vera ultima task in timeline
                existing_entry_tasks.sort(
                    key=lambda t: t.get("end_time", t.get("start_time", "00:00"))
                )
                last_task = existing_entry_tasks[-1]
                last_end_min = hhmm_to_min(
                    last_task.get("end_time")
                    or last_task.get("start_time")
                    or "00:00",
                    default="00:00",
                )
            else:
                # Nessuna task esistente: parti dallo start_time del cleaner
                cleaner_start = (
                    (existing_entry.get("cleaner") or {}).get("start_time")
                    or cleaner_entry["cleaner"].get("start_time")
                    or "10:00"
                )
                last_end_min = hhmm_to_min(cleaner_start, default="10:00")

            # --- 2) Punto di partenza per la sequence ----------------------
            if existing_entry_tasks:
                seq_start = max(
                    int(t.get("sequence") or idx + 1)
                    for idx, t in enumerate(existing_entry_tasks)
                )
            else:
                seq_start = 0

            # --- 3) Ricalcola orari delle nuove task ACCODATE -------------
            new_tasks_sorted = sorted(
                new_tasks_filtered,
                key=lambda t: t.get("start_time", "00:00"),
            )

            seq = seq_start
            prev_task_data = None
            
            # Se ci sono task esistenti, prendi l'ultima come riferimento per il travel time
            if existing_entry_tasks:
                last_existing = existing_entry_tasks[-1]
                prev_task_data = {
                    "lat": last_existing.get("lat"),
                    "lng": last_existing.get("lng"),
                    "address": last_existing.get("address")
                }
            
            for idx, t in enumerate(new_tasks_sorted):
                seq += 1

                # Evita sovrapposizioni: non puoi iniziare prima della fine della precedente
                proposed_start = t.get("start_time") or "00:00"
                start_min = max(
                    last_end_min,
                    hhmm_to_min(proposed_start, default="00:00"),
                )
                end_min = start_min + int(t.get("cleaning_time") or 0)

                # CRITICAL: Rispetta vincolo di check-in PRIMA di salvare gli orari
                checkin_time = t.get("checkin_time")
                checkin_date = t.get("checkin_date")
                checkout_date = t.get("checkout_date")
                
                if checkin_time and checkin_date and checkout_date:
                    # Verifica solo se check-in è lo stesso giorno del checkout
                    if checkin_date == checkout_date:
                        checkin_limit = hhmm_to_min(checkin_time, default="23:59")
                        if end_min > checkin_limit:
                            # Task non fattibile: salta e rimuovi dalla lista
                            print(
                                f"   ⚠️  Task EO {t.get('task_id')} scartata per cleaner {cleaner_entry['cleaner']['id']}: "
                                f"finirebbe alle {min_to_hhmm(end_min)} oltre il check-in {checkin_time}"
                            )
                            continue

                # Calcola travel_time dalla task precedente (esistente o nuova accodata)
                if idx == 0 and prev_task_data:
                    # Prima task accodata: calcola travel dalla ultima task esistente
                    try:
                        prev_lat = float(prev_task_data.get("lat", 0))
                        prev_lng = float(prev_task_data.get("lng", 0))
                        curr_lat = float(t.get("lat", 0))
                        curr_lng = float(t.get("lng", 0))
                        prev_addr = prev_task_data.get("address")
                        curr_addr = t.get("address")
                        
                        # Usa le funzioni di calcolo travel_time
                        travel = int(round(haversine_km(prev_lat, prev_lng, curr_lat, curr_lng) * 12))  # Approssimazione
                        if same_building(prev_addr, curr_addr):
                            travel = 3
                        elif same_street(prev_addr, curr_addr):
                            travel = max(travel - 2, 2)
                    except Exception:
                        travel = max(0, start_min - last_end_min)
                elif idx > 0:
                    # Task successive: calcola dalla task accodata precedente
                    try:
                        prev_new_task = new_tasks_sorted[idx - 1]
                        prev_lat = float(prev_new_task.get("lat", 0))
                        prev_lng = float(prev_new_task.get("lng", 0))
                        curr_lat = float(t.get("lat", 0))
                        curr_lng = float(t.get("lng", 0))
                        prev_addr = prev_new_task.get("address")
                        curr_addr = t.get("address")
                        
                        travel = int(round(haversine_km(prev_lat, prev_lng, curr_lat, curr_lng) * 12))
                        if same_building(prev_addr, curr_addr):
                            travel = 3
                        elif same_street(prev_addr, curr_addr):
                            travel = max(travel - 2, 2)
                    except Exception:
                        travel = max(0, start_min - last_end_min)
                else:
                    # Nessuna task precedente
                    travel = 0

                # CRITICAL: Verifica check-in PRIMA di salvare gli orari
                checkin_time = t.get("checkin_time")
                checkin_date = t.get("checkin_date")
                checkout_date = t.get("checkout_date")
                
                if checkin_time and checkin_date and checkout_date:
                    # Verifica solo se check-in è lo stesso giorno del checkout
                    if checkin_date == checkout_date:
                        checkin_limit = hhmm_to_min(checkin_time, default="23:59")
                        if end_min > checkin_limit:
                            # Task non fattibile: salta e rimuovi dalla lista
                            print(
                                f"   ⚠️  Task EO {t.get('task_id')} scartata per cleaner {cleaner_entry['cleaner']['id']}: "
                                f"finirebbe alle {min_to_hhmm(end_min)} oltre il check-in {checkin_time}"
                            )
                            continue

                # Aggiorna orari e sequence nel formato timeline
                t["start_time"] = min_to_hhmm(start_min)
                t["end_time"] = min_to_hhmm(end_min)
                t["travel_time"] = travel
                t["sequence"] = seq

                # Aggiorna "ultimo fine" e aggiungi alla lista del cleaner
                last_end_min = end_min
                existing_entry_tasks.append(t)

            # --- 4) Ordina tutte le task per start_time e riallinea sequence
            # CRITICO: Se c'è una straordinaria, DEVE rimanere in posizione 0
            has_straordinaria = any(t.get("straordinaria") for t in existing_entry_tasks)
            
            if has_straordinaria:
                # Separa straordinaria dalle altre
                straordinaria_tasks = [t for t in existing_entry_tasks if t.get("straordinaria")]
                other_tasks = [t for t in existing_entry_tasks if not t.get("straordinaria")]
                
                # Ordina solo le altre task
                other_tasks.sort(key=lambda t: t.get("start_time", "00:00"))
                
                # Ricomponi: straordinarie SEMPRE per prime
                existing_entry_tasks = straordinaria_tasks + other_tasks
            else:
                # Nessuna straordinaria: ordina normalmente
                existing_entry_tasks.sort(key=lambda t: t.get("start_time", "00:00"))
            
            # Riallinea sequence
            for idx, t in enumerate(existing_entry_tasks, start=1):
                t["sequence"] = idx

            existing_entry["tasks"] = existing_entry_tasks

            # Log per debug
            if len(cleaner_entry.get("tasks", [])) > len(new_tasks_filtered):
                skipped = len(cleaner_entry.get("tasks", [])) - len(new_tasks_filtered)
                print(
                    f"   ⏭️  Saltate {skipped} task duplicate per cleaner {cleaner_entry['cleaner']['id']}"
                )
        else:
            # Nessuna entry per questo cleaner: crea un nuovo blocco
            timeline_data_output["cleaners_assignments"].append({
                "cleaner": cleaner_entry["cleaner"],
                "tasks": cleaner_entry["tasks"],
            })

    # Aggiorna meta
    # Conta i cleaner totali disponibili
    total_available_cleaners = len(cleaners)

    # Conta i cleaner effettivamente usati (con almeno una task)
    used_cleaners_count = len([c for c in timeline_data_output["cleaners_assignments"] if len(c.get("tasks", [])) > 0])

    # Conta le task totali assegnate
    total_assigned_tasks = sum(len(c["tasks"]) for c in timeline_data_output["cleaners_assignments"])

    # Salva timeline.json
    timeline_data_output["meta"] = {
        "total_cleaners": total_available_cleaners,
        "used_cleaners": used_cleaners_count,
        "assigned_tasks": total_assigned_tasks
    }
    timeline_path.write_text(json.dumps(timeline_data_output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"✅ Timeline aggiornata: {timeline_path}")

    # Conta i cleaner con task di ogni tipo basandosi sui reasons
    eo_count = len([c for c in timeline_data_output["cleaners_assignments"]
                   if any(t.get("reasons") and "automatic_assignment_eo" in t.get("reasons", []) for t in c.get("tasks", []))])
    hp_count = len([c for c in timeline_data_output["cleaners_assignments"]
                   if any(t.get("reasons") and "automatic_assignment_hp" in t.get("reasons", []) for t in c.get("tasks", []))])
    lp_count = len([c for c in timeline_data_output["cleaners_assignments"]
                   if any(t.get("reasons") and "automatic_assignment_lp" in t.get("reasons", []) for t in c.get("tasks", []))])

    print(f"   - Cleaner con assegnazioni EO: {eo_count}")
    print(f"   - Cleaner con assegnazioni HP: {hp_count}")
    print(f"   - Cleaner con assegnazioni LP: {lp_count}")
    print(f"   - Totale task assegnate: {timeline_data_output['meta']['assigned_tasks']}")

    # SPOSTAMENTO: Rimuovi le task assegnate da containers.json
    containers_path = INPUT_CONTAINERS
    if containers_path.exists():
        try:
            containers_data = json.loads(containers_path.read_text(encoding="utf-8"))

            # Trova tutti i task_id assegnati (NON logistic_code per permettere duplicati)
            assigned_task_ids = set()
            for cleaner_entry in output["early_out_tasks_assigned"]:
                for task in cleaner_entry.get("tasks", []):
                    assigned_task_ids.add(int(task["task_id"]))

            # Rimuovi le task assegnate dal container early_out usando task_id
            if "containers" in containers_data and "early_out" in containers_data["containers"]:
                original_count = len(containers_data["containers"]["early_out"]["tasks"])
                containers_data["containers"]["early_out"]["tasks"] = [
                    t for t in containers_data["containers"]["early_out"]["tasks"]
                    if int(t.get("task_id", 0)) not in assigned_task_ids
                ]
                new_count = len(containers_data["containers"]["early_out"]["tasks"])
                containers_data["containers"]["early_out"]["count"] = new_count

                # Aggiorna summary
                containers_data["summary"]["early_out"] = new_count
                containers_data["summary"]["total_tasks"] = (
                    containers_data["summary"].get("total_tasks", 0) - (original_count - new_count)
                )

                # Scrivi containers.json aggiornato
                containers_path.write_text(json.dumps(containers_data, ensure_ascii=False, indent=2), encoding="utf-8")
                print(f"✅ Rimosse {original_count - new_count} task da containers.json (early_out) usando task_id")
                print(f"   - Task rimaste in early_out: {new_count}")
                print(f"   💡 Task con logistic_code duplicati rimangono disponibili nei container")
        except Exception as e:
            print(f"⚠️ Errore durante la rimozione delle task da containers.json: {e}")


if __name__ == "__main__":
    main()