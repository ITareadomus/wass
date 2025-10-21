# -*- coding: utf-8 -*-
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path
import json, math
from math import radians, sin, cos, sqrt, atan2

# =============================
# I/O paths (kept identical)
# =============================
BASE = Path(__file__).parent.parent / "data"

INPUT_TASKS = BASE / "output" / "early_out.json"
INPUT_CLEANERS = BASE / "cleaners" / "selected_cleaners.json"
OUTPUT_ASSIGN = BASE / "output" / "early_out_assignments.json"

# =============================
# Core rules (as requested)
# =============================
NEAR_THRESHOLD_MIN = 15.0            # prefer hops <= 15'
THIRD_TASK_ALLOW_MAX_MIN = 10.0      # allow a 3rd task only if hop <= 10'
MAX_TASKS_PER_CLEANER = 3            # but rule above constrains the 3rd

# =============================
# Data models
# =============================
@dataclass
class Task:
    task_id: str
    logistic_code: str
    lat: Optional[float]
    lng: Optional[float]
    cleaning_time: int
    checkin_time: Optional[int] = None   # minutes from 00:00 if present
    checkout_time: Optional[int] = None  # minutes from 00:00 if present
    is_premium: bool = False
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

    def last_loc(self) -> Optional[Tuple[float, float]]:
        if self.route and self.route[-1].lat is not None and self.route[-1].lng is not None:
            return (self.route[-1].lat, self.route[-1].lng)
        if self.home_lat is not None and self.home_lng is not None:
            return (self.home_lat, self.home_lng)
        return None  # unknown

# =============================
# Utils
# =============================
def hhmm_to_min(hhmm: Optional[str], default: Optional[int] = None) -> Optional[int]:
    if not hhmm:
        return default
    try:
        hh, mm = hhmm.split(":")
        return int(hh) * 60 + int(mm)
    except Exception:
        return default

def min_to_hhmm(m: Optional[int]) -> Optional[str]:
    if m is None:
        return None
    m = int(round(m))
    h = m // 60
    mm = m % 60
    return f"{h:02d}:{mm:02d}"

def haversine_km(lat1, lon1, lat2, lon2) -> float:
    R = 6371.0
    dlat = radians((lat2 or 0.0) - (lat1 or 0.0))
    dlon = radians((lon2 or 0.0) - (lon1 or 0.0))
    u = sin(dlat/2)**2 + cos(radians(lat1 or 0.0))*cos(radians(lat2 or 0.0))*sin(dlon/2)**2
    return 2*R*atan2(sqrt(u), sqrt(1-u))

def travel_minutes(a: Optional[Tuple[float, float]], b: Optional[Tuple[float, float]]) -> float:
    # If we miss a location, assume 0 (best-effort to not block assignments)
    if a is None or b is None:
        return 0.0
    km = haversine_km(a[0], a[1], b[0], b[1])
    # Simple mapping: 3.5' overhead + 12'/km (tunable)
    return 3.5 + 12.0 * km

# =============================
# Loading
# =============================
def load_cleaners() -> List[Cleaner]:
    raw = json.loads(INPUT_CLEANERS.read_text(encoding="utf-8"))
    # Il file selected_cleaners.json ha la struttura: {"cleaners": [...], "total_selected": N}
    cleaners_list = raw.get("cleaners", raw) if isinstance(raw, dict) else raw
    cleaners: List[Cleaner] = []
    for c in cleaners_list:
        cleaners.append(Cleaner(
            id=c.get("id"),
            name=c.get("name", ""),
            lastname=c.get("lastname", ""),
            role=c.get("role", ""),
            is_premium=bool(c.get("premium") or c.get("is_premium")),
            home_lat=c.get("lat") if c.get("lat") is not None else c.get("home_lat"),
            home_lng=c.get("lng") if c.get("lng") is not None else c.get("home_lng"),
        ))
    return cleaners

def load_tasks() -> List[Task]:
    raw = json.loads(INPUT_TASKS.read_text(encoding="utf-8"))
    tasks: List[Task] = []
    for t in raw:
        tasks.append(Task(
            task_id=str(t.get("task_id") or t.get("id") or t.get("logistic_code")),
            logistic_code=str(t.get("logistic_code") or t.get("task_id") or t.get("id")),
            lat=t.get("lat"),
            lng=t.get("lng"),
            cleaning_time=int(t.get("cleaning_time", 0) or 0),
            checkin_time=hhmm_to_min(t.get("checkin_time")),
            checkout_time=hhmm_to_min(t.get("checkout_time")),
            is_premium=bool(t.get("premium") or t.get("is_premium")),
            apt_type=t.get("apt_type"),
            address=t.get("address"),
            alias=t.get("alias"),
            small_equipment=bool(t.get("small_equipment", False)),
            straordinaria=bool(t.get("straordinaria", False)),
        ))
    return tasks

# =============================
# Assignment core
# =============================
def can_take(cleaner: Cleaner, hop_minutes: float) -> bool:
    n = len(cleaner.route)
    if n < 2:
        return True
    if n == 2 and hop_minutes <= THIRD_TASK_ALLOW_MAX_MIN:
        return True
    return False

