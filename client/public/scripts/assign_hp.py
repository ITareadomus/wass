# -*- coding: utf-8 -*-
from __future__ import annotations
from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any, Tuple
from pathlib import Path
import json, math, re
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
# Travel / gap policy
# =============================
HARD_TRAVEL_CAP = 35.0  # rilassato da 22' per permettere più assegnazioni
REDIRECT_TRAVEL = 25.0  # rilassato da 15' per permettere più assegnazioni

# Travel model (walking-centric)
SHORT_RANGE_KM = 0.30
SHORT_BASE_MIN = 3.5
WALK_SLOW_MIN_PER_KM = 16.0
BASE_OVERHEAD_MIN = 6.0
SCALED_OH_KM = 0.50
WALK_MIN_PER_KM = 12.0

# HP window rules
HP_HARD_EARLIEST_H = 11
HP_HARD_EARLIEST_M = 0
HP_SOFT_LATEST = (15, 30)  # set to None to disable
LATE_PENALTY_PER_MIN = 1.0


# =============================
# Data models
# =============================
@dataclass
class Task:
    task_id: int
    logistic_code: int
    address: str
    lat: float
    lng: float
    cleaning_time: int
    premium: bool
    straordinaria: bool
    checkout_dt: Optional[datetime] = None
    checkin_dt: Optional[datetime] = None
    is_hp_soft: bool = False  # True if no times -> 11:00 hard earliest


@dataclass
class PlacedTask:
    task: Task
    start: datetime
    finish: datetime


@dataclass
class Cleaner:
    id: int
    name: str
    lastname: str
    role: str  # "Premium", "Standard", "Formatore"
    start_time: datetime
    route: List[PlacedTask] = field(default_factory=list)
    # Seeded from EO
    available_from: Optional[datetime] = None
    last_eo_address: Optional[str] = None
    last_eo_lat: Optional[float] = None
    last_eo_lng: Optional[float] = None
    eo_last_sequence: int = 0  # last sequence index from EO (0 if none)


# =============================
# Helpers
# =============================
def parse_dt(d: Optional[str], t: Optional[str]) -> Optional[datetime]:
    if not d or not t:
        return None
    try:
        return datetime.strptime(f"{d} {t}", "%Y-%m-%d %H:%M")
    except Exception:
        return None


def hhmm_to_dt(ref_date: str, hhmm: str) -> datetime:
    return datetime.strptime(f"{ref_date} {hhmm}", "%Y-%m-%d %H:%M")


def normalize_addr(addr: Optional[str]) -> str:
    if not addr:
        return ""
    a = addr.upper()
    a = re.sub(r"[^A-Z0-9\s]", " ", a)
    a = re.sub(r"\s+", " ", a).strip()
    return a


def street_only(addr: Optional[str]) -> str:
    a = normalize_addr(addr)
    tokens = [tok for tok in a.split() if not tok.isdigit()]
    return " ".join(tokens)


def same_street(a: Optional[str], b: Optional[str]) -> bool:
    return street_only(a) == street_only(b) and street_only(a) != ""


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    from math import radians, sin, cos, atan2, sqrt
    phi1, phi2 = radians(lat1), radians(lat2)
    dphi = radians(lat2 - lat1)
    dl = radians(lon2 - lon1)
    a = sin(dphi / 2)**2 + cos(phi1) * cos(phi2) * sin(dl / 2)**2
    c = 2 * atan2(sqrt(a), sqrt(1 - a))
    return R * c


def travel_minutes_from_km(km: float) -> float:
    if km <= SHORT_RANGE_KM:
        return SHORT_BASE_MIN + WALK_SLOW_MIN_PER_KM * km
    return BASE_OVERHEAD_MIN + (SCALED_OH_KM * km) + (WALK_MIN_PER_KM * km)


def travel_minutes(lat1: float, lon1: float, lat2: float,
                   lon2: float) -> float:
    return travel_minutes_from_km(haversine_km(lat1, lon1, lat2, lon2))


def minutes(delta: timedelta) -> float:
    return delta.total_seconds() / 60.0


