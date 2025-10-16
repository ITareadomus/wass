# -*- coding: utf-8 -*-
"""
Unified EO day planner (Regret-Insertion + 2-opt) with:
- Max 2 EO per cleaner
- Realistic travel model (short-range tools-aware + scaled overhead + piecewise walk/ride)
- Soft geographic penalty (~30' at 3 km)
- Premium/Standard preferences (soft)
- Trainers excluded
- Check-in hard (finish < checkin)
"""

from __future__ import annotations
import json, math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# =============================
# PATH RELATIVI (compatibili Windows/Linux)
# =============================
BASE = Path(__file__).parent.parent / "data"

INPUT_TASKS    = BASE / "output" / "early_out.json"
INPUT_CLEANERS = BASE / "cleaners" / "selected_cleaners.json"
INPUT_SETTINGS = BASE / "input" / "settings.json"
OUTPUT_DIR     = BASE / "output"
OUTPUT_ASSIGN  = OUTPUT_DIR / "early_out_assignments.json"
TIMELINE_ASSIGNMENTS = OUTPUT_DIR / "timeline_assignments.json"

# =============================
# CONFIG (same behavior as final version)
# =============================
# Travel model parameters
SHORT_RANGE_KM       = 0.30
SHORT_BASE_MIN       = 3.5
WALK_SLOW_MIN_PER_KM = 16.0

BASE_OVERHEAD_MIN    = 6.0
SCALED_OH_KM         = 0.50

K_SWITCH_KM          = 1.2
WALK_MIN_PER_KM      = 12.0
RIDE_MIN_PER_KM      = 4.5

EQ_EXTRA_LT05        = 2.0
EQ_EXTRA_GE05        = 1.0

MIN_TRAVEL           = 2.0
MAX_TRAVEL           = 45.0

SOFT_PENALTY_BASE_KM = 2.0
ALPHA_SOFT_GEO       = 30.0 / ((3.0 - SOFT_PENALTY_BASE_KM)**2)  # 30' at 3 km

ACTIVATION_COST                = 12.0
PENALTY_PREMIUM_TO_STANDARD    = 8.0
PENALTY_STANDARD_TO_PREMIUM    = 3.0
REGRET_K                       = 2
MAX_LOCAL_2OPT_EVERY           = 8
MAX_TASKS_PER_CLEANER          = 2

# =============================
# Utils
# =============================
def hhmm_to_min(hhmm: Optional[str], default: str = "10:00") -> int:
    if not hhmm or not isinstance(hhmm, str) or ":" not in hhmm:
        hhmm = default
    h, m = hhmm.strip().split(":")
    return int(h)*60 + int(m)

def min_to_hhmm(m: float) -> str:
    m = int(round(m))
    return f"{m//60:02d}:{m%60:02d}"

def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dl/2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))
    return R * c

def normalize_addr(s: Optional[str]) -> str:
    s = (s or "").upper()
    for ch in [".", ","]:
        s = s.replace(ch, " ")
    s = " ".join(s.split())
    return s.strip()

def split_street_number(addr: str) -> Tuple[str, Optional[str]]:
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

# =============================
# Data structures
# =============================
@dataclass
class Task:
    task_id: str
    logistic_code: Optional[str] = None
    lat: float = 0.0
    lng: float = 0.0
    cleaning_time: int = 0
    checkout_time: int = 0
    checkin_time: int = 0
    is_premium: bool = False
    apt_type: Optional[str] = None
    address: Optional[str] = None
    alias: Optional[str] = None
    small_equipment: bool = False

@dataclass
class Cleaner:
    id: Any
    name: str
    lastname: str
    telegram_id: Optional[Any]
    role: str
    is_premium: bool
    home_lat: Optional[float] = None
    home_lng: Optional[float] = None
    route: List[Task] = field(default_factory=list)
    insertions_since_opt: int = 0

# =============================
# Eligibility & penalties
# =============================
def is_trainer(cleaner: Cleaner) -> bool:
    return (cleaner.role or "").strip().lower() == "formatore"

def premium_soft_penalty(cleaner: Cleaner, task: Task) -> float:
    if task.is_premium and not cleaner.is_premium:
        return PENALTY_PREMIUM_TO_STANDARD
    if (not task.is_premium) and cleaner.is_premium:
        return PENALTY_STANDARD_TO_PREMIUM
    return 0.0

def can_handle_apt(cleaner: Cleaner, task: Task, settings: Optional[Dict[str, Any]]) -> bool:
    if not task.apt_type or not settings:
        return True
    apt_map = (settings or {}).get("apartment_types") or {}
    if cleaner.is_premium:
        allowed = set(apt_map.get("premium_apt", []))
    else:
        allowed = set(apt_map.get("standard_apt", []))
    return (task.apt_type in allowed) if allowed else True

