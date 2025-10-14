# -*- coding: utf-8 -*-
"""
Assign early-out tasks to cleaners — ONE TASK PER CLEANER.
Premium first (premium task -> premium cleaner), then others.
Times only inside assigned_cleaner after telegram_id.
"""
from __future__ import annotations
import json
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

DEFAULT_START_TIME = "10:00"
DEFAULT_EO_TIME = "10:00"

# Path relativi al progetto
CLEANERS_PATH = "client/public/data/cleaners/selected_cleaners.json"
TASKS_PATH    = "client/public/data/output/early_out.json"
OUTPUT_PATH   = "client/public/data/output/early_out_assignments.json"
MANUAL_ASSIGNMENTS_PATH = "client/public/data/output/manual_assignments.json"

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

def ident(cleaner: Dict[str, Any]) -> str:
    return str(cleaner.get("id") or cleaner.get("cleaner_id") or cleaner.get("name") or "")

def hhmm(dt: datetime) -> str:
    return dt.strftime("%H:%M")

def parse(h: str) -> datetime:
    return datetime.strptime(h, "%H:%M")

def end_time_for(start: str, minutes: Optional[int]) -> Optional[str]:
    if minutes is None:
        return None
    return hhmm(parse(start) + timedelta(minutes=int(minutes)))

def reorder_cleaner_with_times(cleaner: Dict[str, Any], start_time: str, end_time: Optional[str]) -> Dict[str, Any]:
    c = dict(cleaner)
    c.pop("start_time", None)
    c.pop("end_time", None)
    out_items = []
    inserted = False
    for k, v in c.items():
        out_items.append((k, v))
        if k == "telegram_id" and not inserted:
            out_items.append(("start_time", start_time))
            out_items.append(("end_time", end_time))
            inserted = True
    if not inserted:
        out_items.append(("start_time", start_time))
        out_items.append(("end_time", end_time))
    out: Dict[str, Any] = {}
    for k, v in out_items:
        out[k] = v
    return out

def pick_first_free(candidates: List[Dict[str, Any]], used_ids: set) -> Optional[Dict[str, Any]]:
    for c in candidates:
        if ident(c) not in used_ids:
            used_ids.add(ident(c))
            return c
    return None

def main() -> None:
    cleaners_data = load_json(CLEANERS_PATH)
    early_out_data = load_json(TASKS_PATH)

    cleaners = cleaners_data.get("cleaners", cleaners_data if isinstance(cleaners_data, list) else [])
    tasks = early_out_data.get("early_out_tasks", early_out_data if isinstance(early_out_data, list) else [])

    for t in tasks:
        t["checkout_time"] = normalize_checkout_time(t.get("checkout_time"))

    available = [c for c in cleaners if is_available(c)]
    premium_cleaners = [c for c in available if is_premium_cleaner(c)]
    nonpremium_cleaners = [c for c in available if not is_premium_cleaner(c)]

    premium_tasks = [t for t in tasks if is_premium_task(t)]
    nonpremium_tasks = [t for t in tasks if t not in premium_tasks]

    used_ids: set = set()
    assigned: List[Dict[str, Any]] = []

    # Pass 1
    for t in premium_tasks:
        start = t.get("start_time") or DEFAULT_START_TIME
        end = end_time_for(start, t.get("cleaning_time"))
        chosen = pick_first_free(premium_cleaners, used_ids)
        enriched = dict(t)
        enriched.pop("start_time", None); enriched.pop("end_time", None)
        if chosen:
            enriched["assigned_cleaner"] = reorder_cleaner_with_times(chosen, start, end)
            enriched["assignment_status"] = "assigned"
        else:
            enriched["assigned_cleaner"] = None
            enriched["assignment_status"] = "unassigned_premium_rule"
        assigned.append(enriched)

    # Pass 2
    for t in nonpremium_tasks:
        start = t.get("start_time") or DEFAULT_START_TIME
        end = end_time_for(start, t.get("cleaning_time"))
        chosen = pick_first_free(nonpremium_cleaners, used_ids)
        if not chosen:
            chosen = pick_first_free(premium_cleaners, used_ids)
        enriched = dict(t)
        enriched.pop("start_time", None); enriched.pop("end_time", None)
        if chosen:
            enriched["assigned_cleaner"] = reorder_cleaner_with_times(chosen, start, end)
            enriched["assignment_status"] = "assigned"
        else:
            enriched["assigned_cleaner"] = None
            enriched["assignment_status"] = "unassigned_no_cleaners"
        assigned.append(enriched)

    # keep original order
    def tid(tt: Dict[str, Any]):
        return tt.get("id") or tt.get("task_id")
    amap = {tid(x): x for x in assigned}
    assigned_sorted = [amap.get(tid(t), t) for t in tasks]

    # meta
    unused = [ident(c) for c in available if ident(c) not in used_ids]

    output = {
        "early_out_tasks_assigned": assigned_sorted,
        "meta": {
            "total_tasks": len(tasks),
            "total_cleaners_available": len(available),
            "premium_tasks": len(premium_tasks),
            "nonpremium_tasks": len(nonpremium_tasks),
            "assigned": sum(1 for x in assigned_sorted if x.get("assignment_status") == "assigned"),
            "unassigned": sum(1 for x in assigned_sorted if x.get("assignment_status","").startswith("unassigned")),
            "one_task_per_cleaner": True,
            "unused_cleaners": unused,
            "notes": [
                "premium tasks assigned first to premium cleaners",
                "each cleaner used at most once",
                "start/end only inside assigned_cleaner after telegram_id",
                "checkout_time default 10:00"
            ]
        }
    }

    save_json(OUTPUT_PATH, output)
    print(f"✅ File salvato: {OUTPUT_PATH}")
    
    # Aggiorna anche manual_assignments.json
    manual_assignments = {"assignments": []}
    try:
        manual_assignments = load_json(MANUAL_ASSIGNMENTS_PATH)
    except:
        pass
    
    # Rimuovi vecchie assegnazioni early-out (mantieni solo quelle manuali)
    assigned_task_ids = set(str(tid(t)) for t in assigned_sorted if t.get("assignment_status") == "assigned")
    manual_assignments["assignments"] = [
        a for a in manual_assignments.get("assignments", [])
        if str(a.get("taskId")) not in assigned_task_ids
    ]
    
    # Aggiungi le nuove assegnazioni early-out
    for task in assigned_sorted:
        if task.get("assignment_status") == "assigned" and task.get("assigned_cleaner"):
            manual_assignments["assignments"].append({
                "taskId": str(tid(task)),
                "cleanerId": task["assigned_cleaner"]["id"],
                "slot": 0  # Default slot per early-out
            })
    
    save_json(MANUAL_ASSIGNMENTS_PATH, manual_assignments)
    print(f"✅ File salvato: {MANUAL_ASSIGNMENTS_PATH}")
    
    if unused:
        print("ℹ️ Cleaners non usati (numero task inferiore al numero di cleaners):", ", ".join(unused))

if __name__ == "__main__":
    main()