def place_after(when: datetime, t: Task) -> tuple[datetime, datetime]:
    start = max(when, t.checkout_dt) if t.checkout_dt else when
    if t.is_hp_soft:
        hp_earliest = datetime(start.year, start.month, start.day,
                               HP_HARD_EARLIEST_H, HP_HARD_EARLIEST_M)
        start = max(start, hp_earliest)
    finish = start + timedelta(minutes=t.cleaning_time)
    return start, finish


def feasible_time_window(t: Task, start: datetime,
                         finish: datetime) -> tuple[bool, float]:
    if t.checkin_dt is not None and finish > t.checkin_dt:
        return False, float("inf")
    penalty = 0.0
    if t.is_hp_soft and HP_SOFT_LATEST is not None:
        latest_dt = datetime(start.year, start.month, start.day,
                             HP_SOFT_LATEST[0], HP_SOFT_LATEST[1])
        if finish > latest_dt:
            penalty += LATE_PENALTY_PER_MIN * minutes(finish - latest_dt)
    return True, penalty


def insert_cost(
        cleaner: Cleaner, t: Task
) -> tuple[float, Optional[int], Optional[PlacedTask], float, bool]:
    # append-only strategy
    if cleaner.route:
        last = cleaner.route[-1]
        hop_min = travel_minutes(last.task.lat, last.task.lng, t.lat, t.lng)
        start_base = last.finish + timedelta(minutes=hop_min)
        infeasible_hop = hop_min > HARD_TRAVEL_CAP
        travel_penalty = hop_min if hop_min > REDIRECT_TRAVEL else 0.25 * hop_min
    else:
        # First HP for this cleaner: seed from EO
        base = cleaner.start_time
        if cleaner.available_from:
            base = max(base, cleaner.available_from)
        hop_min = 0.0
        if cleaner.last_eo_lat is not None and cleaner.last_eo_lng is not None:
            hop_min = travel_minutes(cleaner.last_eo_lat, cleaner.last_eo_lng,
                                     t.lat, t.lng)
        else:
            # fallback: if no coords, approximate using street-name similarity
            hop_min = 3.0 if same_street(cleaner.last_eo_address,
                                         t.address) else 12.0
        start_base = base + timedelta(minutes=hop_min)
        infeasible_hop = hop_min > HARD_TRAVEL_CAP
        travel_penalty = hop_min if hop_min > REDIRECT_TRAVEL else 0.25 * hop_min

    start, finish = place_after(start_base, t)
    feas, penalty = feasible_time_window(t, start, finish)
    if not feas:
        return float("inf"), None, None, hop_min, False

    # wait (idle) penalty (kept mild)
    wait_penalty = max(0.0, minutes(start - start_base))
    total_cost = travel_penalty + wait_penalty + penalty
    placed = PlacedTask(task=t, start=start, finish=finish)
    return total_cost, len(cleaner.route), placed, hop_min, infeasible_hop


def assign(tasks: List[Task], cleaners: List[Cleaner]):
    assignment: Dict[int, int] = {}
    unassigned: List[Dict[str, Any]] = []

    def task_key(t: Task):
        base_dt = t.checkin_dt or t.checkout_dt or datetime.now().replace(
            hour=HP_HARD_EARLIEST_H,
            minute=HP_HARD_EARLIEST_M,
            second=0,
            microsecond=0)
        return (not t.straordinaria, not t.premium, base_dt)

    tasks_sorted = sorted(tasks, key=task_key)

    for t in tasks_sorted:
        best_feasible = (float("inf"), None, None, None)
        best_infeasible = (float("inf"), None, None, None)
        for i, cl in enumerate(cleaners):
            if cl.role == "Formatore":
                continue
            if (t.premium or t.straordinaria) and cl.role != "Premium":
                continue
            cost, pos, placed, hop_min, infeasible_hop = insert_cost(cl, t)
            if pos is None:
                continue
            if not infeasible_hop:
                if cost < best_feasible[0]:
                    best_feasible = (cost, i, pos, placed)
            else:
                if hop_min < best_infeasible[0]:
                    best_infeasible = (hop_min, i, pos, placed)
        if best_feasible[1] is not None:
            _, ci, pos, placed = best_feasible
            cleaners[ci].route.append(placed)
            assignment[t.task_id] = cleaners[ci].id
        elif best_infeasible[1] is not None:
            _, ci, pos, placed = best_infeasible
            cleaners[ci].route.append(placed)
            assignment[t.task_id] = cleaners[ci].id
        else:
            unassigned.append({
                "task_id": t.task_id,
                "logistic_code": t.logistic_code,
                "reason": "no_eligible_cleaner_or_time_window"
            })
    return assignment, unassigned