# =============================
# Travel model
# =============================
def travel_minutes(a: Optional[Task], b: Optional[Task]) -> float:
    if a is None or b is None:
        return 0.0
    km = haversine_km(a.lat, a.lng, b.lat, b.lng)

    # 0) Same building → pure turnover
    if same_building(a.address, b.address):
        t = SHORT_BASE_MIN
        return max(MIN_TRAVEL, min(MAX_TRAVEL, t))

    # 1) Short-range behavior (< 0.30 km): tools-aware slow walk + base
    if km < SHORT_RANGE_KM:
        t = SHORT_BASE_MIN + WALK_SLOW_MIN_PER_KM * km
    else:
        # 2) Scaled overhead for very short hops (< 0.5 km), otherwise full overhead
        if km < SCALED_OH_KM:
            overhead = BASE_OVERHEAD_MIN * (km / SCALED_OH_KM)
        else:
            overhead = BASE_OVERHEAD_MIN

        t = overhead
        if km <= K_SWITCH_KM:
            t += WALK_MIN_PER_KM * km
        else:
            t += WALK_MIN_PER_KM * K_SWITCH_KM + RIDE_MIN_PER_KM * (km - K_SWITCH_KM)

    # 3) Extra if equipment involved
    if getattr(a, "small_equipment", False) or getattr(b, "small_equipment", False):
        t += (EQ_EXTRA_LT05 if km < 0.5 else EQ_EXTRA_GE05)

    # 4) Micro-adjust if same street & <100m
    if same_street(a.address, b.address) and km < 0.10:
        t += 1.0

    return max(MIN_TRAVEL, min(MAX_TRAVEL, t))

def soft_geo_penalty(route: List[Task]) -> float:
    prev = None
    extra = 0.0
    for t in route:
        if prev is not None:
            km = haversine_km(prev.lat, prev.lng, t.lat, t.lng)
            if km > SOFT_PENALTY_BASE_KM:
                extra += ALPHA_SOFT_GEO * (km - SOFT_PENALTY_BASE_KM) ** 2
        prev = t
    return extra

# =============================
# Scheduling core
# =============================
def evaluate_route_cost(route: List[Task]) -> Tuple[float, List[Tuple[int, int, int]]]:
    if not route:
        return 0.0, []
    total = ACTIVATION_COST
    schedule: List[Tuple[int, int, int]] = []
    prev: Optional[Task] = None
    cur = 0.0
    for t in route:
        tt = travel_minutes(prev, t)
        total += tt
        cur += tt
        arrival = cur
        wait = max(0.0, t.checkout_time - arrival)
        total += wait
        cur += wait
        start = cur
        finish = start + t.cleaning_time
        if finish >= t.checkin_time:
            return float("inf"), []
        total += t.cleaning_time
        cur = finish
        schedule.append((int(arrival), int(start), int(finish)))
        prev = t
    total += soft_geo_penalty(route)
    return total, schedule

def delta_insert_cost(route: List[Task], task: Task, pos: int) -> Tuple[float, List[Task]]:
    base, _ = evaluate_route_cost(route)
    new_route = route[:pos] + [task] + route[pos:]
    new, _ = evaluate_route_cost(new_route)
    return new - base, new_route

def best_k_positions(cleaner: Cleaner, task: Task, settings: Optional[Dict[str, Any]]) -> List[float]:
    if is_trainer(cleaner):
        return []
    if len(cleaner.route) >= MAX_TASKS_PER_CLEANER:
        return []
    if not can_handle_apt(cleaner, task, settings):
        return []
    best: List[float] = []
    for pos in range(len(cleaner.route) + 1):
        d, _ = delta_insert_cost(cleaner.route, task, pos)
        if math.isinf(d):
            continue
        d += premium_soft_penalty(cleaner, task)
        best.append(d)
    best.sort()
    return best[:REGRET_K]

def two_opt_inplace(cleaner: Cleaner) -> None:
    r = cleaner.route
    if len(r) < 4:
        return
    improved = True
    while improved:
        improved = False
        base, _ = evaluate_route_cost(r)
        best_delta = 0.0
        best_i, best_k = -1, -1
        for i in range(1, len(r) - 2):
            for k in range(i + 1, len(r) - 1):
                candidate = r[:i] + list(reversed(r[i : k + 1])) + r[k + 1 :]
                new, _ = evaluate_route_cost(candidate)
                delta = new - base
                if delta < best_delta:
                    best_delta = delta
                    best_i, best_k = i, k
        if best_delta < -1e-6:
            r[:] = r[:best_i] + list(reversed(r[best_i : best_k + 1])) + r[best_k + 1 :]
            improved = True

