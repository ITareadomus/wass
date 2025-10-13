"""
Rules implemented:
- Early-out start at 10:00 by default.
- If task "checkout_time" is null/empty, default it to "10:00".
- Add "start_time" and "end_time" ONLY inside "assigned_cleaner", placed
  immediately AFTER the "telegram_id" field, and nowhere else.
  end_time = start_time + cleaning_time (minutes).
- Premium tasks must be assigned ONLY to premium cleaners (role == "Premium").
- Priority: assign ALL premium tasks first to premium cleaners, then assign the rest.
- Load balancing across cleaners while allowing reuse (a cleaner can get multiple tasks).
"""

# -*- coding: utf-8 -*-
from __future__ import annotations
import json
from datetime import datetime, timedelta
from collections import defaultdict
from typing import Any, Dict, List, Optional

DEFAULT_START_TIME = "10:00"
DEFAULT_EO_TIME = "10:00"

CLEANERS_PATH = "client/public/data/cleaners/selected_cleaners.json"
TASKS_PATH    = "client/public/data/output/early_out.json"
OUTPUT_PATH   = "client/public/data/output/early_out_assignments.json"

def load_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def save_json(path: str, data: Any) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def normalize_checkout_time(val: Optional[str]) -> str:
    if val is None:
        return DEFAULT_EO_TIME
    if isinstance(val, str) and val.strip().lower() in ("", "null", "none"):
        return DEFAULT_EO_TIME
    return val

def is_premium_cleaner(cleaner: Dict[str, Any]) -> bool:
    return str(cleaner.get("role", "")).strip().lower() == "premium"

def is_premium_task(task: Dict[str, Any]) -> bool:
    if bool(task.get("premium")):
        return True
    return str(task.get("task_type", "")).strip().lower() == "premium"

def is_available(cleaner: Dict[str, Any]) -> bool:
    return cleaner.get("active", True) and cleaner.get("available", True)

def ident_of(cleaner: Dict[str, Any]) -> str:
    return str(cleaner.get("id") or cleaner.get("cleaner_id") or cleaner.get("name") or "")

def parse_hhmm(hhmm: str) -> datetime:
    return datetime.strptime(hhmm, "%H:%M")

def fmt_hhmm(dt: datetime) -> str:
    return dt.strftime("%H:%M")

def compute_end_time(start_time_str: str, cleaning_minutes: Optional[int]) -> Optional[str]:
    if cleaning_minutes is None:
        return None
    dt = parse_hhmm(start_time_str) + timedelta(minutes=int(cleaning_minutes))
    return fmt_hhmm(dt)

def reorder_cleaner_with_times(cleaner: Dict[str, Any], start_time: str, end_time: Optional[str]) -> Dict[str, Any]:
    c = dict(cleaner)
    c.pop("start_time", None)
    c.pop("end_time", None)

    new_items = []
    inserted = False
    for k, v in c.items():
        new_items.append((k, v))
        if k == "telegram_id" and not inserted:
            new_items.append(("start_time", start_time))
            new_items.append(("end_time", end_time))
            inserted = True
    if not inserted:
        new_items.append(("start_time", start_time))
        new_items.append(("end_time", end_time))

    out: Dict[str, Any] = {}
    for k, v in new_items:
        out[k] = v
    return out

def pick_balanced(candidates: List[Dict[str, Any]], assign_counts: Dict[str, int]) -> Optional[Dict[str, Any]]:
    if not candidates:
        return None
    chosen = sorted(candidates, key=lambda c: (assign_counts.get(ident_of(c), 0), ident_of(c).lower()))[0]
    assign_counts[ident_of(chosen)] = assign_counts.get(ident_of(chosen), 0) + 1
    return chosen

def enrich_task(task: Dict[str, Any],
                primary_pool: List[Dict[str, Any]],
                assign_counts: Dict[str, int],
                secondary_pool: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    t = dict(task)
    t["checkout_time"] = normalize_checkout_time(t.get("checkout_time"))
    task_start = t.get("start_time") or DEFAULT_START_TIME
    task_end = compute_end_time(task_start, t.get("cleaning_time"))
    chosen = pick_balanced(primary_pool, assign_counts)
    if not chosen and secondary_pool is not None:
        chosen = pick_balanced(secondary_pool, assign_counts)
    t.pop("start_time", None)
    t.pop("end_time", None)
    if chosen:
        t["assigned_cleaner"] = reorder_cleaner_with_times(chosen, task_start, task_end)
        t["assignment_status"] = "assigned"
    else:
        t["assigned_cleaner"] = None
        t["assignment_status"] = "unassigned_no_cleaners"
    return t

def main() -> None:
    cleaners_data = load_json(CLEANERS_PATH)
    early_out_data = load_json(TASKS_PATH)

    cleaners = cleaners_data.get("cleaners", cleaners_data if isinstance(cleaners_data, list) else [])
    tasks = early_out_data.get("early_out_tasks", early_out_data if isinstance(early_out_data, list) else [])

    for t in tasks:
        t["checkout_time"] = normalize_checkout_time(t.get("checkout_time"))

    active = [c for c in cleaners if c.get("active", True)]
    available = [c for c in active if is_available(c)]
    premium_available = [c for c in available if is_premium_cleaner(c)]
    nonpremium_available = [c for c in available if not is_premium_cleaner(c)]

    premium_tasks = [t for t in tasks if is_premium_task(t)]
    nonpremium_tasks = [t for t in tasks if not is_premium_task(t)]

    assign_counts: Dict[str, int] = defaultdict(int)
    assigned_items: List[Dict[str, Any]] = []

    for t in premium_tasks:
        enriched = enrich_task(t, premium_available, assign_counts, None)
        if enriched["assigned_cleaner"] is None:
            enriched["assignment_status"] = "unassigned_premium_rule"
        assigned_items.append(enriched)

    for t in nonpremium_tasks:
        enriched = enrich_task(t, nonpremium_available, assign_counts, premium_available)
        assigned_items.append(enriched)

    def task_key(tt: Dict[str, Any]) -> Any:
        return tt.get("id") or tt.get("task_id")

    assigned_map = {task_key(x): x for x in assigned_items}
    assigned_sorted = [assigned_map.get(task_key(t), t) for t in tasks]

    output = {
        "early_out_tasks_assigned": assigned_sorted,
        "meta": {
            "total_tasks": len(tasks),
            "premium_tasks": len(premium_tasks),
            "nonpremium_tasks": len(nonpremium_tasks),
            "assigned": sum(1 for x in assigned_sorted if x.get("assignment_status") == "assigned"),
            "unassigned": sum(1 for x in assigned_sorted if x.get("assignment_status", "").startswith("unassigned")),
            "notes": [
                "checkout_time defaulted to 10:00 where missing/null",
                "start_time/end_time appear only once and only inside assigned_cleaner, right after telegram_id",
                "end_time = start_time + cleaning_time (minutes)",
                "premium tasks assigned only to premium cleaners first; then others",
                "priority: premium tasks first, then non-premium (balanced reuse)"
            ]
        }
    }

    save_json(OUTPUT_PATH, output)
    print(f"✅ File salvato: {OUTPUT_PATH}")

if __name__ == "__main__":
    main()