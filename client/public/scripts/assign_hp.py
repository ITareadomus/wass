# -*- coding: utf-8 -*-
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path
import json
from math import radians, sin, cos, sqrt, atan2

# =============================
# I/O paths (kept identical)
# =============================
BASE = Path(__file__).parent.parent / "data"

INPUT_TASKS = BASE / "output" / "high_priority.json"
INPUT_CLEANERS = BASE / "cleaners" / "selected_cleaners.json"
INPUT_EO_ASSIGN = BASE / "output" / "early_out_assignments.json"
OUTPUT_ASSIGN = BASE / "output" / "high_priority_assignments.json"

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
    # Seed from EO
    eo_last_sequence: int = 0
    eo_last_lat: Optional[float] = None
    eo_last_lng: Optional[float] = None
    # Route (HP)
    route: List[Task] = field(default_factory=list)

    def last_loc(self) -> Optional[Tuple[float, float]]:
        if self.route and self.route[-1].lat is not None and self.route[-1].lng is not None:
            return (self.route[-1].lat, self.route[-1].lng)
        if self.eo_last_lat is not None and self.eo_last_lng is not None:
            return (self.eo_last_lat, self.eo_last_lng)
        if self.home_lat is not None and self.home_lng is not None:
            return (self.home_lat, self.home_lng)
        return None

# =============================
# Utils
# =============================
def min_to_hhmm(m: Optional[int]) -> Optional[str]:
    if m is None:
        return None
    m = int(round(m))
    return f"{m//60:02d}:{m%60:02d}"

def haversine_km(lat1, lon1, lat2, lon2) -> float:
    R = 6371.0
    dlat = radians((lat2 or 0.0) - (lat1 or 0.0))
    dlon = radians((lon2 or 0.0) - (lon1 or 0.0))
    u = sin(dlat/2)**2 + cos(radians(lat1 or 0.0))*cos(radians(lat2 or 0.0))*sin(dlon/2)**2
    return 2*R*atan2(sqrt(u), sqrt(1-u))

def travel_minutes(a: Optional[Tuple[float, float]], b: Optional[Tuple[float, float]]) -> float:
    if a is None or b is None:
        return 0.0
    km = haversine_km(a[0], a[1], b[0], b[1])
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
    # Seed EO
    if INPUT_EO_ASSIGN.exists():
        seed = json.loads(INPUT_EO_ASSIGN.read_text(encoding="utf-8"))
        by_id = {cl.id: cl for cl in cleaners}
        for entry in seed.get("early_out_tasks_assigned", []):
            cleaner_info = entry.get("cleaner", {})
            cid = cleaner_info.get("id")
            cl = by_id.get(cid)
            if not cl:
                continue
            tasks = entry.get("tasks", [])
            if not tasks:
                continue
            last = tasks[-1]
            cl.eo_last_sequence = int(last.get("sequence", len(tasks)))
            cl.eo_last_lat = last.get("lat")
            cl.eo_last_lng = last.get("lng")
    return cleaners

def load_tasks() -> List[Task]:
    raw = json.loads(INPUT_TASKS.read_text(encoding="utf-8"))
    # Il file high_priority.json ha la struttura: {"high_priority_tasks": [...], "total_apartments": N}
    tasks_list = raw.get("high_priority_tasks", raw) if isinstance(raw, dict) else raw
    tasks: List[Task] = []
    for t in tasks_list:
        tasks.append(Task(
            task_id=str(t.get("task_id") or t.get("id") or t.get("logistic_code")),
            logistic_code=str(t.get("logistic_code") or t.get("task_id") or t.get("id")),
            lat=t.get("lat"),
            lng=t.get("lng"),
            cleaning_time=int(t.get("cleaning_time", 0) or 0),
            is_premium=bool(t.get("premium") or t.get("is_premium")),
            apt_type=t.get("apt_type"),
            address=t.get("address"),
            alias=t.get("alias"),
            small_equipment=bool(t.get("small_equipment", False)),
            straordinaria=bool(t.get("straordinaria", False)),
        ))
    return tasks

