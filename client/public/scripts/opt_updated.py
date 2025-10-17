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
INPUT_TASKS    = BASE / "output" / "early_out.json"
INPUT_CLEANERS = BASE / "cleaners" / "selected_cleaners.json"
OUTPUT_ASSIGN  = BASE / "output" / "early_out_assignments.json"
TIMELINE_ASSIGNMENTS = BASE / "output" / "timeline_assignments.json"

# =============================
# CONFIG
# =============================
MAX_TASKS_PER_CLEANER          = 3        # <-- 3, but see the 3rd-task rule below
REGRET_K                       = 2

# Caps (hard)
HARD_MAX_TRAVEL = 22.0  # minutes of travel between consecutive tasks: beyond => infeasible
HARD_MAX_GAP    = 22.0  # door-to-door gap (start_B - end_A): beyond => infeasible

# 3rd task exception thresholds
THIRD_TASK_MAX_TRAVEL = 10.0  # default travel cap for 3rd task (2->3 hop)
THIRD_TASK_MAX_GAP    = 10.0  # default door-to-door cap for 3rd task
THIRD_TASK_SAME_STREET_TRAVEL = 12.0  # relaxed if same street/building
THIRD_TASK_SAME_STREET_GAP    = 12.0

# Travel model parameters (time in minutes)
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

# Penalties
ACTIVATION_COST                = 0.0
PENALTY_STANDARD_TO_PREMIUM    = 0.0   # premium can do standard without malus

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

# Utils
def hhmm_to_min(hhmm: Optional[str], default: str = "10:00") -> int:
    if not hhmm or not isinstance(hhmm, str) or ":" not in hhmm:
        hhmm = default
    h, m = hhmm.strip().split(":")
    return int(h)*60 + int(m)

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
    import math
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dl/2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))
    return R * c

# Travel model: minutes between tasks
def travel_minutes(a: Optional[Task], b: Optional[Task]) -> float:
    if a is None or b is None:
        return 0.0
    km = haversine_km(a.lat, a.lng, b.lat, b.lng)

    # same building → turnover only
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

# Eligibility & soft penalties
def can_handle_premium(cleaner: Cleaner, task: Task) -> bool:
    return False if (task.is_premium and not cleaner.is_premium) else True

def premium_soft_penalty(cleaner: Cleaner, task: Task) -> float:
    return PENALTY_STANDARD_TO_PREMIUM if (not task.is_premium and cleaner.is_premium) else 0.0

# Core schedule evaluators
def evaluate_route_cost(route: List[Task]) -> Tuple[float, List[Tuple[int, int, int]]]:
    if not route:
        return 0.0, []
    total = ACTIVATION_COST
    schedule: List[Tuple[int, int, int]] = []
    prev: Optional[Task] = None
    prev_finish: Optional[float] = None
    cur = 0.0
    for i, t in enumerate(route):
        tt = travel_minutes(prev, t)
        total += tt
        # Hard cap on travel (always)
        if tt > HARD_MAX_TRAVEL:
            return float("inf"), []
        cur += tt
        arrival = cur
        wait = max(0.0, t.checkout_time - arrival)
        total += wait
        cur += wait
        start = cur
        finish = start + t.cleaning_time

        # Hard cap on door-to-door gap (always)
        if prev_finish is not None and (start - prev_finish) > HARD_MAX_GAP:
            return float("inf"), []

        # 3rd task rule (i == 2)
        if i == 2 and prev is not None:
            # thresholds: relaxed if same street/building from prev->t
            relax = same_building(prev.address, t.address) or same_street(prev.address, t.address)
            t_travel_cap = THIRD_TASK_SAME_STREET_TRAVEL if relax else THIRD_TASK_MAX_TRAVEL
            t_gap_cap    = THIRD_TASK_SAME_STREET_GAP    if relax else THIRD_TASK_MAX_GAP
            door2door = start - prev_finish if prev_finish is not None else 0.0
            if tt > t_travel_cap or door2door > t_gap_cap:
                return float("inf"), []

        if finish >= t.checkin_time:
            return float("inf"), []

        total += t.cleaning_time
        cur = finish
        schedule.append((int(arrival), int(start), int(finish)))
        prev = t
        prev_finish = finish
    return total, schedule

def delta_insert_cost(route: List[Task], task: Task, pos: int) -> Tuple[float, List[Task]]:
    base, _ = evaluate_route_cost(route)
    new_route = route[:pos] + [task] + route[pos:]
    new, _ = evaluate_route_cost(new_route)
    return new - base, new_route

def best_k_positions(cleaner: Cleaner, task: Task) -> List[float]:
    # capacity quick check: allow up to 3, but only if 3rd satisfies local rule (enforced via evaluate_route_cost anyway)
    if len(cleaner.route) >= MAX_TASKS_PER_CLEANER:
        return []
    if not can_handle_premium(cleaner, task):
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

# Simple 2-opt that respects hard caps via evaluate_route_cost
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
                candidate = r[:i] + list(reversed(r[i:k+1])) + r[k+1:]
                new, _ = evaluate_route_cost(candidate)
                delta = new - base
                if delta < best_delta:
                    best_delta = delta
                    best_i, best_k = i, k
        if best_delta < -1e-6:
            r[:] = r[:best_i] + list(reversed(r[best_i:best_k+1])) + r[best_k+1:]
            improved = True