# =============================
# Loading
# =============================
def load_tasks(path: Path) -> List[Task]:
    data = json.loads(path.read_text(encoding="utf-8"))
    res: List[Task] = []
    for raw in data.get("high_priority_tasks", []):
        lat = float(raw.get("lat") or 0.0)
        lng = float(raw.get("lng") or 0.0)
        cleaning_time = int(raw.get("cleaning_time") or 60)
        premium = bool(raw.get("premium"))
        straord = bool(raw.get("straordinaria"))
        ckin = parse_dt(raw.get("checkin_date"), raw.get("checkin_time"))
        ckout = parse_dt(raw.get("checkout_date"), raw.get("checkout_time"))
        is_hp_soft = (ckin is None and ckout is None)
        t = Task(task_id=int(raw["task_id"]),
                 logistic_code=int(raw["logistic_code"]),
                 address=raw.get("address", ""),
                 lat=lat,
                 lng=lng,
                 cleaning_time=cleaning_time,
                 premium=premium,
                 straordinaria=straord,
                 checkout_dt=ckout,
                 checkin_dt=ckin,
                 is_hp_soft=is_hp_soft)
        res.append(t)
    return res


def load_cleaners(path: Path, ref_date: str) -> List[Cleaner]:
    data = json.loads(path.read_text(encoding="utf-8"))
    cl: List[Cleaner] = []
    for raw in data.get("cleaners", []):
        if not raw.get("active") or not raw.get("available"):
            continue
        role = raw.get("role") or "Standard"
        if role == "Formatore":
            continue
        st = (raw.get("start_time") or "10:00")
        try:
            h, m = [int(x) for x in st.split(":")]
        except Exception:
            h, m = 10, 0
        start_dt = datetime.strptime(f"{ref_date} {h:02d}:{m:02d}",
                                     "%Y-%m-%d %H:%M")
        cl.append(
            Cleaner(id=int(raw["id"]),
                    name=str(raw.get("name") or ""),
                    lastname=str(raw.get("lastname") or ""),
                    role=role,
                    start_time=start_dt))
    return cl


def seed_cleaners_from_eo(cleaners: List[Cleaner], eo_path: Path,
                          ref_date: str):
    if not eo_path.exists():
        return
    data = json.loads(eo_path.read_text(encoding="utf-8"))
    for block in data.get("early_out_tasks_assigned", []):
        cid = int(block["cleaner"]["id"])
        tasks = block.get("tasks", [])
        if not tasks:
            continue
        last = tasks[-1]
        end_time = last.get("end_time")  # "HH:MM"
        last_addr = last.get("address")
        last_lat = last.get("lat")
        last_lng = last.get("lng")
        last_seq = last.get("sequence") or len(tasks)
        for cl in cleaners:
            if cl.id == cid:
                cl.available_from = hhmm_to_dt(ref_date, end_time)
                cl.last_eo_address = last_addr
                cl.last_eo_lat = float(
                    last_lat) if last_lat is not None else None
                cl.last_eo_lng = float(
                    last_lng) if last_lng is not None else None
                cl.eo_last_sequence = int(last_seq)
                break


# =============================
# Output
# =============================
def fmt_hhmm(dt: datetime) -> str:
    return dt.strftime("%H:%M")


