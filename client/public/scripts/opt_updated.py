
# -*- coding: utf-8 -*-
from __future__ import annotations
import json, math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path

# =============================
# I/O paths (use uploaded files)
# =============================
INPUT_TASKS    = Path("/mnt/data/early_out.json")
INPUT_CLEANERS = Path("/mnt/data/selected_cleaners.json")
OUTPUT_ASSIGN  = Path("/mnt/data/early_out_assignments.json")

# =============================
# CONFIG
# =============================
MAX_TASKS_PER_CLEANER          = 2
REGRET_K                       = 2

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
PENALTY_PREMIUM_TO_STANDARD    = 8.0   # standard cannot do premium anyway, so unused
SOFT_PENALTY_BASE_KM           = 1.5
ALPHA_SOFT_GEO                 = 45.0 / ((3.0 - SOFT_PENALTY_BASE_KM)**2)  # ~45' a 3 km oltre 1.5km

# Long-hop control (time-based)
LONG_HOP_TIME_MIN = 18.0  # inizia super-penalità
HARD_MAX_GAP = 22.0  # hard cap (minutes) on door-to-door gap between consecutive tasks

HARD_MAX_TRAVEL = 22.0  # hard cap (minutes): hops above this are infeasible

HOP_SURCHARGE     = 120.0
HOP_EXTRA_SLOPE   = 6.0
SOFT_HARD_CAP_MIN = 24.0  # oltre: mega-malus ma non infeasible
HUGE_MALUS        = 20000.0

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
    insertions_since_opt: int = 0

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

def soft_geo_penalty(route: List[Task]) -> float:
    if len(route) <= 1:
        return 0.0
    extra = 0.0
    prev = None
    for t in route:
        if prev is not None:
            km = haversine_km(prev.lat, prev.lng, t.lat, t.lng)
            if km > SOFT_PENALTY_BASE_KM:
                extra += ALPHA_SOFT_GEO * (km - SOFT_PENALTY_BASE_KM) ** 2
        prev = t
    return extra

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

def best_k_positions(cleaner: Cleaner, task: Task) -> List[float]:
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
        # time-based local hop penalty
        if len(cleaner.route) > 0 and pos > 0:
            prev_task = cleaner.route[pos - 1]
            tt = travel_minutes(prev_task, task)
            if tt > SOFT_HARD_CAP_MIN:
                d += HUGE_MALUS
            elif tt > LONG_HOP_TIME_MIN:
                d += HOP_SURCHARGE + HOP_EXTRA_SLOPE * (tt - LONG_HOP_TIME_MIN)
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
    # EO start: 10:00 di default
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
    return tasks

# Planner (premium-first, poi standard)
def plan_day(tasks: List[Task], cleaners: List[Cleaner]) -> Tuple[List[Cleaner], List[Task]]:
    prem = [t for t in tasks if t.is_premium]
    std  = [t for t in tasks if not t.is_premium]
    unassigned = prem + std

    while unassigned:
        chosen = None  # (best_regret, best_delta, task, cleaner, pos, new_route)

        for task in list(unassigned):
            # Build all candidate insertions across ALL cleaners (pos included)
            candidates: List[Tuple[float, Cleaner, int, List[Task]]] = []
            for cl in cleaners:
                if len(cl.route) >= MAX_TASKS_PER_CLEANER:
                    continue
                if not can_handle_premium(cl, task):
                    continue
                best_local: Tuple[float, int, List[Task]] = (float("inf"), -1, [])
                second_local = float("inf")

                for pos in range(len(cl.route) + 1):
                    d, new_r = delta_insert_cost(cl.route, task, pos)
                    if math.isinf(d):
                        continue
                    d += premium_soft_penalty(cl, task)
                    # time-based local hop penalty
                    if len(cl.route) > 0 and pos > 0:
                        prev_task = cl.route[pos - 1]
                        tt = travel_minutes(prev_task, task)
                        if tt > SOFT_HARD_CAP_MIN:
                            d += HUGE_MALUS
                        elif tt > LONG_HOP_TIME_MIN:
                            d += HOP_SURCHARGE + HOP_EXTRA_SLOPE * (tt - LONG_HOP_TIME_MIN)
                    if d < best_local[0]:
                        second_local = best_local[0]
                        best_local = (d, pos, new_r)
                    elif d < second_local:
                        second_local = d

                if best_local[1] != -1:
                    candidates.append((best_local[0], cl, best_local[1], best_local[2]))
                    # Also track second best per-cleaner as a potential global 2nd-best
                    if second_local < float("inf"):
                        candidates.append((second_local, cl, -2, []))  # marker for 2nd best

            if not candidates:
                continue

            # Sort all candidates by delta
            candidates.sort(key=lambda x: x[0])
            best_delta, best_cl, best_pos, best_route = candidates[0]
            # Find the second-best REAL candidate (skip markers with pos==-2 if needed)
            second_delta = None
            for d2, cl2, pos2, _ in candidates[1:]:
                if pos2 != -2:
                    second_delta = d2
                    break
            if second_delta is None:
                # fallback: take next available even if marker
                second_delta = candidates[1][0] if len(candidates) > 1 else (best_delta + 60.0)

            regret = second_delta - best_delta

            # Keep the globally best task-choice by regret, then tie-break on delta
            if chosen is None or (regret > chosen[0]) or (abs(regret - chosen[0]) < 1e-6 and best_delta < chosen[1]):
                chosen = (regret, best_delta, task, best_cl, best_pos, best_route)

        if chosen is None:
            break

        _, _, task, chosen_cleaner, pos, new_route = chosen
        # Apply the chosen insertion
        chosen_cleaner.route = new_route  # type: ignore
        unassigned.remove(task)

    return cleaners, unassigned

def build_output(cleaners: List[Cleaner], unassigned: List[Task]) -> Dict[str, Any]:
    cleaners_with_tasks: List[Dict[str, Any]] = []
    for cl in cleaners:
        if not cl.route:
            continue
        # derive schedule to export times
        total, schedule = evaluate_route_cost(cl.route)
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
        "reason": "no feasible cleaner/window"
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
            "algorithm": "regret_insertion",
            "notes": [
                "Premium-first assignment",
                "Time-based long-hop penalties (18–24 soft, 24+ huge malus)",
                "No activation cost for new route",
                "Premium can do standard"
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
