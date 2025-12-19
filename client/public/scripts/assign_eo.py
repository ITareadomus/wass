# -*- coding: utf-8 -*-
from __future__ import annotations
import json, math, argparse
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

# API Client import (opzionale, con fallback)
try:
    from api_client import ApiClient
    API_AVAILABLE = True
except ImportError:
    API_AVAILABLE = False

# =============================
# I/O paths
# =============================
BASE = Path(__file__).parent.parent / "data"
SETTINGS_PATH = BASE / "input" / "settings.json"

INPUT_CONTAINERS = BASE / "output" / "containers.json"
INPUT_CLEANERS = BASE / "cleaners" / "selected_cleaners.json"
OUTPUT_ASSIGN = BASE / "output" / "early_out_assignments.json"

# Variabile globale per la data di lavoro e modalità API
WORK_DATE: Optional[str] = None
USE_API: bool = False

# Variabili globali per EO settings (caricate da API)
EO_START_TIME_MIN: Optional[int] = None  # Orario minimo inizio task EO (in minuti)
EO_END_TIME_MIN: Optional[int] = None    # Orario massimo inizio task EO (in minuti)

def load_eo_settings():
    """Carica eo_start_time e eo_end_time da settings via API."""
    global EO_START_TIME_MIN, EO_END_TIME_MIN
    
    if not API_AVAILABLE:
        print("   ⚠️ API non disponibile, uso default EO start 10:00, end 10:59")
        EO_START_TIME_MIN = 10 * 60  # 10:00
        EO_END_TIME_MIN = 10 * 60 + 59  # 10:59
        return
    
    try:
        from api_client import load_settings_from_api
        settings = load_settings_from_api()
        eo_config = settings.get("early-out", {})
        
        # Carica eo_start_time
        eo_start = eo_config.get("eo_start_time")
        if eo_start:
            if eo_start.count(':') == 2:
                eo_start = ':'.join(eo_start.split(':')[:2])
            parts = eo_start.split(':')
            if len(parts) >= 2:
                h, m = int(parts[0]), int(parts[1])
                EO_START_TIME_MIN = h * 60 + m
                print(f"   ✅ EO start time da settings: {h:02d}:{m:02d}")
        else:
            EO_START_TIME_MIN = 10 * 60
            print(f"   ℹ️ eo_start_time non trovato, uso default 10:00")
        
        # Carica eo_end_time (orario MAX in cui una task EO può INIZIARE)
        eo_end = eo_config.get("eo_end_time")
        if eo_end:
            if eo_end.count(':') == 2:
                eo_end = ':'.join(eo_end.split(':')[:2])
            parts = eo_end.split(':')
            if len(parts) >= 2:
                h, m = int(parts[0]), int(parts[1])
                EO_END_TIME_MIN = h * 60 + m
                print(f"   ✅ EO end time da settings: {h:02d}:{m:02d}")
        else:
            EO_END_TIME_MIN = 10 * 60 + 59  # 10:59
            print(f"   ℹ️ eo_end_time non trovato, uso default 10:59")
            
    except Exception as e:
        print(f"   ⚠️ Errore caricamento settings: {e}, uso default")
        EO_START_TIME_MIN = 10 * 60
        EO_END_TIME_MIN = 10 * 60 + 59

# =============================
# CONFIG - REGOLE CLUSTERING OTTIMIZZATE
# =============================
BASE_MAX_TASKS = 2  # Base: max 2 task per cleaner
CLUSTER_PRIORITY_TRAVEL = 5.0  # Cluster prioritario: <= 5' (massima priorità)
CLUSTER_EXTENDED_TRAVEL = 7.0  # Cluster esteso: <= 7' (da 10, infrange limiti tipologia)
ABSOLUTE_MAX_TASKS = 4  # Max assoluto 4 task
ABSOLUTE_MAX_TASKS_IF_BEFORE_18 = 5  # Max 5 task se finisce entro le 18:00
DAILY_TASK_LIMIT = 5  # Limite giornaliero HARD

# NUOVO: Limite per tipologia FLESSIBILE (può essere infranto da cluster)
MAX_TASKS_PER_PRIORITY = 2  # Max 2 task Early-Out per cleaner (base, infrangibile da cluster vicini)

PREFERRED_TRAVEL = 20.0  # Preferenza per percorsi < 20'

