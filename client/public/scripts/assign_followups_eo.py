# -*- coding: utf-8 -*-
import json
import math
from datetime import datetime
from collections import defaultdict
from typing import List, Dict, Any, Optional, Tuple
from pathlib import Path

# =============================
# Percorsi relativi (compatibili Linux/Replit)
# =============================
BASE = Path(__file__).parent.parent / "data"

INPUT_ASSIGNMENTS = BASE / "output" / "early_out_assignments.json"
INPUT_EARLYOUT    = BASE / "output" / "early_out.json"
INPUT_CLEANERS    = BASE / "cleaners" / "selected_cleaners.json"
OUTPUT_FILE       = BASE / "output" / "followup_assignments.json"

# =============================
# Parametri
# =============================
FIXED_TRAVEL_MINUTES = 15  # Tempo fisso di spostamento tra task
DAY_START_DEFAULT  = "08:00"   # se un cleaner non ha EO pregressa
# nessun DAY_END e nessuna finestra: calcoliamo orari "a seguire" finché ci sono task

# =============================
# Utility
# =============================
def hhmm_to_minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h)*60 + int(m)

def minutes_to_hhmm(m: int) -> str:
    m = int(round(m))
    h = m // 60
    mm = m % 60
    return f"{h:02d}:{mm:02d}"

def parse_date(s: str):
    return datetime.strptime(s, "%Y-%m-%d").date()

def try_hhmm(s: Optional[str], fallback: str) -> str:
    return s if s and ":" in s else fallback

def haversine_km(lat1, lon1, lat2, lon2) -> float:
    R = 6371.0
    phi1, phi2 = math.radians(float(lat1)), math.radians(float(lat2))
    dphi = phi2 - phi1
    dlambda = math.radians(float(lon2) - float(lon1))
    a = math.sin(dphi/2.0)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlambda/2.0)**2
    return 2 * R * math.asin(math.sqrt(a))

def travel_minutes(lat1, lon1, lat2, lon2) -> int:
    """Restituisce sempre il tempo fisso di spostamento, indipendentemente dalla distanza."""
    return FIXED_TRAVEL_MINUTES

# =============================
# Caricamento dati
# =============================
for p in [INPUT_ASSIGNMENTS, INPUT_EARLYOUT, INPUT_CLEANERS]:
    if not p.exists():
        raise FileNotFoundError(f"File non trovato: {p}")

with open(INPUT_ASSIGNMENTS, "r", encoding="utf-8") as f:
    assignments = json.load(f)
with open(INPUT_EARLYOUT, "r", encoding="utf-8") as f:
    earlyout = json.load(f)
with open(INPUT_CLEANERS, "r", encoding="utf-8") as f:
    cleaners_blob = json.load(f)

assigned_items    = assignments.get("early_out_tasks_assigned", [])
earlyout_tasks    = earlyout.get("early_out_tasks", [])
selected_cleaners = cleaners_blob.get("cleaners", [])

# =============================
# Prepara seed (ancora per cleaner) e pool task
# =============================
seed_by_cleaner_and_date: Dict[Tuple[int, object], List[Dict[str, Any]]] = defaultdict(list)
pool_unassigned: List[Dict[str, Any]] = []

# seed: EO già assegnate (posizione + end_time)
for t in assigned_items:
    d = parse_date(t["checkin_date"])
    if t.get("assigned_cleaner"):
        cid = t["assigned_cleaner"]["id"]
        # prendo solo cleaner presenti nel selected_cleaners
        if any(c["id"] == cid for c in selected_cleaners):
            start_hhmm = try_hhmm(t["assigned_cleaner"].get("start_time"), DAY_START_DEFAULT)
            # se end_time mancante, stimalo come start + cleaning_time
            end_hhmm = try_hhmm(
                t["assigned_cleaner"].get("end_time"),
                minutes_to_hhmm(hhmm_to_minutes(start_hhmm) + int(t["cleaning_time"]))
            )
            seed_by_cleaner_and_date[(cid, d)].append({
                "task_id": t["task_id"],
                "lat": float(t["lat"]),
                "lng": float(t["lng"]),
                "end_hhmm": end_hhmm,
                "address": t.get("address",""),
                "cleaning_time": int(t["cleaning_time"]),
            })

    # nel pool vanno solo le unassigned
    if (t.get("assignment_status") or "").startswith("unassigned"):
        pool_unassigned.append({
            "task_id": t["task_id"],
            "date": parse_date(t["checkin_date"]),
            "lat": float(t["lat"]), "lng": float(t["lng"]),
            "cleaning_time": int(t["cleaning_time"]),
            "address": t.get("address",""),
            "alias": t.get("alias"),
            "premium": bool(t.get("premium", False)),
        })

# aggiungi task dal pacchetto early_out.json
for t in earlyout_tasks:
    pool_unassigned.append({
        "task_id": t["task_id"],
        "date": parse_date(t["checkin_date"]),
        "lat": float(t["lat"]), "lng": float(t["lng"]),
        "cleaning_time": int(t["cleaning_time"]),
        "address": t.get("address",""),
        "alias": t.get("alias"),
        "premium": bool(t.get("premium", False)),
    })

# dedup su task_id (caso in cui compaiano in entrambi i file)
seen = set()
dedup_pool = []
for t in pool_unassigned:
    if t["task_id"] not in seen:
        seen.add(t["task_id"])
        dedup_pool.append(t)
pool_unassigned = dedup_pool

# =============================
# Greedy per data
# =============================
tasks_by_date: Dict[object, List[Dict[str, Any]]] = defaultdict(list)
for t in pool_unassigned:
    tasks_by_date[t["date"]].append(t)

