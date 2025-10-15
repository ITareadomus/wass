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
from pathlib import Path

DEFAULT_START_TIME = "10:00"
DEFAULT_EO_TIME = "10:00"

# Path relativi al progetto
TASKS_PATH = Path(__file__).parents[1] / "data" / "output" / "early_out.json"
CLEANERS_PATH = Path(__file__).parents[1] / "data" / "cleaners" / "selected_cleaners.json"
OUTPUT_PATH = Path(__file__).parents[1] / "data" / "output" / "early_out_assignments.json"
TIMELINE_ASSIGNMENTS_PATH = Path(__file__).parents[1] / "data" / "output" / "timeline_assignments.json"
SETTINGS_PATH = Path(__file__).parents[1] / "data" / "input" / "settings.json"

def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)

def save_json(path: Path, data: Any) -> None:
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def normalize_checkout_time(val: Optional[str]) -> str:
    if val is None:
        return DEFAULT_EO_TIME
    if isinstance(val, str) and val.strip().lower() in ("", "null", "none"):
        return DEFAULT_EO_TIME
    return val

def is_premium_cleaner(cleaner: Dict[str, Any]) -> bool:
    return str(cleaner.get("role", "")).strip().lower() == "premium"

def is_formatore(cleaner: Dict[str, Any]) -> bool:
    return str(cleaner.get("role", "")).strip().lower() == "formatore"

def is_premium_task(task: Dict[str, Any]) -> bool:
    if bool(task.get("premium")):
        return True
    return str(task.get("task_type", "")).strip().lower() == "premium"

def is_available(cleaner: Dict[str, Any]) -> bool:
    # I Formatori non possono ricevere task early-out
    if is_formatore(cleaner):
        return False
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

def can_cleaner_handle_apartment(cleaner_role: str, apt_type: str, settings: dict) -> bool:
    """Verifica se un cleaner può gestire un determinato tipo di appartamento."""
    apartment_types = settings.get("apartment_types", {})

    if cleaner_role == "Premium":
        allowed_types = apartment_types.get("premium_apt", [])
    elif cleaner_role == "Formatore":
        allowed_types = apartment_types.get("formatore_apt", [])
    else:  # Standard
        allowed_types = apartment_types.get("standard_apt", [])

    return apt_type in allowed_types

def make_assignment(cleaner: Dict[str, Any], task: Dict[str, Any]) -> Dict[str, Any]:
    """Crea l'assegnazione del task al cleaner con orari."""
    start = task.get("checkout_time") or task.get("start_time") or DEFAULT_START_TIME
    end = end_time_for(start, task.get("cleaning_time"))
    return reorder_cleaner_with_times(cleaner, start, end)

def main() -> None:
    settings = load_json(SETTINGS_PATH)
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

    # Pass 1: Assegna task premium a cleaner premium
    for t in premium_tasks:
        apt_type = t.get("type_apt", "X")
        chosen = None
        for c in premium_cleaners:
            if ident(c) in used_ids:
                continue
            # Verifica se il cleaner può gestire questo tipo di appartamento
            if not can_cleaner_handle_apartment(c.get("role", "Standard"), apt_type, settings):
                continue
            chosen = c
            break

        enriched = dict(t)
        enriched.pop("start_time", None); enriched.pop("end_time", None)
        if chosen:
            enriched["assigned_cleaner"] = make_assignment(chosen, t)
            enriched["assignment_status"] = "assigned"
            used_ids.add(ident(chosen))
        else:
            enriched["assigned_cleaner"] = None
            enriched["assignment_status"] = "unassigned_premium_rule"
        assigned.append(enriched)

    # Pass 2: Assegna task non-premium a cleaner non-premium (o premium se necessario)
    for t in nonpremium_tasks:
        apt_type = t.get("type_apt", "X")
        chosen = None
        # Prima prova con cleaner non-premium
        for c in nonpremium_cleaners:
            if ident(c) in used_ids:
                continue
            # Verifica se il cleaner può gestire questo tipo di appartamento
            if not can_cleaner_handle_apartment(c.get("role", "Standard"), apt_type, settings):
                continue
            chosen = c
            break

        # Se non trovato, prova con cleaner premium
        if not chosen:
            for c in premium_cleaners:
                if ident(c) in used_ids:
                    continue
                # Verifica se il cleaner può gestire questo tipo di appartamento
                if not can_cleaner_handle_apartment(c.get("role", "Standard"), apt_type, settings):
                    continue
                chosen = c
                break

        enriched = dict(t)
        enriched.pop("start_time", None); enriched.pop("end_time", None)
        if chosen:
            enriched["assigned_cleaner"] = make_assignment(chosen, t)
            enriched["assignment_status"] = "assigned"
            used_ids.add(ident(chosen))
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

    # Aggiorna anche timeline_assignments.json
    timeline_assignments = {"assignments": []}
    try:
        timeline_assignments = load_json(TIMELINE_ASSIGNMENTS_PATH)
    except:
        pass

    # Rimuovi vecchie assegnazioni early-out (mantieni solo quelle manuali)
    assigned_logistic_codes = set(str(t.get("logistic_code")) for t in assigned_sorted if t.get("assignment_status") == "assigned")
    timeline_assignments["assignments"] = [
        a for a in timeline_assignments.get("assignments", [])
        if str(a.get("logistic_code")) not in assigned_logistic_codes
    ]

    # Aggiungi le nuove assegnazioni early-out
    for task in assigned_sorted:
        if task.get("assignment_status") == "assigned" and task.get("assigned_cleaner"):
            timeline_assignments["assignments"].append({
                "logistic_code": str(task.get("logistic_code")),
                "cleanerId": task["assigned_cleaner"]["id"],
                "assignment_type": "smista_button"
            })

    save_json(TIMELINE_ASSIGNMENTS_PATH, timeline_assignments)
    print(f"✅ File salvato: {TIMELINE_ASSIGNMENTS_PATH}")

    if unused:
        print("ℹ️ Cleaners non usati (numero task inferiore al numero di cleaners):", ", ".join(unused))

if __name__ == "__main__":
    main()