# Loaders
def load_cleaners() -> List[Cleaner]:
    data = json.loads(INPUT_CLEANERS.read_text(encoding="utf-8"))
    cleaners: List[Cleaner] = []
    for c in data.get("cleaners", []):
        role = (c.get("role") or "").strip()
        is_premium = bool(c.get("premium", (role.lower() == "premium")))
        if (role or "").lower() == "formatore":
            continue
        cleaners.append(Cleaner(
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
        checkout = hhmm_to_min(t.get("checkout_time"), default="10:00")
        if checkout < eo_start_min:
            checkout = eo_start_min
        checkin  = hhmm_to_min(t.get("checkin_time"),  default="23:59")
        tasks.append(Task(
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
        ))
    # Premium-first, then by checkout
    tasks.sort(key=lambda x: (not x.is_premium, x.checkout_time))
    return tasks

# Planner (premium-first, regret insertion)
def plan_day(tasks: List[Task], cleaners: List[Cleaner]) -> Tuple[List[Cleaner], List[Task]]:
    unassigned = tasks[:]
    while unassigned:
        chosen = None  # (regret, delta, task, cleaner, pos, new_route)
        for task in list(unassigned):
            per_cleaner_best: List[Tuple[Cleaner, float, float, int, List[Task]]] = []
            for cl in cleaners:
                if len(cl.route) >= MAX_TASKS_PER_CLEANER:
                    continue
                if not can_handle_premium(cl, task):
                    continue
                # evaluate every position
                best_local = (float("inf"), -1, [])  # (delta, pos, new_route)
                second_local = float("inf")
                for pos in range(len(cl.route)+1):
                    d, new_r = delta_insert_cost(cl.route, task, pos)
                    if math.isinf(d):
                        continue
                    if d < best_local[0]:
                        second_local = best_local[0]
                        best_local = (d, pos, new_r)
                    elif d < second_local:
                        second_local = d
                if best_local[1] != -1:
                    per_cleaner_best.append((cl, best_local[0], second_local, best_local[1], best_local[2]))
            if not per_cleaner_best:
                continue
            per_cleaner_best.sort(key=lambda x: x[1])
            d1_cl, d1, d2, pos1, route1 = per_cleaner_best[0][0], per_cleaner_best[0][1], per_cleaner_best[0][2], per_cleaner_best[0][3], per_cleaner_best[0][4]
            # get a true global second-best
            second_delta = None
            for c, dd1, dd2, ppos, rroute in per_cleaner_best[1:]:
                second_delta = dd1
                break
            if second_delta is None:
                second_delta = d1 + 60.0
            regret = second_delta - d1
            if (chosen is None) or (regret > chosen[0]) or (abs(regret - chosen[0]) < 1e-6 and d1 < chosen[1]):
                chosen = (regret, d1, task, d1_cl, pos1, route1)
        if chosen is None:
            break
        _, _, task, cl, pos, new_r = chosen
        cl.route = new_r  # commit
        unassigned.remove(task)
    return cleaners, unassigned

def build_output(cleaners: List[Cleaner], unassigned: List[Task]) -> Dict[str, Any]:
    cleaners_with_tasks: List[Dict[str, Any]] = []
    for cl in cleaners:
        if not cl.route:
            continue
        # derive schedule to export times
        total, schedule = evaluate_route_cost(cl.route)
        if math.isinf(total) or not schedule:
            continue
        tasks_list: List[Dict[str, Any]] = []
        for idx, (t, (arr, start, fin)) in enumerate(zip(cl.route, schedule)):
            tasks_list.append({
                "task_id": int(t.task_id),
                "logistic_code": int(t.logistic_code),
                "address": t.address,
                "premium": t.is_premium,
                "cleaning_time": t.cleaning_time,
                "start_time": min_to_hhmm(start),
                "end_time": min_to_hhmm(fin),
                "followup": idx > 0,
                "sequence": idx + 1
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
    unassigned_list = [{
        "task_id": int(t.task_id),
        "logistic_code": int(t.logistic_code),
        "address": t.address,
        "reason": "no feasible cleaner/window (caps or 3rd-task rule)"
    } for t in unassigned]

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
            "algorithm": "regret_insertion (3rd-task rule)",
            "notes": [
                "Premium-first assignment",
                "Hard cap: travel > 22' or gap > 22' infeasible",
                "3rd task allowed only if travel<=10' and gap<=10' (12'/12' if same street/building)",
                "No activation cost; premium can do standard"
            ]
        }
    }

def main():
    if not INPUT_TASKS.exists() or not INPUT_CLEANERS.exists():
        raise SystemExit("Missing input files.")
    cleaners = load_cleaners()
    tasks = load_tasks()
    planners, leftovers = plan_day(tasks, cleaners)
    output = build_output(planners, leftovers)
    OUTPUT_ASSIGN.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"✅ Wrote {OUTPUT_ASSIGN}")

if __name__ == "__main__":
    main()