def build_initial_state_for_date(the_date, cleaners):
    """Per ogni cleaner crea stato: available_time e current (lat,lng)."""
    state = {}
    for c in cleaners:
        cid = c["id"]
        c_start = try_hhmm(c.get("start_time"), DAY_START_DEFAULT)
        seeds = seed_by_cleaner_and_date.get((cid, the_date), [])
        if seeds:
            seeds_sorted = sorted(seeds, key=lambda s: hhmm_to_minutes(s["end_hhmm"]))
            last = seeds_sorted[-1]
            state[cid] = {
                "available_min": hhmm_to_minutes(last["end_hhmm"]),
                "lat": float(last["lat"]),
                "lng": float(last["lng"]),
                "role": c.get("role"),
                "name": f"{c.get('name','')} {c.get('lastname','')}".strip(),
                "route": []
            }
        else:
            state[cid] = {
                "available_min": hhmm_to_minutes(c_start),
                "lat": None, "lng": None,          # prima task: viaggio=0 da "nulla"
                "role": c.get("role"),
                "name": f"{c.get('name','')} {c.get('lastname','')}".strip(),
                "route": []
            }
    return state

def assign_greedy_for_date(the_date, tasks, cleaners):
    """Assegna greedy in round-robin: per ogni cleaner prende la task più vicina alla sua posizione attuale.
       Ignora ogni checkin/checkout_time. Calcola start = available + travel, end = start + cleaning_time."""
    if not tasks:
        return [], []

    # stati cleaner
    state = build_initial_state_for_date(the_date, cleaners)
    # premium availability
    premium_vehicle_ids = {c["id"] for c in cleaners if str(c.get("role","")).lower() == "premium"}
    has_premium = len(premium_vehicle_ids) > 0

    # lavoriamo su una copia della lista task
    remaining = tasks[:]
    assigned_any = True
    premium_fallback_today = []

    # round-robin finché qualcosa si muove
    while remaining and assigned_any:
        assigned_any = False
        for c in cleaners:
            if not remaining:
                break
            cid = c["id"]
            cstate = state[cid]

            # filtro premium
            def allowed(task):
                if task.get("premium", False):
                    if has_premium:
                        return cid in premium_vehicle_ids
                    else:
                        return True  # fallback permesso
                return True

            candidates = [t for t in remaining if allowed(t)]
            if not candidates:
                continue

            # scegli la più vicina (in minuti viaggio); se nessuna posizione, costo viaggio=0
            best = None
            best_travel = None
            for t in candidates:
                if cstate["lat"] is None or cstate["lng"] is None:
                    trav = 0
                else:
                    trav = travel_minutes(cstate["lat"], cstate["lng"], t["lat"], t["lng"])
                if best is None or trav < best_travel:
                    best = t
                    best_travel = trav

            # Se non è stata trovata nessuna task, salta questo cleaner
            if best is None:
                continue

            # calcola orari
            start_min = cstate["available_min"] + (best_travel or 0)
            end_min   = start_min + int(best["cleaning_time"])

            premium_fallback = False
            if best.get("premium", False) and cid not in premium_vehicle_ids and not has_premium:
                premium_fallback = True
                premium_fallback_today.append(best["task_id"])

            # registra sul cleaner
            cstate["route"].append({
                "task_id": best["task_id"],
                "address": best.get("address",""),
                "alias": best.get("alias"),
                "start_time": minutes_to_hhmm(start_min),
                "end_time": minutes_to_hhmm(end_min),
                "service_min": int(best["cleaning_time"]),
                "premium": bool(best.get("premium", False)),
                "premium_fallback": premium_fallback,
                "followup": True
            })
            # aggiorna stato cleaner
            cstate["available_min"] = end_min
            cstate["lat"], cstate["lng"] = best["lat"], best["lng"]

            # togli la task dalla lista
            remaining.remove(best)
            assigned_any = True

    # format results
    results = []
    for c in cleaners:
        cid = c["id"]
        if state[cid]["route"]:
            results.append({
                "date": the_date.isoformat(),
                "cleaner_id": cid,
                "cleaner_name": state[cid]["name"],
                "cleaner_role": state[cid]["role"],
                "assigned_tasks": state[cid]["route"]
            })

    return results, list(set(premium_fallback_today))

# =============================
# Esecuzione per data + salvataggio
# =============================
all_results = []
premium_fallback_dates = defaultdict(list)

for the_date in sorted(tasks_by_date.keys()):
    day_tasks = tasks_by_date[the_date]
    day_cleaners = selected_cleaners  # usa tutti i cleaner forniti
    print(f"--- Greedy {the_date} | tasks={len(day_tasks)} | cleaners={len(day_cleaners)} ---")
    day_results, day_fallback = assign_greedy_for_date(the_date, day_tasks, day_cleaners)
    all_results.extend(day_results)
    if day_fallback:
        premium_fallback_dates[the_date.isoformat()] = day_fallback

OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
meta = {
    "method": "greedy_round_robin_nearest",
    "fixed_travel_minutes": FIXED_TRAVEL_MINUTES,
    "premium_rule": "premium tasks require premium cleaners; if none exist, allow standard and mark premium_fallback=true",
    "premium_fallback_dates": list(premium_fallback_dates.keys()),
    "premium_fallback_task_ids": dict(premium_fallback_dates)
}
with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
    json.dump({"meta": meta, "assignments": all_results}, f, ensure_ascii=False, indent=2)

total_assigned = sum(len(r["assigned_tasks"]) for r in all_results)
print(f"✅ OK. Scritto {OUTPUT_FILE} con {total_assigned} task assegnate (greedy, tempo fisso {FIXED_TRAVEL_MINUTES} min tra task).")