# =============================
# IO
# =============================
def load_settings() -> Optional[Dict[str, Any]]:
    if INPUT_SETTINGS.exists():
        try:
            return json.loads(INPUT_SETTINGS.read_text(encoding="utf-8"))
        except Exception:
            return None
    return None

def load_cleaners() -> List[Cleaner]:
    data = json.loads(INPUT_CLEANERS.read_text(encoding="utf-8"))
    cleaners: List[Cleaner] = []
    for c in data.get("cleaners", []):
        role = (c.get("role") or "").strip()
        if role.lower() == "formatore":
            continue
        is_premium = bool(c.get("premium", (role.lower() == "premium")))
        cleaners.append(Cleaner(
            id=c.get("id"),
            name=c.get("name") or str(c.get("id")),
            lastname=c.get("lastname", ""),
            telegram_id=c.get("telegram_id"),
            role=role or ("Premium" if is_premium else "Standard"),
            is_premium=is_premium,
            home_lat=c.get("home_lat"),
            home_lng=c.get("home_lng"),
        ))
    return cleaners

def load_tasks() -> List[Task]:
    data = json.loads(INPUT_TASKS.read_text(encoding="utf-8"))
    tasks: List[Task] = []
    for t in data.get("early_out_tasks", []):
        checkout = hhmm_to_min(t.get("checkout_time"), default="10:00")
        checkin  = hhmm_to_min(t.get("checkin_time"),  default="23:59")
        tasks.append(Task(
            task_id=str(t.get("task_id") or t.get("id")),
            logistic_code=str(t.get("logistic_code")) if t.get("logistic_code") else None,
            lat=float(t.get("lat")),
            lng=float(t.get("lng")),
            cleaning_time=int(t.get("cleaning_time") or t.get("duration") or 45),
            checkout_time=checkout,
            checkin_time=checkin,
            is_premium=bool(t.get("premium", False)),
            apt_type=t.get("type_apt") or t.get("apartment_type"),
            address=t.get("address"),
            alias=t.get("alias"),
            small_equipment=bool(t.get("small_equipment", False)),
        ))
    return tasks

# =============================
# Planner
# =============================
def plan_day(tasks: List[Task], cleaners: List[Cleaner], settings: Optional[Dict[str, Any]]) -> Tuple[List[Cleaner], List[Task]]:
    unassigned = tasks[:]
    while unassigned:
        best_choice: Optional[Tuple[Task, Cleaner]] = None
        best_new_route: Optional[List[Task]] = None
        best_delta = float("inf")
        best_regret = -1.0

        for task in list(unassigned):
            per_cleaner_best: List[Tuple[Cleaner, float, float]] = []
            for cl in cleaners:
                ds = best_k_positions(cl, task, settings)
                if ds:
                    first = ds[0]
                    second = ds[1] if len(ds) > 1 else (first + 60.0)
                    per_cleaner_best.append((cl, first, second))
            if not per_cleaner_best:
                continue
            per_cleaner_best.sort(key=lambda x: x[1])
            c1, d1, d2 = per_cleaner_best[0]
            regret = d2 - d1

            candidate = (float("inf"), None, None)
            if len(c1.route) < MAX_TASKS_PER_CLEANER:
                for pos in range(len(c1.route) + 1):
                    d, new_r = delta_insert_cost(c1.route, task, pos)
                    if math.isinf(d):
                        continue
                    d += premium_soft_penalty(c1, task)
                    if d < candidate[0]:
                        candidate = (d, pos, new_r)

            if candidate[1] is None:
                continue

            if (regret > best_regret) or (abs(regret - best_regret) < 1e-6 and candidate[0] < best_delta):
                best_choice = (task, c1)
                best_delta = candidate[0]
                best_new_route = candidate[2]  # type: ignore
                best_regret = regret

        if best_choice is None:
            break

        task, chosen_cleaner = best_choice
        chosen_cleaner.route = best_new_route  # type: ignore
        chosen_cleaner.insertions_since_opt += 1
        if chosen_cleaner.insertions_since_opt >= MAX_LOCAL_2OPT_EVERY:
            two_opt_inplace(chosen_cleaner)
            chosen_cleaner.insertions_since_opt = 0
        unassigned.remove(task)

    return cleaners, unassigned

