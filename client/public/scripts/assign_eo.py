# -*- coding: utf-8 -*-
"""
Assign EARLY-OUT cleaning tasks to cleaners (with diagnostics).

What’s new vs original:
- Adds a diagnostics JSON with summary + lists of unassigned task IDs.
- Optional CSV export.

Usage:
  python assign_eo_with_diag.py \
    --cleaners /path/cleaners.json \
    --tasks /path/early_out.json \
    --out /path/early_out_assignments.json \
    --diag-json /path/early_out_assignment_diagnostics.json \
    [--out-csv /path/early_out_assignments.csv]

Notes:
- Premium tasks -> only Premium cleaners.
- Each cleaner gets max 1 task, unless tasks > cleaners, then cap = 2.
- checkout_time defaults to "10:00" if missing; cleaner start defaults to "10:00".
"""
from __future__ import annotations
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass, field
from datetime import datetime, timedelta
import argparse
import json

# -------------------- Time helpers --------------------
def parse_time_str(t: Optional[str]) -> Optional[datetime]:
    if not t:
        return None
    return datetime.strptime(t, "%H:%M")

def fmt_time(dt: Optional[datetime]) -> Optional[str]:
    return dt.strftime("%H:%M") if dt is not None else None

# -------------------- IO --------------------
def load_cleaners(path: Path) -> List[Dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        cleaners = data
    elif isinstance(data, dict):
        if "cleaners" in data and isinstance(data["cleaners"], list):
            cleaners = data["cleaners"]
        elif "dates" in data and isinstance(data["dates"], dict) and data["dates"]:
            latest_date_key = sorted(data["dates"].keys())[-1]
            cleaners = data["dates"][latest_date_key].get("cleaners", [])
        else:
            cleaners = next((v for v in data.values() if isinstance(v, list)), [])
    else:
        cleaners = []
    for c in cleaners:
        c.setdefault("active", True)
        c.setdefault("available", True)
        role = (c.get("role") or "").strip().capitalize()
        c["role"] = role
        st = c.get("start_time") or "10:00"
        c["_available_from"] = parse_time_str(st) or parse_time_str("10:00")
        c["_assigned_count"] = 0
    cleaners = [c for c in cleaners if c.get("active") and c.get("available")]
    return cleaners

def load_tasks(path: Path) -> List[Dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        tasks = data
    elif isinstance(data, dict):
        tasks = data.get("early_out_tasks") or data.get("tasks")
        if tasks is None:
            dates = data.get("dates")
            if isinstance(dates, dict) and dates:
                latest_date_key = sorted(dates.keys())[-1]
                day_block = dates[latest_date_key]
                tasks = day_block.get("apt") or day_block.get("tasks") or day_block.get("early_out_tasks")
        tasks = tasks or []
    else:
        tasks = []

    norm = []
    for t in tasks:
        checkout_time_str = t.get("checkout_time") or "10:00"
        checkin_time_str = t.get("checkin_time")
        premium = bool(t.get("premium"))
        cleaning_minutes = int(t.get("cleaning_time") or 0)
        norm.append({
            **t,
            "premium": premium,
            "checkout_time": checkout_time_str,
            "checkin_time": checkin_time_str,
            "_checkout_dt": parse_time_str(checkout_time_str),
            "_checkin_dt": parse_time_str(checkin_time_str) if checkin_time_str else None,
            "_cleaning_td": timedelta(minutes=cleaning_minutes),
        })
    norm.sort(key=lambda x: (
        0 if x["premium"] else 1,
        0 if x["_checkin_dt"] is not None else 1,
        x["_checkin_dt"] or datetime.max,
        x["_checkout_dt"],
        x["_cleaning_td"]
    ))
    return norm

# -------------------- Core assignment --------------------
def pick_cleaner(task: Dict[str, Any], cleaners: List[Dict[str, Any]], max_tasks_per_cleaner: int) -> Optional[Dict[str, Any]]:
    pool = [c for c in cleaners if (c["role"] == "Premium") == bool(task.get("premium")) or (not task.get("premium"))]
    pool = [c for c in pool if c["_assigned_count"] < max_tasks_per_cleaner]
    if not pool:
        return None
    def sort_key(c: Dict[str, Any]):
        cleaner_id = c.get("id")
        id_key = int(cleaner_id) if isinstance(cleaner_id, int) else (cleaner_id or "")
        return (c["_assigned_count"], c["_available_from"], id_key)
    pool.sort(key=sort_key)
    return pool[0]

def schedule_task_for_cleaner(task: Dict[str, Any], cleaner: Dict[str, Any]) -> Tuple[Optional[str], Optional[str]]:
    if cleaner is None:
        return None, None
    start_dt = max(task["_checkout_dt"], cleaner["_available_from"])
    end_dt = start_dt + task["_cleaning_td"]
    cleaner["_available_from"] = end_dt
    cleaner["_assigned_count"] += 1
    return fmt_time(start_dt), fmt_time(end_dt)

def assign(cleaners: List[Dict[str, Any]], tasks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    total_tasks = len(tasks)
    total_cleaners = len(cleaners)
    max_tasks_per_cleaner = 1 if total_cleaners >= total_tasks else 2
    assignments: List[Dict[str, Any]] = []
    for t in tasks:
        cleaner = pick_cleaner(t, cleaners, max_tasks_per_cleaner)
        start_time, end_time = schedule_task_for_cleaner(t, cleaner) if cleaner else (None, None)
        assignments.append({
            "task_id": t.get("task_id"),
            "logistic_code": t.get("logistic_code"),
            "client_id": t.get("client_id"),
            "address": t.get("address"),
            "lat": t.get("lat"),
            "lng": t.get("lng"),
            "cleaning_time": t.get("cleaning_time"),
            "checkin_date": t.get("checkin_date"),
            "checkout_date": t.get("checkout_date"),
            "checkin_time": t.get("checkin_time"),
            "checkout_time": t.get("checkout_time"),
            "premium": t.get("premium"),
            "pax_in": t.get("pax_in"),
            "pax_out": t.get("pax_out"),
            "small_equipment": t.get("small_equipment"),
            "confirmed_operation": t.get("confirmed_operation"),
            "straordinaria": t.get("straordinaria"),
            "operation_id": t.get("operation_id"),
            "type_apt": t.get("type_apt"),
            "alias": t.get("alias"),
            "customer_name": t.get("customer_name"),
            "assigned_cleaner_id": cleaner.get("id") if cleaner else None,
            "assigned_cleaner_name": (f"{cleaner.get('name','')} {cleaner.get('lastname','')}".strip() if cleaner else None),
            "assigned_cleaner_role": cleaner.get("role") if cleaner else None,
            "start_time": start_time,
            "end_time": end_time,
        })
    return assignments

# -------------------- Output helpers --------------------
def save_json(obj: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)

def save_csv_from_assignments(assignments: List[Dict[str, Any]], path: Path) -> None:
    if not assignments:
        path.write_text("", encoding="utf-8")
        return
    cols = [
        "task_id","premium","address","checkout_time","checkin_time",
        "cleaning_time","assigned_cleaner_id","assigned_cleaner_name",
        "assigned_cleaner_role","start_time","end_time"
    ]
    with path.open("w", encoding="utf-8") as f:
        f.write(",".join(cols) + "\n")
        for a in assignments:
            row = [str(a.get(c,"") or "") for c in cols]
            row = [x.replace('"','""') for x in row]
            f.write(",".join(row) + "\n")

def diagnostics_from(assignments: List[Dict[str, Any]], tasks: List[Dict[str, Any]]) -> Dict[str, Any]:
    # assigned if assigned_cleaner_id not None
    assigned_ids = [str(a.get("task_id")) for a in assignments if a.get("assigned_cleaner_id") is not None]
    total_tasks = len(tasks)
    unassigned_ids = [str(a.get("task_id")) for a in assignments if a.get("assigned_cleaner_id") is None]
    # For early-out we don't enforce a global end window; set infeasible as 0, but keep the field for consistency.
    diag = {
        "assigned_count": len(assigned_ids),
        "total_tasks": total_tasks,
        "unassigned_count": len(unassigned_ids),
        "infeasible_window_count": 0,
        "unassigned_ids": unassigned_ids[:100]
    }
    return diag

# -------------------- CLI --------------------
def main() -> None:
    ap = argparse.ArgumentParser(description="Assign early-out tasks to cleaners (with diagnostics).")
    repo_root = Path(__file__).resolve().parents[1]
    default_cleaners = repo_root / "data" / "cleaners" / "selected_cleaners.json"
    default_tasks = repo_root / "data" / "output" / "early_out.json"
    default_out = repo_root / "data" / "output" / "early_out_assignments.json"

    ap.add_argument("--cleaners", type=Path, default=default_cleaners, help="Path to cleaners JSON")
    ap.add_argument("--tasks", type=Path, default=default_tasks, help="Path to early-out tasks JSON")
    ap.add_argument("--out", type=Path, default=default_out, help="Path for output assignments JSON")
    args = ap.parse_args()

    cleaners = load_cleaners(args.cleaners)
    tasks = load_tasks(args.tasks)
    assignments = assign(cleaners, tasks)

    save_json(assignments, args.out)
    print(f"[OK] Wrote assignments -> {args.out}")

if __name__ == "__main__":
    main()