# =============================
# Assignment core (same rules)
# =============================
def can_take(cleaner: Cleaner, hop_minutes: float) -> bool:
    n = len(cleaner.route) + cleaner.eo_last_sequence
    if n < 2:
        return True
    if n == 2 and hop_minutes <= THIRD_TASK_ALLOW_MAX_MIN:
        return True
    return False

def assign_tasks(cleaners: List[Cleaner], tasks: List[Task]) -> Tuple[List[Cleaner], List[Task]]:
    remaining = tasks[:]
    while remaining:
        best: Optional[Tuple[int, int, float]] = None
        best_is_near = False
        for ci, c in enumerate(cleaners):
            if (len(c.route) + c.eo_last_sequence) >= MAX_TASKS_PER_CLEANER:
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
                    best = (ci, ti, hop); best_is_near = True
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
    return cleaners, remaining

# =============================
# Output
# =============================
def build_output(cleaners: List[Cleaner], unassigned: List[Task], total_tasks: int) -> Dict[str, Any]:
    assigned_blocks = []
    cleaners_used = 0
    max_tasks_per_cleaner = 0

    for cl in cleaners:
        if not cl.route:
            continue
        cleaners_used += 1
        max_tasks_per_cleaner = max(max_tasks_per_cleaner, cl.eo_last_sequence + len(cl.route))
        tasks_out = []
        prev_loc = (cl.eo_last_lat, cl.eo_last_lng) if (cl.eo_last_lat is not None and cl.eo_last_lng is not None) else None
        prev_finish = 8*60  # simple rolling schedule
        for idx, t in enumerate(cl.route, start=1):
            hop = int(round(travel_minutes(prev_loc, (t.lat, t.lng)))) if idx > 1 or prev_loc is not None else 0
            start = prev_finish + hop
            end = start + int(t.cleaning_time or 0)
            overall_seq = cl.eo_last_sequence + idx
            tasks_out.append({
                "logistic_code": int(t.logistic_code) if str(t.logistic_code).isdigit() else t.logistic_code,
                "lat": t.lat,
                "lng": t.lng,
                "address": t.address,
                "alias": t.alias,
                "apt_type": t.apt_type,
                "premium": t.is_premium,
                "cleaning_time": int(t.cleaning_time or 0),
                "start_time": min_to_hhmm(start),
                "end_time": min_to_hhmm(end),
                "followup": overall_seq > 1,
                "sequence": overall_seq,
                "travel_time": hop,
            })
            prev_loc = (t.lat, t.lng) if (t.lat is not None and t.lng is not None) else prev_loc
            prev_finish = end

        assigned_blocks.append({
            "cleaner": {
                "id": cl.id,
                "name": cl.name,
                "lastname": cl.lastname,
                "role": cl.role,
                "premium": cl.is_premium,
            },
            "tasks": tasks_out
        })

    unassigned_list: List[Dict[str, Any]] = []
    for t in unassigned:
        lc = int(t.logistic_code) if str(t.logistic_code).isdigit() else t.logistic_code
        unassigned_list.append({
            "logistic_code": lc,
            "lat": t.lat,
            "lng": t.lng,
            "alias": t.alias,
            "apt_type": t.apt_type,
            "reason": "left unassigned under simplified rules (distance/slots)",
        })

    total_assigned = sum(len(block["tasks"]) for block in assigned_blocks)
    return {
        "high_priority_tasks_assigned": assigned_blocks,
        "unassigned_tasks": unassigned_list,
        "meta": {
            "total_tasks": total_tasks,
            "assigned": total_assigned,
            "unassigned": total_tasks - total_assigned,
            "cleaners_used": cleaners_used,
            "max_tasks_per_cleaner": max_tasks_per_cleaner,
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
    out = build_output(planners, leftovers, total_tasks=len(tasks))

    OUTPUT_ASSIGN.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_ASSIGN.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"✅ Wrote {OUTPUT_ASSIGN}")