# =============================
# Export (formato con cleaners e task nidificate)
# =============================
def build_output(cleaners: List[Cleaner], unassigned: List[Task]) -> Dict[str, Any]:
    cleaners_with_tasks: List[Dict[str, Any]] = []
    
    for cl in cleaners:
        if not cl.route:
            continue
            
        cost, schedule = evaluate_route_cost(cl.route)
        tasks_list: List[Dict[str, Any]] = []
        
        for idx, (t, (arr, start, fin)) in enumerate(zip(cl.route, schedule)):
            task_data = {
                "task_id": int(t.task_id),
                "logistic_code": int(t.logistic_code) if t.logistic_code else int(t.task_id),
                "address": t.address,
                "premium": t.is_premium,
                "cleaning_time": t.cleaning_time,
                "start_time": min_to_hhmm(start),
                "end_time": min_to_hhmm(fin),
                "followup": idx > 0
            }
            tasks_list.append(task_data)
        
        cleaner_data = {
            "cleaner": {
                "id": cl.id,
                "name": cl.name,
                "lastname": getattr(cl, 'lastname', ''),
                "role": cl.role,
                "premium": cl.is_premium
            },
            "tasks": tasks_list
        }
        cleaners_with_tasks.append(cleaner_data)
    
    unassigned_list: List[Dict[str, Any]] = []
    for t in unassigned:
        unassigned_list.append({
            "task_id": int(t.task_id),
            "logistic_code": int(t.logistic_code) if t.logistic_code else int(t.task_id),
            "address": t.address,
            "reason": "no feasible cleaner/window (end < checkin required)"
        })

    total_assigned = sum(len(c["tasks"]) for c in cleaners_with_tasks)
    
    return {
        "early_out_tasks_assigned": cleaners_with_tasks,
        "unassigned_tasks": unassigned_list,
        "meta": {
            "total_tasks": total_assigned + len(unassigned_list),
            "assigned": total_assigned,
            "unassigned": len(unassigned_list),
            "cleaners_used": len(cleaners_with_tasks),
            "max_tasks_per_cleaner": MAX_TASKS_PER_CLEANER,
            "algorithm": "regret_insertion_2opt",
            "notes": [
                f"Max {MAX_TASKS_PER_CLEANER} tasks per cleaner",
                "Realistic travel model with equipment awareness",
                "Check-in time hard constraint (finish < checkin)",
                "Premium/Standard soft preferences"
            ]
        }
    }

# =============================
# Main
# =============================
if __name__ == "__main__":
    if not INPUT_TASKS.exists():
        raise SystemExit(f"Missing {INPUT_TASKS}")
    if not INPUT_CLEANERS.exists():
        raise SystemExit(f"Missing {INPUT_CLEANERS}")

    settings = load_settings()
    cleaners = load_cleaners()
    tasks = load_tasks()

    print(f"Caricati {len(tasks)} task e {len(cleaners)} cleaners")

    planners, leftovers = plan_day(tasks, cleaners, settings)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    output_data = build_output(planners, leftovers)

    with OUTPUT_ASSIGN.open("w", encoding="utf-8") as f:
        json.dump(output_data, f, ensure_ascii=False, indent=2)

    print(f"✅ Scritto {OUTPUT_ASSIGN}")
    print(f"   Assegnate: {output_data['meta']['assigned']}")
    print(f"   Non assegnate: {output_data['meta']['unassigned']}")

    # Aggiorna anche timeline_assignments.json
    timeline_data = {"assignments": []}
    if TIMELINE_ASSIGNMENTS.exists():
        try:
            timeline_data = json.loads(TIMELINE_ASSIGNMENTS.read_text(encoding="utf-8"))
        except:
            pass

    # Rimuovi vecchie assegnazioni early-out
    assigned_codes = set()
    for cleaner_entry in output_data["early_out_tasks_assigned"]:
        for task in cleaner_entry.get("tasks", []):
            assigned_codes.add(str(task["logistic_code"]))
    
    timeline_data["assignments"] = [
        a for a in timeline_data.get("assignments", [])
        if str(a.get("logistic_code")) not in assigned_codes
    ]

    # Aggiungi nuove assegnazioni
    for cleaner_entry in output_data["early_out_tasks_assigned"]:
        cleaner_id = cleaner_entry["cleaner"]["id"]
        for task in cleaner_entry.get("tasks", []):
            timeline_data["assignments"].append({
                "logistic_code": str(task["logistic_code"]),
                "cleanerId": cleaner_id,
                "assignment_type": "smista_button"
            })

    with TIMELINE_ASSIGNMENTS.open("w", encoding="utf-8") as f:
        json.dump(timeline_data, f, ensure_ascii=False, indent=2)

    print(f"✅ Aggiornato {TIMELINE_ASSIGNMENTS}")