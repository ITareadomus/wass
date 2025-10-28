# -*- coding: utf-8 -*-
from __future__ import annotations
import json, math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path
from datetime import datetime, timedelta

# =============================
# I/O paths
# =============================
BASE = Path(__file__).parent.parent / "data"

INPUT_TASKS = BASE / "output" / "high_priority.json"
INPUT_CLEANERS = BASE / "cleaners" / "selected_cleaners.json"
INPUT_EO_ASSIGN = BASE / "output" / "early_out_assignments.json"
OUTPUT_ASSIGN = BASE / "output" / "high_priority_assignments.json"

# =============================
# CONFIG - REGOLE SEMPLIFICATE
# =============================
MAX_TASKS_PER_CLEANER = 2  # Massimo 2 task
THIRD_TASK_MAX_TRAVEL = 10.0  # 3ª task solo se entro 10' dalla 2ª

PREFERRED_TRAVEL = 15.0  # Preferenza per percorsi < 15'

HP_HARD_EARLIEST_H = 11
HP_HARD_EARLIEST_M = 0

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
    km = haversine_km(a_lat, a_lng, b_lat, b_lng)

    if a_addr and b_addr and same_building(a_addr, b_addr):
        t = SHORT_BASE_MIN
        return max(MIN_TRAVEL, min(MAX_TRAVEL, t))

    if km < SHORT_RANGE_KM:
        t = SHORT_BASE_MIN + WALK_SLOW_MIN_PER_KM * km
    else:
        overhead = BASE_OVERHEAD_MIN * (km / SCALED_OH_KM) if km < SCALED_OH_KM else BASE_OVERHEAD_MIN
        t = overhead
        if km <= K_SWITCH_KM:
            t += WALK_MIN_PER_KM * km
        else:
            t += WALK_MIN_PER_KM * K_SWITCH_KM + RIDE_MIN_PER_KM * (km - K_SWITCH_KM)

    if a_addr and b_addr and same_street(a_addr, b_addr) and km < 0.10:
        t += 1.0

    return max(MIN_TRAVEL, min(MAX_TRAVEL, t))