# =============================
# CONFIG - PROPOSTA A: EO_END SOFT + GERARCHIA VICINANZA
# =============================
NEAR_TRAVEL_MIN = 15.0  # Soglia "vicino" in minuti di viaggio
EO_GRACE_MAX_OVER_MIN = 20  # Max sforamento oltre EO_END_TIME in minuti (grace period)
MAX_TASKS_IF_NEAR = 2  # Max task se vicinanza è solo travel-time ≤ 15'
MAX_TASKS_IF_STREET_OR_BUILDING = 3  # Max task se stessa via o stesso edificio

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


def proximity_rank(a: Task, b: Task) -> int:
    """
    Calcola il rank di vicinanza tra due task.
    Ritorna:
        3 = stesso edificio (vicinissimo)
        2 = stessa via (più vicino)
        1 = travel_time <= NEAR_TRAVEL_MIN (vicino)
        0 = lontano
    """
    if same_building(a.address, b.address):
        return 3
    if same_street(a.address, b.address):
        return 2
    if travel_minutes(a, b) <= NEAR_TRAVEL_MIN:
        return 1
    return 0


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


def travel_minutes_raw(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """
    Calcola travel time tra due coordinate (versione raw senza oggetti Task).
    Modello realistico Milano urbano.
    """
    km = haversine_km(lat1, lng1, lat2, lng2)
    
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
    
    return max(MIN_TRAVEL, min(MAX_TRAVEL, total_time))


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
    # Premium task requires premium cleaner (role = "Premium")
    if task.is_premium and cleaner.role.lower() != "premium":
        return False
    # Straordinaria requires cleaner with can_do_straordinaria=True
    if task.straordinaria and not cleaner.can_do_straordinaria:
        return False
    return True


# -------- Schedulazione / costo --------
def evaluate_route(route: List[Task]) -> Tuple[bool, List[Tuple[int, int, int]]]:
    """
    Valuta se una route è fattibile e ritorna lo schedule.
    Ritorna: (is_feasible, schedule)
    """
    if not route:
        return True, []

    # Orario massimo di fine task: 19:00 (1140 minuti da mezzanotte)
    MAX_END_TIME = 19 * 60  # 19:00 in minuti

    schedule: List[Tuple[int, int, int]] = []
    prev: Optional[Task] = None
    cur = 0.0

    for i, t in enumerate(route):
        tt = travel_minutes(prev, t)
        cur += tt
        arrival = cur

        # LOGICA STRAORDINARIE vs EO NORMALE:
        # - STRAORDINARIE: 3 casistiche
        #   1. Orari non migrati: inizia quando arriva il cleaner (arrival)
        #   2. Checkout migrato PRIMA dell'arrival: inizia all'arrival
        #   3. Checkout migrato DOPO l'arrival: inizia al checkout
        # - EO NORMALE: rispetta checkout_time come sempre

        if t.straordinaria:
            # STRAORDINARIE: checkout ha priorità se presente e maggiore di arrival
            # altrimenti inizia quando arriva il cleaner
            start = max(arrival, t.checkout_time)
            cur = start
        else:
            # EO NORMALE: start_time NON può MAI essere prima del checkout_time
            wait = max(0.0, t.checkout_time - arrival)
            cur += wait
            start = cur
            
            # VINCOLO EO END TIME SOFT (Proposta A):
            # La task EO può iniziare dopo eo_end_time SOLO SE:
            # 1. C'è una task precedente "vicina" (proximity_rank >= 1)
            # 2. Lo sforamento è <= EO_GRACE_MAX_OVER_MIN (20 minuti)
            if EO_END_TIME_MIN is not None and start > EO_END_TIME_MIN:
                over = start - EO_END_TIME_MIN
                # Prima task: nessuna grace possibile
                if prev is None:
                    return False, []
                # Calcola il rank di vicinanza con la task precedente
                rank = proximity_rank(prev, t)
                # Grace rule: consenti se rank >= 1 E sforamento <= max grace
                if rank < 1 or over > EO_GRACE_MAX_OVER_MIN:
                    return False, []
                # Altrimenti consenti (passa al prossimo task)

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

    # =====================================================
    # PROPOSTA A: CAP 2/3 BASATO SU GERARCHIA DI VICINANZA
    # =====================================================
    # Prima di tutto, applica il cap EO basato sulla gerarchia:
    # - max 2 task se vicinanza è solo travel <= 15'
    # - max 3 task se stessa via o stesso edificio
    if current_count > 0:
        # Calcola il rank massimo di vicinanza con le task esistenti
        max_rank = max(proximity_rank(existing_task, task) for existing_task in cleaner.route)
        
        # Determina il cap in base alla gerarchia
        # rank >= 2 (stessa via o edificio) → max 3 task
        # rank == 1 (travel <= 15') → max 2 task
        # rank == 0 (lontano) → max 2 task (regola base)
        if max_rank >= 2:
            max_allowed = MAX_TASKS_IF_STREET_OR_BUILDING  # 3
        else:
            max_allowed = MAX_TASKS_IF_NEAR  # 2
        
        # Applica il cap (hard limit per EO)
        if current_count >= max_allowed:
            return False

    # CLUSTERING AVANZATO: controlla vicinanza con task esistenti (logica legacy per altri controlli)
    if current_count > 0:
        # Cluster prioritario: ≤5' o stessa via
        is_priority_cluster = any(
            (travel_minutes(existing_task, task) <= CLUSTER_PRIORITY_TRAVEL or
             travel_minutes(task, existing_task) <= CLUSTER_PRIORITY_TRAVEL or
             same_street(existing_task.address, task.address))
            for existing_task in cleaner.route
        )

        # Cluster esteso: ≤7' (infrange limite tipologia)
        is_extended_cluster = any(
            (travel_minutes(existing_task, task) <= CLUSTER_EXTENDED_TRAVEL or
             travel_minutes(task, existing_task) <= CLUSTER_EXTENDED_TRAVEL)
            for existing_task in cleaner.route
        )

        # NUOVO: Cluster geografico
        is_geo_cluster = any(same_zone(existing_task, task) for existing_task in cleaner.route)

        # Se è in cluster prioritario o geografico: ignora limiti tipologia
        if is_priority_cluster or is_geo_cluster:
            return True

        # Se è in cluster esteso: ignora limite tipologia
        if is_extended_cluster:
            return True

    # Regola base: max 2 task
    if current_count < BASE_MAX_TASKS:
        return True

    # 3ª task: solo se fattibile temporalmente (già passato il cap check sopra)
    if current_count >= BASE_MAX_TASKS:
        test_route = cleaner.route + [task]
        feasible, schedule = evaluate_route(test_route)
        if feasible:
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
        feasible, _ = evaluate_route(test_route)
        if feasible:
            return (0, 0.0)
        else:
            return None

    # Prova tutte le posizioni possibili
    for pos in range(len(cleaner.route) + 1):
        test_route = cleaner.route[:pos] + [task] + cleaner.route[pos:]
        feasible, _ = evaluate_route(test_route)

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

def load_cleaners() -> List[Cleaner]:
    cleaners_data = load_cleaners_data()
    all_cleaners: List[Cleaner] = []
    for c in cleaners_data:
        role = (c.get("role") or "Standard").strip()
        can_do_straordinaria = bool(c.get("can_do_straordinaria", False))

        # Valida se il cleaner può gestire Early-Out basandosi su settings
        if not can_cleaner_handle_priority(role, "early_out"):
            print(f"   ⏭️  Cleaner {c.get('name')} ({role}) escluso da Early-Out (priority_types settings)")
            continue

        cleaner = Cleaner(
            id=c.get("id"),
            name=c.get("name") or str(c.get("id")),
            lastname=c.get("lastname", ""),
            role=role,
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

def load_tasks() -> List[Task]:
    data = load_containers_data()

    # Carica settings da API per leggere eo_start_time dinamicamente
    try:
        from api_client import load_settings_from_api
        settings = load_settings_from_api()
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
                # Normalizza formato ISO (es. "2025-12-13T00:00:00.000Z" -> "2025-12-13")
                normalized_date = checkin_date.split('T')[0] if 'T' in checkin_date else checkin_date
                # Normalizza tempo (es. "11:00:00" -> "11:00")
                normalized_time = ':'.join(checkin_time.split(':')[:2]) if checkin_time.count(':') == 2 else checkin_time
                checkin_dt = datetime.strptime(f"{normalized_date} {normalized_time}", "%Y-%m-%d %H:%M")
            except:
                pass

        checkout_date = t.get("checkout_date")
        checkout_time = t.get("checkout_time")
        if checkout_date and checkout_time:
            try:
                # Normalizza formato ISO (es. "2025-12-13T00:00:00.000Z" -> "2025-12-13")
                normalized_date = checkout_date.split('T')[0] if 'T' in checkout_date else checkout_date
                # Normalizza tempo (es. "11:00:00" -> "11:00")
                normalized_time = ':'.join(checkout_time.split(':')[:2]) if checkout_time.count(':') == 2 else checkout_time
                checkout_dt = datetime.strptime(f"{normalized_date} {normalized_time}", "%Y-%m-%d %H:%M")
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
    - HARD CLUSTER edificio/via/blocco: stesso edificio o vicino + stesso cliente
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
        # dedup su logistic_code cross-container
        if task.logistic_code in assigned_logistic_codes:
            unassigned.append(task)
            continue

        candidates: List[Tuple[Cleaner, int, float]] = []

        # 1) Trova tutti i cleaner che POSSONO prendere la task (vincoli gestiti da find_best_position)
        for cleaner in cleaners:
            # Validazione tipo di task (premium / straordinaria / standard)
            if not can_cleaner_handle_task(cleaner.role, task.is_premium, task.straordinaria, cleaner.can_do_straordinaria):
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


def build_output(cleaners: List[Cleaner], unassigned: List[Task], original_tasks: List[Task], containers_data: Dict = None) -> Dict[str, Any]:
    cleaners_with_tasks: List[Dict[str, Any]] = []
    
    # Usa containers_data passato come parametro (caricato da API)
    if containers_data is None:
        containers_data = {"containers": {}}

    for cl in cleaners:
        if not cl.route:
            continue

        # Per Early-Out accettiamo anche 1 sola task (task urgenti)
        # Nessun vincolo minimo qui

        feasible, schedule = evaluate_route(cl.route)
        if not feasible or not schedule:
            continue

        tasks_list: List[Dict[str, Any]] = []
        prev_finish_time = None

        for idx, (t, (arr, start, fin)) in enumerate(zip(cl.route, schedule)):
            travel_time = 0
            if idx > 0 and prev_finish_time is not None:
                travel_time = arr - prev_finish_time

            # Cerca i dati originali completi della task nei containers (già caricati da API)
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
                "premium": cl.role.lower() == "premium"
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


def load_timeline(work_date: str) -> Dict[str, Any]:
    """
    Carica la timeline esistente da API (unica fonte).
    """
    empty_timeline = {
        "metadata": {
            "last_updated": datetime.now().isoformat(),
            "date": work_date,
            "modification_type": "auto_assign_early_out"
        },
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


def main():
    global USE_API, WORK_DATE
    
    # Parse argomenti da linea di comando
    parser = argparse.ArgumentParser(description='Assegna task Early-Out ai cleaners')
    parser.add_argument('date', nargs='?', default=None, help='Data nel formato YYYY-MM-DD')
    parser.add_argument('--use-api', action='store_true', help='Usa API HTTP invece di file JSON')
    parser.add_argument('--date', dest='date_opt', type=str, help='Data nel formato YYYY-MM-DD')
    args = parser.parse_args()
    
    # Determina la data di lavoro
    ref_date = args.date_opt or args.date or datetime.now().strftime("%Y-%m-%d")
    
    # Configura variabili globali
    USE_API = args.use_api
    WORK_DATE = ref_date
    
    if USE_API:
        if API_AVAILABLE:
            print(f"🌐 Modalità API attiva (PostgreSQL)")
        else:
            print(f"⚠️ API client non disponibile, fallback su file")
            USE_API = False
    
    print(f"📅 Data di lavoro: {ref_date}")
    
    # API è obbligatoria - nessun fallback su filesystem
    if not USE_API:
        raise SystemExit("❌ Errore: --use-api è obbligatorio. Lo script usa solo API, non filesystem.")

    # Carica EO settings (eo_start_time, eo_end_time)
    load_eo_settings()

    cleaners = load_cleaners()
    containers_data = load_containers_data()  # Carica containers da API
    tasks = load_tasks()

    print(f"📋 Caricamento dati...")
    print(f"   - Cleaner disponibili: {len(cleaners)}")
    print(f"   - Task Early-Out da assegnare: {len(tasks)}")

    # Leggi i logistic_code già assegnati dalla timeline via API
    assigned_logistic_codes = set()
    try:
        existing_timeline = load_timeline(ref_date)
        for cleaner_entry in existing_timeline.get("cleaners_assignments", []):
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
    output = build_output(planners, leftovers, tasks, containers_data)

    print()
    print(f"✅ Assegnazione completata!")
    print(f"   - Task assegnati: {output['meta']['assigned']}/{output['meta']['total_tasks']}")
    print(f"   - Cleaner utilizzati: {output['meta']['cleaners_used']}")
    print(f"   - Task non assegnati: {output['meta']['unassigned']}")
    print()

    # Update timeline via API con struttura organizzata per cleaner
    from datetime import datetime as dt

    # Carica timeline esistente o crea nuova struttura
    timeline_data_output = load_timeline(ref_date)

    # CRITICAL: Rimuovi eventuali duplicati cleaner (merge delle task)
    seen_cleaner_ids = {}
    merged_assignments = []

    for entry in timeline_data_output.get("cleaners_assignments", []):
        cleaner_id = entry.get("cleaner", {}).get("id")
        if cleaner_id is None:
            continue

        if cleaner_id in seen_cleaner_ids:
            # Cleaner duplicato: merge delle task (con deduplicazione per task_id)
            existing_entry = seen_cleaner_ids[cleaner_id]
            existing_task_ids = {t.get("task_id") for t in existing_entry["tasks"]}
            new_tasks = [t for t in entry.get("tasks", []) if t.get("task_id") not in existing_task_ids]
            existing_entry["tasks"].extend(new_tasks)
            print(f"   🔧 Merged duplicato cleaner ID {cleaner_id}: +{len(new_tasks)} task (skipped {len(entry.get('tasks', [])) - len(new_tasks)} duplicati)")
        else:
            # Primo incontro con questo cleaner
            seen_cleaner_ids[cleaner_id] = entry
            merged_assignments.append(entry)

    if len(merged_assignments) < len(timeline_data_output.get("cleaners_assignments", [])):
        print(f"   ✅ Rimossi {len(timeline_data_output.get('cleaners_assignments', [])) - len(merged_assignments)} cleaner duplicati")
        timeline_data_output["cleaners_assignments"] = merged_assignments

    # Aggiungi le nuove assegnazioni EO organizzate per cleaner
    for cleaner_entry in output["early_out_tasks_assigned"]:
        # CRITICAL: Cerca il cleaner esistente usando solo l'ID (più robusto)
        cleaner_entry_existing = None
        for entry in timeline_data_output["cleaners_assignments"]:
            if entry.get("cleaner", {}).get("id") == cleaner_entry["cleaner"]["id"]:
                cleaner_entry_existing = entry
                break

        if not cleaner_entry_existing:
            # Crea nuova entry per questo cleaner SOLO se non esiste
            timeline_data_output["cleaners_assignments"].append(cleaner_entry)
            print(f"   ➕ Creato nuovo cleaner entry per {cleaner_entry['cleaner']['name']} {cleaner_entry['cleaner']['lastname']}")
        else:
            # CRITICAL FIX: Verifica duplicati per task_id prima di aggiungere
            existing_task_ids = {t.get("task_id") for t in cleaner_entry_existing["tasks"]}
            new_tasks = [t for t in cleaner_entry["tasks"] if t.get("task_id") not in existing_task_ids]
            if len(new_tasks) < len(cleaner_entry["tasks"]):
                skipped = len(cleaner_entry["tasks"]) - len(new_tasks)
                print(f"   ⚠️ Skipped {skipped} task duplicate per cleaner {cleaner_entry['cleaner']['name']}")
            # Aggiungi solo le task NON duplicate
            cleaner_entry_existing["tasks"].extend(new_tasks)
            print(f"   ✅ Usando cleaner entry esistente per {cleaner_entry['cleaner']['name']} {cleaner_entry['cleaner']['lastname']} (aggiunte {len(new_tasks)} task)")

    # NOTA: Non chiamare recalculate_cleaner_times qui!
    # I tempi sono già calcolati correttamente da build_output/evaluate_route
    # con i vincoli EO (eo_end_time). recalculate_cleaner_times non conosce
    # questi vincoli e sovrascriverebbe i tempi EO con valori errati.
    
    # Solo ordinamento per start_time (senza ricalcolo)
    # FIX: Usa ordinamento numerico invece di stringa per gestire "9:30" vs "10:00"
    def parse_time_for_sort(time_str):
        """Converte HH:MM in minuti per ordinamento numerico, fallback a 9999"""
        if not time_str or not isinstance(time_str, str) or ":" not in time_str:
            return 9999  # Metti task senza tempo alla fine
        try:
            return hhmm_to_min(time_str, "00:00")
        except (ValueError, TypeError):
            return 9999
    
    for entry in timeline_data_output["cleaners_assignments"]:
        tasks = entry.get("tasks", [])
        if len(tasks) > 1:
            tasks.sort(key=lambda t: (parse_time_for_sort(t.get("start_time")), t.get("sequence", 9999)))
        
        # FIX A: Rinumera sequence e ricalcola travel_time dopo il merge
        # Questo elimina sequence duplicate e corregge travel_time
        # SAFEGUARD: Solo se ci sono task
        if not tasks:
            continue
            
        prev_task = None
        cleaner_name = entry.get("cleaner", {}).get("name", "Unknown")
        for i, task in enumerate(tasks):
            # Rinumera sequence (1-based)
            task["sequence"] = i + 1
            task["followup"] = i > 0
            
            # Ricalcola travel_time usando le coordinate geografiche
            if i > 0 and prev_task is not None:
                # Usa travel_minutes_raw con le coordinate delle task
                prev_lat = prev_task.get("lat")
                prev_lng = prev_task.get("lng")
                curr_lat = task.get("lat")
                curr_lng = task.get("lng")
                
                if prev_lat and prev_lng and curr_lat and curr_lng:
                    try:
                        travel = int(round(travel_minutes_raw(
                            float(prev_lat), float(prev_lng),
                            float(curr_lat), float(curr_lng)
                        )))
                        task["travel_time"] = travel
                        print(f"   🚗 {cleaner_name}: task {prev_task.get('logistic_code')} -> {task.get('logistic_code')} = {travel} min (coords: {prev_lat},{prev_lng} -> {curr_lat},{curr_lng})")
                    except (ValueError, TypeError) as e:
                        task["travel_time"] = 0
                        print(f"   ⚠️ Error calculating travel for {cleaner_name}: {e}")
                else:
                    # Coordinate mancanti: usa default
                    task["travel_time"] = 0
                    print(f"   ⚠️ Missing coords for {cleaner_name}: prev=({prev_lat},{prev_lng}) curr=({curr_lat},{curr_lng})")
            else:
                # Prima task: travel_time = 0
                task["travel_time"] = 0
            
            prev_task = task

    # Aggiorna meta
    # Conta i cleaner totali disponibili
    total_available_cleaners = len(cleaners)

    # Conta i cleaner effettivamente usati (con almeno una task)
    used_cleaners_count = len([c for c in timeline_data_output["cleaners_assignments"] if len(c.get("tasks", [])) > 0])

    # Conta le task totali assegnate
    total_assigned_tasks = sum(len(c["tasks"]) for c in timeline_data_output["cleaners_assignments"])

    # Salva timeline.json
    timeline_data_output["metadata"]["last_updated"] = dt.now().isoformat()
    timeline_data_output["meta"] = {
        "total_cleaners": total_available_cleaners,
        "used_cleaners": used_cleaners_count,
        "assigned_tasks": total_assigned_tasks
    }
    
    # Salva solo via API (unica destinazione)
    save_timeline_via_api(ref_date, timeline_data_output)
    print(f"✅ Timeline aggiornata via API")

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

    # SPOSTAMENTO: Rimuovi le task assegnate dai containers via API
    try:
        # Carica containers da API
        client = ApiClient()
        containers_data = client.get_containers(ref_date)
        
        if not containers_data or "containers" not in containers_data:
            print(f"⚠️ Nessun container trovato via API per {ref_date}")
        else:
            # Trova tutti i task_id assegnati (NON logistic_code per permettere duplicati)
            assigned_task_ids = set()
            for cleaner_entry in output["early_out_tasks_assigned"]:
                for task in cleaner_entry.get("tasks", []):
                    assigned_task_ids.add(int(task["task_id"]))

            # Rimuovi le task assegnate dal container early_out usando task_id
            if "early_out" in containers_data["containers"]:
                original_count = len(containers_data["containers"]["early_out"].get("tasks", []))
                containers_data["containers"]["early_out"]["tasks"] = [
                    t for t in containers_data["containers"]["early_out"].get("tasks", [])
                    if int(t.get("task_id", 0)) not in assigned_task_ids
                ]
                new_count = len(containers_data["containers"]["early_out"]["tasks"])
                containers_data["containers"]["early_out"]["count"] = new_count

                # Aggiorna summary se esiste
                if "summary" in containers_data:
                    containers_data["summary"]["early_out"] = new_count
                    containers_data["summary"]["total_tasks"] = (
                        containers_data["summary"].get("total_tasks", 0) - (original_count - new_count)
                    )

                # Salva containers solo via API
                save_containers_via_api(ref_date, containers_data)
                print(f"✅ Rimosse {original_count - new_count} task da containers (early_out) via API")
                print(f"   - Task rimaste in early_out: {new_count}")
                print(f"   💡 Task con logistic_code duplicati rimangono disponibili nei container")
    except Exception as e:
        print(f"⚠️ Errore durante la rimozione delle task dai containers: {e}")


if __name__ == "__main__":
    main()