def build_output(cleaners: List[Cleaner], unassigned: List[Dict[str, Any]],
                 total_tasks: int) -> Dict[str, Any]:
    assigned_blocks = []
    cleaners_used = 0
    max_tasks_per_cleaner = 0

    for cl in cleaners:
        if not cl.route:
            continue
        cleaners_used += 1
        max_tasks_per_cleaner = max(max_tasks_per_cleaner, len(cl.route))
        tasks_out = []
        for idx, p in enumerate(cl.route, start=1):
            # overall sequence should include EO tasks already done
            overall_seq = cl.eo_last_sequence + idx
            if overall_seq == 1:
                # first task of the day (unlikely for HP) - no travel
                travel_time = 0
            elif idx == 1 and cl.eo_last_sequence >= 1:
                # first HP after EO: compute EO→HP hop using coords if present
                if cl.last_eo_lat is not None and cl.last_eo_lng is not None:
                    hop = travel_minutes(cl.last_eo_lat, cl.last_eo_lng,
                                         p.task.lat, p.task.lng)
                    travel_time = int(round(hop))
                else:
                    travel_time = 0 if same_street(cl.last_eo_address,
                                                   p.task.address) else 12
            else:
                # hop from previous HP task
                prev = cl.route[idx - 2].task
                hop = travel_minutes(prev.lat, prev.lng, p.task.lat,
                                     p.task.lng)
                travel_time = int(round(hop))
            tasks_out.append({
                "task_id": p.task.task_id,
                "logistic_code": p.task.logistic_code,
                "address": p.task.address,
                "lat": p.task.lat,
                "lng": p.task.lng,
                "premium": bool(p.task.premium),
                "cleaning_time": int(p.task.cleaning_time),
                "start_time": fmt_hhmm(p.start),
                "end_time": fmt_hhmm(p.finish),
                "followup": (overall_seq > 1),
                "sequence": overall_seq,
                "travel_time": travel_time
            })
        assigned_blocks.append({
            "cleaner": {
                "id": cl.id,
                "name": cl.name,
                "lastname": cl.lastname,
                "role": cl.role,
                "premium": (cl.role == "Premium")
            },
            "tasks": tasks_out
        })

    assigned_count = sum(len(block["tasks"]) for block in assigned_blocks)
    out = {
        "high_priority_tasks_assigned": assigned_blocks,
        "unassigned_tasks": unassigned,
        "meta": {
            "total_tasks":
            total_tasks,
            "assigned":
            assigned_count,
            "unassigned":
            len(unassigned),
            "cleaners_used":
            cleaners_used,
            "max_tasks_per_cleaner":
            max_tasks_per_cleaner,
            "algorithm":
            "regret_insertion + redirect + best-of-infeasible",
            "notes": [
                "Seed disponibilità e posizione dall'ultima EO (end_time, lat/lng)",
                "Primo hop EO→HP calcolato con haversine sui km reali",
                "HP senza orari: start >= 11:00 (hard), nessun obbligo di iniziare alle 11",
                "Se check-in/out presenti: regole EO (start >= checkout; finire prima del check-in)",
                "Premium/straordinarie solo a Premium; no formatori",
                "Hard cap viaggi: 35' (rilassato per più assegnazioni)",
                "Redirect: se hop > 25' preferisci altro cleaner idoneo (rilassato)",
                "Vincoli rilassati per ridurre task HP non assegnate"
            ]
        }
    }
    return out


def write_output(path: Path, data: Dict[str, Any]):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2),
                    encoding="utf-8")


# =============================
# Main
# =============================
def main():
    tasks = load_tasks(INPUT_TASKS)
    # reference date from first task
    ref_date = None
    for t in tasks:
        ref_date = (t.checkin_dt or t.checkout_dt)
        if ref_date:
            ref_date = ref_date.strftime("%Y-%m-%d")
            break
    if ref_date is None:
        ref_date = datetime.now().strftime("%Y-%m-%d")
    cleaners = load_cleaners(INPUT_CLEANERS, ref_date)
    seed_cleaners_from_eo(cleaners, INPUT_EO_ASSIGN, ref_date)
    assignment, unassigned = assign(tasks, cleaners)

    out = build_output(cleaners, unassigned, total_tasks=len(tasks))
    write_output(OUTPUT_ASSIGN, out)
    print(f"✅ Wrote {OUTPUT_ASSIGN}")


if __name__ == "__main__":
    main()