def can_handle_premium(cleaner: Cleaner, task: Task) -> bool:
    if task.is_premium and not cleaner.is_premium:
        return False
    if task.straordinaria and not cleaner.is_premium:
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

    # Calcola l'arrivo al primo task
    base = cleaner.start_time
    if cleaner.available_from:
        base = max(base, cleaner.available_from)

    # Viaggio da EO a HP
    if cleaner.last_eo_lat is not None and cleaner.last_eo_lng is not None:
        tt = travel_minutes(cleaner.last_eo_lat, cleaner.last_eo_lng,
                          first.lat, first.lng,
                          cleaner.last_eo_address, first.address)
    else:
        tt = 3.0 if same_street(cleaner.last_eo_address, first.address) else 12.0

    arrival = base + timedelta(minutes=tt)

    # HP hard earliest: 11:00
    hp_earliest = datetime(arrival.year, arrival.month, arrival.day, HP_HARD_EARLIEST_H, HP_HARD_EARLIEST_M)
    arrival = max(arrival, hp_earliest)

    # Orario massimo di fine task: 19:00
    max_end_time = datetime(arrival.year, arrival.month, arrival.day, 19, 0)

    # Considera checkout se presente
    if first.checkout_dt:
        arrival = max(arrival, first.checkout_dt)

    start = arrival
    finish = start + timedelta(minutes=first.cleaning_time)

    # Check-in strict
    if first.checkin_dt and finish > first.checkin_dt:
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

        # Check-in strict
        if t.checkin_dt and finish > t.checkin_dt:
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
    3. Max 2 task per cleaner (3ª solo se entro 10')
    """
    if not can_handle_premium(cleaner, task):
        return False

    # Straordinaria deve essere la prima
    if task.straordinaria:
        if len(cleaner.route) > 0:
            return False

    # Se il cleaner ha già una straordinaria, non può aggiungerne altre
    if len(cleaner.route) > 0 and cleaner.route[0].straordinaria:
        if task.straordinaria:
            return False

    # Max 2 task (3ª solo se entro 10')
    if len(cleaner.route) >= MAX_TASKS_PER_CLEANER:
        # Può aggiungere una 3ª task solo se il viaggio è ≤ 10'
        if len(cleaner.route) == 2:
            last_task = cleaner.route[-1]
            tt = travel_minutes(last_task.lat, last_task.lng, task.lat, task.lng,
                              last_task.address, task.address)
            if tt <= THIRD_TASK_MAX_TRAVEL:
                return True
        return False

    return True


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
        if (role or "").lower() == "formatore":
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
                start_time=start_dt,
            ))
    return cleaners


def seed_cleaners_from_eo(cleaners: List[Cleaner], ref_date: str):
    """Seed cleaners da database (Early-Out assignments)"""
    import mysql.connector

    try:
        conn = mysql.connector.connect(
            host="139.59.132.41",
            user="admin",
            password="ed329a875c6c4ebdf4e87e2bbe53a15771b5844ef6606dde",
            database="adamdb"
        )
        cur = conn.cursor(dictionary=True)

        # Query per ottenere l'ultima task EO di ogni cleaner
        cur.execute("""
            SELECT
                cleaner_id,
                end_time,
                address,
                lat,
                lng,
                sequence
            FROM app_wass_assignments
            WHERE DATE(date) = %s
              AND assignment_type = 'early_out'
            ORDER BY cleaner_id, sequence DESC
        """, (ref_date,))

        assignments = cur.fetchall()

        # Raggruppa per cleaner_id e prendi l'ultima task
        cleaner_last_task = {}
        for row in assignments:
            cid = row['cleaner_id']
            if cid not in cleaner_last_task:
                cleaner_last_task[cid] = row

        # Aggiorna i cleaner
        for cl in cleaners:
            if cl.id in cleaner_last_task:
                last = cleaner_last_task[cl.id]
                cl.available_from = hhmm_to_dt(ref_date, last['end_time'])
                cl.last_eo_address = last['address']
                cl.last_eo_lat = float(last['lat']) if last['lat'] is not None else None
                cl.last_eo_lng = float(last['lng']) if last['lng'] is not None else None
                cl.eo_last_sequence = int(last['sequence'])

        cur.close()
        conn.close()

    except Exception as e:
        print(f"⚠️  Errore nel seed da database: {e}")
        print("Continuo senza seed...")


def load_tasks() -> Tuple[List[Task], str]:
    data = json.loads(INPUT_TASKS.read_text(encoding="utf-8"))
    tasks: List[Task] = []

    # Determina ref_date dal primo task
    ref_date = None
    for t in data.get("high_priority_tasks", []):
        checkout_dt = parse_dt(t.get("checkout_date"), t.get("checkout_time"))
        checkin_dt = parse_dt(t.get("checkin_date"), t.get("checkin_time"))
        ref = checkin_dt or checkout_dt
        if ref:
            ref_date = ref.strftime("%Y-%m-%d")
            break

    if ref_date is None:
        ref_date = datetime.now().strftime("%Y-%m-%d")

    for t in data.get("high_priority_tasks", []):
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

    # Ordina: straordinarie first, poi premium, poi per checkin/checkout
    def task_key(task: Task):
        base_dt = task.checkin_dt or task.checkout_dt or datetime.now().replace(
            hour=HP_HARD_EARLIEST_H, minute=HP_HARD_EARLIEST_M, second=0, microsecond=0)
        return (not task.straordinaria, not task.is_premium, base_dt)

    tasks.sort(key=task_key)
    return tasks, ref_date


# -------- Planner --------
def plan_day(tasks: List[Task], cleaners: List[Cleaner]) -> Tuple[List[Cleaner], List[Task]]:
    """
    Assegna le task ai cleaner con regole semplificate:
    - Favorisce percorsi < 15'
    - Se non ci sono percorsi < 15', sceglie il minore dei > 15'
    - Max 2 task per cleaner (3ª solo se entro 10')
    """
    unassigned = []

    for task in tasks:
        # Trova tutti i cleaner che possono prendere questa task
        candidates = []

        for cleaner in cleaners:
            result = find_best_position(cleaner, task)
            if result is not None:
                pos, travel = result
                candidates.append((cleaner, pos, travel))

        if not candidates:
            unassigned.append(task)
            continue

        # Dividi i candidati in due gruppi: < 15' e >= 15'
        preferred = [(c, p, t) for c, p, t in candidates if t < PREFERRED_TRAVEL]
        others = [(c, p, t) for c, p, t in candidates if t >= PREFERRED_TRAVEL]

        # Scegli dal gruppo preferito se esiste, altrimenti dal gruppo altri
        if preferred:
            # Scegli quello con minor viaggio tra i preferiti
            preferred.sort(key=lambda x: (len(x[0].route), x[2]))
            chosen = preferred[0]
        else:
            # Scegli quello con minor viaggio tra gli altri
            others.sort(key=lambda x: (len(x[0].route), x[2]))
            chosen = others[0]

        cleaner, pos, travel = chosen
        cleaner.route.insert(pos, task)

    return cleaners, unassigned


def build_output(cleaners: List[Cleaner], unassigned: List[Task], original_tasks: List[Task]) -> Dict[str, Any]:
    cleaners_with_tasks: List[Dict[str, Any]] = []

    for cl in cleaners:
        if not cl.route:
            continue

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

            tasks_list.append({
                "task_id": int(t.task_id),
                "logistic_code": int(t.logistic_code),
                "address": t.address,
                "lat": t.lat,
                "lng": t.lng,
                "premium": t.is_premium,
                "cleaning_time": t.cleaning_time,
                "start_time": fmt_hhmm(start),
                "end_time": fmt_hhmm(fin),
                "followup": (overall_seq > 1),
                "sequence": overall_seq,
                "travel_time": travel_time
            })

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

    # Trova le task assegnate
    assigned_codes = set()
    for entry in cleaners_with_tasks:
        for t in entry.get("tasks", []):
            assigned_codes.add(int(t["logistic_code"]))

    # Unassigned list
    unassigned_list: List[Dict[str, Any]] = []
    for ot in original_tasks:
        lc = int(ot.logistic_code)
        if lc not in assigned_codes:
            unassigned_list.append({
                "task_id": int(ot.task_id),
                "logistic_code": lc,
                "reason": "no_eligible_cleaner_or_time_window"
            })

    total_assigned = sum(len(c["tasks"]) for c in cleaners_with_tasks)

    # Usa la data passata come argomento da riga di comando
    import sys
    if len(sys.argv) > 1:
        current_ref_date = sys.argv[1]
    else:
        # Fallback: carica la data dal primo task se non specificata
        tasks_temp, ref_date_from_tasks = load_tasks()
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
                "REGOLE SEMPLIFICATE:",
                "1. Max 2 task per cleaner (3ª solo se entro 10' dalla 2ª)",
                "2. Favorisce percorsi < 15'",
                "3. Se non ci sono percorsi < 15', sceglie il minore dei > 15'",
                "4. Straordinarie solo a premium cleaner, devono essere la prima task",
                "5. Premium task solo a premium cleaner",
                "6. Check-in strict: deve finire prima del check-in time",
                "7. HP hard earliest: 11:00",
                "8. Seed da EO: disponibilità e posizione dall'ultima EO",
                "9. Vincolo orario: nessuna task deve finire dopo le 19:00"
            ]
        }
    }


def save_to_database(output: Dict[str, Any], ref_date: str):
    """Salva le assegnazioni nel database MySQL"""
    import mysql.connector

    try:
        conn = mysql.connector.connect(
            host="139.59.132.41",
            user="admin",
            password="ed329a875c6c4ebdf4e87e2bbe53a15771b5844ef6606dde",
            database="adamdb"
        )
        cur = conn.cursor()

        # Elimina le assegnazioni HP esistenti per questa data
        cur.execute(
            "DELETE FROM app_wass_assignments WHERE assignment_type = 'high_priority' AND DATE(date) = %s",
            (ref_date,)
        )

        # Inserisci le nuove assegnazioni
        insert_count = 0
        for cleaner_entry in output.get("high_priority_tasks_assigned", []):
            cleaner_id = cleaner_entry["cleaner"]["id"]
            for task in cleaner_entry.get("tasks", []):
                cur.execute("""
                    INSERT INTO app_wass_assignments (
                        task_id, cleaner_id, date, logistic_code, assignment_type, sequence,
                        start_time, end_time, cleaning_time, travel_time, address, lat, lng,
                        premium, followup
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """, (
                    task.get("task_id"),
                    cleaner_id,
                    ref_date,
                    task.get("logistic_code"),
                    'high_priority',
                    task.get("sequence", 0),
                    task.get("start_time"),
                    task.get("end_time"),
                    task.get("cleaning_time"),
                    task.get("travel_time", 0),
                    task.get("address"),
                    task.get("lat"),
                    task.get("lng"),
                    1 if task.get("premium") else 0,
                    1 if task.get("followup") else 0
                ))
                insert_count += 1

        conn.commit()
        cur.close()
        conn.close()

        print(f"✅ Salvate {insert_count} assegnazioni nel database MySQL")
        return True
    except Exception as e:
        print(f"❌ Errore nel salvataggio database: {e}")
        return False


def main():
    if not INPUT_TASKS.exists():
        raise SystemExit(f"Missing input file: {INPUT_TASKS}")
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

    tasks, _ = load_tasks()
    cleaners = load_cleaners(ref_date)
    seed_cleaners_from_eo(cleaners, ref_date)

    print(f"📋 Caricamento dati...")
    print(f"👥 Cleaner disponibili: {len(cleaners)}")
    print(f"📦 Task High-Priority da assegnare: {len(tasks)}")
    print()
    print(f"🔄 Assegnazione in corso...")

    planners, leftovers = plan_day(tasks, cleaners)
    output = build_output(planners, leftovers, tasks)

    print()
    print(f"✅ Assegnazione completata!")
    print(f"   - Task assegnati: {output['meta']['assigned']}/{output['meta']['total_tasks']}")
    print(f"   - Cleaner utilizzati: {output['meta']['cleaners_used']}")
    print(f"   - Task non assegnati: {output['meta']['unassigned']}")
    print()

    # Salva nel database MySQL
    save_to_database(output, ref_date)

    # Update timeline_assignments/{date}.json
    timeline_dir = OUTPUT_ASSIGN.parent / "timeline_assignments"
    timeline_dir.mkdir(parents=True, exist_ok=True)
    timeline_assignments_path = timeline_dir / f"{ref_date}.json"

    timeline_data = {"assignments": [], "current_date": ref_date}

    if timeline_assignments_path.exists():
        try:
            timeline_data = json.loads(timeline_assignments_path.read_text(encoding="utf-8"))
            if "current_date" not in timeline_data:
                timeline_data["current_date"] = ref_date
        except:
            timeline_data = {"assignments": [], "current_date": ref_date}

    # Supporta sia struttura per cleaner che flat
    if "cleaners" in timeline_data:
        timeline_data["assignments"] = []
        for cleaner_entry in timeline_data.get("cleaners", []):
            for task in cleaner_entry.get("tasks", []):
                timeline_data["assignments"].append(task)
    
    # Riorganizza per cleaner invece di usare assignments flat
    from collections import defaultdict
    cleaners_map = defaultdict(list)
    
    # Carica i dati dei cleaner
    selected_cleaners_path = Path(__file__).parent.parent / "data" / "cleaners" / "selected_cleaners.json"
    cleaners_info = {}
    if selected_cleaners_path.exists():
        cleaners_data = json.loads(selected_cleaners_path.read_text(encoding="utf-8"))
        for cleaner in cleaners_data.get("cleaners", []):
            cleaners_info[cleaner["id"]] = cleaner
    
    # Estrai assignments esistenti
    existing_assignments = []
    if "cleaners" in timeline_data:
        for cleaner_entry in timeline_data.get("cleaners", []):
            for task in cleaner_entry.get("tasks", []):
                existing_assignments.append(task)
    elif "assignments" in timeline_data:
        existing_assignments = timeline_data.get("assignments", [])
    
    # Rimuovi vecchie assegnazioni HP
    assigned_codes = set()
    for cleaner_entry in output["high_priority_tasks_assigned"]:
        for task in cleaner_entry.get("tasks", []):
            assigned_codes.add(str(task["logistic_code"]))

    for assignment in existing_assignments:
        if str(assignment.get("logistic_code")) not in assigned_codes
    ]

    # Aggiungi nuove assegnazioni HP
    for cleaner_entry in output["high_priority_tasks_assigned"]:
        cleaner_id = cleaner_entry["cleaner"]["id"]
        for task in cleaner_entry.get("tasks", []):
            timeline_data["assignments"].append({
                "task_id": task["task_id"],
                "logistic_code": str(task["logistic_code"]),
                "cleanerId": cleaner_id,
                "assignment_type": "high_priority",
                "sequence": task.get("sequence", 0),
                "address": task.get("address"),
                "lat": task.get("lat"),
                "lng": task.get("lng"),
                "premium": task.get("premium"),
                "cleaning_time": task.get("cleaning_time"),
                "start_time": task.get("start_time"),
                "end_time": task.get("end_time"),
                "travel_time": task.get("travel_time", 0),
                "followup": task.get("followup", False)
            })
    
    # Riorganizza per cleaner come in assign_eo.py
    from collections import defaultdict
    assignments_by_cleaner = defaultdict(list)
    for assignment in timeline_data["assignments"]:
        cleaner_id = assignment.get("cleanerId")
        if cleaner_id:
            assignments_by_cleaner[cleaner_id].append(assignment)
    
    for cleaner_id in assignments_by_cleaner:
        assignments_by_cleaner[cleaner_id].sort(key=lambda x: x.get("sequence", 0))
    
    cleaners_path = BASE / "cleaners" / "selected_cleaners.json"
    cleaners_map = {}
    try:
        cleaners_data = json.loads(cleaners_path.read_text(encoding="utf-8"))
        for c in cleaners_data.get("cleaners", []):
            cleaners_map[c["id"]] = c
    except:
        pass
    
    cleaners_with_tasks = []
    for cleaner_id in sorted(assignments_by_cleaner.keys()):
        cleaner_info = cleaners_map.get(cleaner_id, {})
        cleaners_with_tasks.append({
            "cleaner": {
                "id": cleaner_id,
                "name": cleaner_info.get("name", f"Cleaner {cleaner_id}"),
                "lastname": cleaner_info.get("lastname", ""),
                "role": cleaner_info.get("role", "Standard")
            },
            "tasks": assignments_by_cleaner[cleaner_id]
        })
    
    timeline_data["cleaners"] = cleaners_with_tasks

    # Scrivi il file specifico per la data
    timeline_assignments_path.write_text(json.dumps(timeline_data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"✅ Aggiornato {timeline_assignments_path}")

    # Aggiorna anche il file generale timeline_assignments.json
    general_timeline_path = OUTPUT_ASSIGN.parent / "timeline_assignments.json"
    general_timeline_path.write_text(json.dumps(timeline_data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"✅ Aggiornato anche: {general_timeline_path}")

    # Salva il risultato in high_priority_assignments.json (locale - fallback)
    OUTPUT_ASSIGN.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"✅ Wrote {OUTPUT_ASSIGN}")


if __name__ == "__main__":
    main()