def assign_tasks(cleaners: List[Cleaner], tasks: List[Task]) -> Tuple[List[Cleaner], List[Task]]:
    remaining = tasks[:]
    # Greedy global: pick best hop <=15' if exists, else the best >15'
    while remaining:
        best: Optional[Tuple[int, int, float]] = None  # (ci, ti, minutes)
        best_is_near = False

        for ci, c in enumerate(cleaners):
            if len(c.route) >= MAX_TASKS_PER_CLEANER:
                continue
            c_loc = c.last_loc()
            best_near: Optional[Tuple[int, float]] = None
            best_far: Optional[Tuple[int, float]] = None
            for ti, t in enumerate(remaining):
                hop = travel_minutes(c_loc, (t.lat, t.lng))
                if not can_take(c, hop):
                    continue
                if hop <= NEAR_THRESHOLD_MIN:
                    if best_near is None or hop < best_near[1]:
                        best_near = (ti, hop)
                else:
                    if best_far is None or hop < best_far[1]:
                        best_far = (ti, hop)
            if best_near is not None:
                ti, hop = best_near
                if (best is None) or (not best_is_near) or (hop < best[2]):
                    best = (ci, ti, hop)
                    best_is_near = True
            elif not best_is_near and best_far is not None:
                ti, hop = best_far
                if (best is None) or (hop < best[2]):
                    best = (ci, ti, hop)

        if best is None:
            break

        ci, ti, hop = best
        c = cleaners[ci]
        t = remaining.pop(ti)
        c.route.append(t)

    # Unassigned are whatever remains
    return cleaners, remaining

# =============================
# Schedule + Output
# =============================
def build_schedule(route: List[Task]) -> List[Tuple[int, int, int]]:
    # Very simple sequential schedule ignoring time windows:
    # start = previous_finish + travel, end = start + cleaning_time
    schedule: List[Tuple[int, int, int]] = []
    current_time = 8 * 60  # default start day 08:00 if nothing else
    last_loc: Optional[Tuple[float, float]] = None
    for idx, t in enumerate(route):
        t_loc = (t.lat, t.lng) if (t.lat is not None and t.lng is not None) else None
        hop = travel_minutes(last_loc, t_loc) if idx > 0 else 0.0
        arrival = current_time + int(round(hop))
        start = arrival
        finish = start + int(t.cleaning_time or 0)
        schedule.append((arrival, start, finish))
        current_time = finish
        last_loc = t_loc
    return schedule

def build_output(cleaners: List[Cleaner], unassigned: List[Task], original_tasks: List[Task]) -> Dict[str, Any]:
    cleaners_with_tasks: List[Dict[str, Any]] = []
    for cl in cleaners:
        if not cl.route:
            continue
        schedule = build_schedule(cl.route)
        tasks_list: List[Dict[str, Any]] = []
        prev_finish = None
        for idx, (t, (arr, start, fin)) in enumerate(zip(cl.route, schedule)):
            if idx == 0:
                travel_time = 0
            else:
                travel_time = max(0, start - (prev_finish or start))
            tasks_list.append({
                "logistic_code": int(t.logistic_code) if str(t.logistic_code).isdigit() else t.logistic_code,
                "lat": t.lat,
                "lng": t.lng,
                "address": t.address,
                "alias": t.alias,
                "apt_type": t.apt_type,
                "premium": t.is_premium,
                "cleaning_time": int(t.cleaning_time or 0),
                "start_time": min_to_hhmm(start),
                "end_time": min_to_hhmm(fin),
                "followup": idx > 0,
                "sequence": idx + 1,
                "travel_time": int(travel_time),
            })
            prev_finish = fin
        cleaners_with_tasks.append({
            "cleaner": {
                "id": cl.id,
                "name": cl.name,
                "lastname": cl.lastname,
                "role": cl.role,
                "premium": cl.is_premium,
            },
            "tasks": tasks_list,
        })

    # Assigned logistic codes set
    assigned_codes = set()
    for entry in cleaners_with_tasks:
        for t in entry.get("tasks", []):
            assigned_codes.add(t["logistic_code"])

    # Unassigned list = tasks from original not in assigned_codes
    unassigned_list: List[Dict[str, Any]] = []
    for ot in original_tasks:
        lc = int(ot.logistic_code) if str(ot.logistic_code).isdigit() else ot.logistic_code
        if lc in assigned_codes:
            continue
        unassigned_list.append({
            "logistic_code": lc,
            "lat": ot.lat,
            "lng": ot.lng,
            "checkin_time": min_to_hhmm(ot.checkin_time),
            "checkout_time": min_to_hhmm(ot.checkout_time),
            "alias": ot.alias,
            "apt_type": ot.apt_type,
            "reason": "left unassigned under simplified rules (distance/slots)",
        })

    total_assigned = sum(len(c["tasks"]) for c in cleaners_with_tasks)
    return {
        "early_out_tasks_assigned": cleaners_with_tasks,
        "unassigned_tasks": unassigned_list,
        "meta": {
            "total_tasks": len(original_tasks),
            "assigned": total_assigned,
            "unassigned": len(original_tasks) - total_assigned,
            "cleaners_used": sum(1 for c in cleaners_with_tasks if c.get("tasks")),
            "max_tasks_per_cleaner": max((len(c["tasks"]) for c in cleaners_with_tasks), default=0),
        }
    }

# =============================
# Main
# =============================
if __name__ == "__main__":
    if not INPUT_CLEANERS.exists():
        raise FileNotFoundError(f"Missing cleaners file: {INPUT_CLEANERS}")
    if not INPUT_TASKS.exists():
        raise FileNotFoundError(f"Missing tasks file: {INPUT_TASKS}")

    cleaners = load_cleaners()
    tasks = load_tasks()

    planners, leftovers = assign_tasks(cleaners, tasks)
    output = build_output(planners, leftovers, tasks)

    OUTPUT_ASSIGN.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_ASSIGN.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"✅ Wrote {OUTPUT_ASSIGN}")
