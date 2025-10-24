
# -*- coding: utf-8 -*-
from __future__ import annotations
import json, math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path

# =============================
# I/O paths
# =============================
BASE = Path(__file__).parent.parent / "data"

INPUT_TASKS = BASE / "output" / "early_out.json"
INPUT_CLEANERS = BASE / "cleaners" / "selected_cleaners.json"
OUTPUT_ASSIGN = BASE / "output" / "early_out_assignments.json"

# =============================
# CONFIG - REGOLE SEMPLIFICATE
# =============================
MAX_TASKS_PER_CLEANER = 2  # Massimo 2 task
THIRD_TASK_MAX_TRAVEL = 10.0  # 3ª task solo se entro 10' dalla 2ª

PREFERRED_TRAVEL = 15.0  # Preferenza per percorsi < 15'

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
    checkout_time: int
    checkin_time: int
    is_premium: bool
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
    home_lat: Optional[float] = None
    home_lng: Optional[float] = None
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


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(dl / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


def travel_minutes(a: Optional[Task], b: Optional[Task]) -> float:
    if a is None or b is None:
        return 0.0
    km = haversine_km(a.lat, a.lng, b.lat, b.lng)

    if same_building(a.address, b.address):
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

    if getattr(a, "small_equipment", False) or getattr(b, "small_equipment", False):
        t += (EQ_EXTRA_LT05 if km < 0.5 else EQ_EXTRA_GE05)

    if same_street(a.address, b.address) and km < 0.10:
        t += 1.0

    return max(MIN_TRAVEL, min(MAX_TRAVEL, t))


def can_handle_premium(cleaner: Cleaner, task: Task) -> bool:
    # Premium task requires premium cleaner
    if task.is_premium and not cleaner.is_premium:
        return False
    # Straordinaria requires premium cleaner
    if task.straordinaria and not cleaner.is_premium:
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
    
    schedule: List[Tuple[int, int, int]] = []
    prev: Optional[Task] = None
    cur = 0.0
    
    for i, t in enumerate(route):
        tt = travel_minutes(prev, t)
        cur += tt
        arrival = cur
        wait = max(0.0, t.checkout_time - arrival)
        cur += wait
        start = cur
        finish = start + t.cleaning_time
        
        # Check-in strict: deve finire prima del check-in
        if finish >= t.checkin_time:
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
    3. Max 2 task per cleaner (3ª solo se entro 10' dalla 2ª)
    """
    # Check premium/straordinaria
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
            tt = travel_minutes(last_task, task)
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
def load_cleaners() -> List[Cleaner]:
    data = json.loads(INPUT_CLEANERS.read_text(encoding="utf-8"))
    cleaners: List[Cleaner] = []
    for c in data.get("cleaners", []):
        role = (c.get("role") or "").strip()
        is_premium = bool(c.get("premium", (role.lower() == "premium")))
        if (role or "").lower() == "formatore":
            continue
        cleaners.append(
            Cleaner(
                id=c.get("id"),
                name=c.get("name") or str(c.get("id")),
                lastname=c.get("lastname", ""),
                role=role or ("Premium" if is_premium else "Standard"),
                is_premium=is_premium,
                home_lat=c.get("home_lat"),
                home_lng=c.get("home_lng"),
            ))
    return cleaners


def load_tasks() -> List[Task]:
    data = json.loads(INPUT_TASKS.read_text(encoding="utf-8"))
    eo_start_min = hhmm_to_min("10:00")
    tasks: List[Task] = []
    for t in data.get("early_out_tasks", []):
        checkout = eo_start_min
        checkin = hhmm_to_min(t.get("checkin_time"), default="23:59")
        
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
        
        feasible, schedule = evaluate_route(cl.route)
        if not feasible or not schedule:
            continue
        
        tasks_list: List[Dict[str, Any]] = []
        prev_finish_time = None
        
        for idx, (t, (arr, start, fin)) in enumerate(zip(cl.route, schedule)):
            travel_time = 0
            if idx > 0 and prev_finish_time is not None:
                travel_time = arr - prev_finish_time
            
            tasks_list.append({
                "task_id": int(t.task_id),
                "logistic_code": int(t.logistic_code),
                "address": t.address,
                "lat": t.lat,
                "lng": t.lng,
                "premium": t.is_premium,
                "cleaning_time": t.cleaning_time,
                "start_time": min_to_hhmm(start),
                "end_time": min_to_hhmm(fin),
                "followup": idx > 0,
                "sequence": idx + 1,
                "travel_time": travel_time
            })
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
    
    return {
        "early_out_tasks_assigned": cleaners_with_tasks,
        "unassigned_tasks": unassigned_list,
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
                "6. Check-in strict: deve finire prima del check-in time"
            ]
        }
    }


def main():
    if not INPUT_TASKS.exists():
        raise SystemExit(f"Missing input file: {INPUT_TASKS}")
    if not INPUT_CLEANERS.exists():
        raise SystemExit(f"Missing input file: {INPUT_CLEANERS}")
    
    cleaners = load_cleaners()
    tasks = load_tasks()
    
    print(f"📋 Caricamento dati...")
    print(f"👥 Cleaner disponibili: {len(cleaners)}")
    print(f"📦 Task Early-Out da assegnare: {len(tasks)}")
    print()
    print(f"🔄 Assegnazione in corso...")
    
    planners, leftovers = plan_day(tasks, cleaners)
    output = build_output(planners, leftovers, tasks)
    
    OUTPUT_ASSIGN.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_ASSIGN.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    
    print()
    print(f"✅ Assegnazione completata!")
    print(f"   - Task assegnati: {output['meta']['assigned']}/{output['meta']['total_tasks']}")
    print(f"   - Cleaner utilizzati: {output['meta']['cleaners_used']}")
    print(f"   - Task non assegnati: {output['meta']['unassigned']}")
    print()
    print(f"💾 Risultati salvati in: {OUTPUT_ASSIGN}")
    
    # Usa la data passata come argomento da riga di comando
    import sys
    if len(sys.argv) > 1:
        ref_date = sys.argv[1]
        print(f"📅 Usando data da argomento: {ref_date}")
    else:
        # Fallback: usa la data corrente
        from datetime import datetime
        ref_date = datetime.now().strftime("%Y-%m-%d")
        print(f"📅 Nessuna data specificata, usando: {ref_date}")
    
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
    
    # Rimuovi vecchie assegnazioni EO
    assigned_codes = set()
    for cleaner_entry in output["early_out_tasks_assigned"]:
        for task in cleaner_entry.get("tasks", []):
            assigned_codes.add(str(task["logistic_code"]))
    
    timeline_data["assignments"] = [
        a for a in timeline_data.get("assignments", [])
        if str(a.get("logistic_code")) not in assigned_codes
    ]
    
    # Aggiungi nuove assegnazioni EO con tutti i dati del task
    for cleaner_entry in output["early_out_tasks_assigned"]:
        cleaner_id = cleaner_entry["cleaner"]["id"]
        for task in cleaner_entry.get("tasks", []):
            timeline_data["assignments"].append({
                "task_id": task["task_id"],
                "logistic_code": str(task["logistic_code"]),
                "cleanerId": cleaner_id,
                "assignment_type": "early_out",
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
    
    timeline_assignments_path.write_text(json.dumps(timeline_data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"✅ Aggiornato {timeline_assignments_path}")


if __name__ == "__main__":
    main()
