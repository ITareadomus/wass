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

INPUT_ASSIGNMENTS = BASE / "output" / "early_out_assignments.json"  # Per il seed (task già assegnate)
INPUT_EARLYOUT    = BASE / "output" / "early_out.json"  # Per task da assegnare come followup
INPUT_CLEANERS    = BASE / "cleaners" / "selected_cleaners.json"
OUTPUT_FILE       = BASE / "output" / "followup_assignments.json"
OUTPUT_EARLY_OUT  = BASE / "output" / "early_out_assignments.json"
SETTINGS_FILE = BASE / "input" / "settings.json"

# =============================
# Parametri
# =============================
FIXED_TRAVEL_MINUTES = 15  # Tempo fisso di spostamento tra task

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

def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def can_cleaner_handle_apartment(cleaner_role, apt_type, settings):
    """Verifica se un cleaner può gestire un determinato tipo di appartamento."""
    apartment_types = settings.get("apartment_types", {})

    if cleaner_role == "Premium":
        allowed_types = apartment_types.get("premium_apt", [])
    elif cleaner_role == "Formatore":
        allowed_types = apartment_types.get("formatore_apt", [])
    else:  # Standard
        allowed_types = apartment_types.get("standard_apt", [])

    return apt_type in allowed_types

# =============================
# Funzione per verificare se un cleaner è formatore
# =============================
def is_formatore(cleaner: Dict[str, Any]) -> bool:
    """I Formatori non possono ricevere task followup"""
    return str(cleaner.get("role", "")).strip().lower() == "formatore"

# =============================
# Caricamento dati
# =============================
for p in [INPUT_ASSIGNMENTS, INPUT_EARLYOUT, INPUT_CLEANERS, SETTINGS_FILE]:
    if not p.exists():
        raise FileNotFoundError(f"File non trovato: {p}")

with open(INPUT_ASSIGNMENTS, "r", encoding="utf-8") as f:
    assignments = json.load(f)
with open(INPUT_EARLYOUT, "r", encoding="utf-8") as f:
    earlyout = json.load(f)
with open(INPUT_CLEANERS, "r", encoding="utf-8") as f:
    cleaners_blob = json.load(f)
settings = load_json(SETTINGS_FILE)

assigned_items    = assignments.get("early_out_tasks_assigned", [])
earlyout_tasks    = earlyout.get("early_out_tasks", [])
# Filtra i formatori dai cleaners selezionati
selected_cleaners = [c for c in cleaners_blob.get("cleaners", []) if not is_formatore(c)]

# =============================
# Prepara seed (ancora per cleaner) e pool task
# =============================
seed_by_cleaner_and_date: Dict[Tuple[int, object], List[Dict[str, Any]]] = defaultdict(list)
pool_unassigned: List[Dict[str, Any]] = []

# Traccia le task già assegnate (solo per il seed)
already_assigned_task_ids = set()

# seed: EO già assegnate (posizione + end_time) - INCLUDE anche followup per posizione finale
for t in assigned_items:
    d = parse_date(t["checkin_date"])
    if t.get("assigned_cleaner"):
        cid = t["assigned_cleaner"]["id"]
        already_assigned_task_ids.add(t["task_id"])  # Traccia task già assegnata

        # prendo solo cleaner presenti nel selected_cleaners
        if any(c["id"] == cid for c in selected_cleaners):
            # Usa fw_end_time se disponibile (per followup), altrimenti end_time
            if t.get("assigned_cleaner").get("fw_end_time"):
                end_hhmm = t["assigned_cleaner"]["fw_end_time"]
            elif t.get("assigned_cleaner").get("end_time"):
                end_hhmm = t["assigned_cleaner"]["end_time"]
            else:
                start_hhmm = try_hhmm(t["assigned_cleaner"].get("start_time"), DAY_START_DEFAULT)
                end_hhmm = minutes_to_hhmm(hhmm_to_minutes(start_hhmm) + int(t["cleaning_time"]))
            
            seed_by_cleaner_and_date[(cid, d)].append({
                "task_id": t["task_id"],
                "lat": float(t["lat"]),
                "lng": float(t["lng"]),
                "end_hhmm": end_hhmm,
                "address": t.get("address",""),
                "cleaning_time": int(t["cleaning_time"]),
            })

# Pool task: SOLO da early_out.json (escludi task già nel seed)
for t in earlyout_tasks:
    if t["task_id"] not in already_assigned_task_ids:
        pool_unassigned.append({
            "task_id": t["task_id"],
            "logistic_code": t.get("logistic_code", t["task_id"]),
            "date": parse_date(t["checkin_date"]),
            "lat": float(t["lat"]), "lng": float(t["lng"]),
            "cleaning_time": int(t["cleaning_time"]),
            "address": t.get("address",""),
            "alias": t.get("alias"),
            "premium": bool(t.get("premium", False)),
            "type_apt": t.get("type_apt", "X")
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
        c_start = c.get("start_time")  # start_time è obbligatorio
        if not c_start:
            raise ValueError(f"Cleaner {cid} non ha start_time definito")
        
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

    # assegna sempre al cleaner globalmente più vicino, con priorità per task nello stesso indirizzo
    while remaining and assigned_any:
        assigned_any = False

        # Trova la migliore combinazione (cleaner, task) globalmente
        best_cleaner_id = None
        best_task = None
        best_travel = None

        for c in cleaners:
            cid = c["id"]
            cstate = state[cid]

            # filtro premium per questo cleaner
            def allowed(task):
                if task.get("premium", False):
                    if has_premium:
                        return cid in premium_vehicle_ids
                    else:
                        return True  # fallback permesso
                return True

            candidates = [t for t in remaining if allowed(t)]

            # PRIORITÀ 1: task nello stesso posto del cleaner (distanza = 0)
            same_location_tasks = []
            if cstate["lat"] is not None and cstate["lng"] is not None:
                same_location_tasks = [
                    t for t in candidates 
                    if abs(float(t["lat"]) - cstate["lat"]) < 0.0001 
                    and abs(float(t["lng"]) - cstate["lng"]) < 0.0001
                ]

            # Se ci sono task nello stesso posto, prendiamo la prima
            if same_location_tasks:
                if best_travel is None or best_travel > 0:
                    best_cleaner_id = cid
                    best_task = same_location_tasks[0]
                    best_travel = 0
            else:
                # PRIORITÀ 2: task più vicina
                for t in candidates:
                    if cstate["lat"] is None or cstate["lng"] is None:
                        trav = 0
                    else:
                        trav = travel_minutes(cstate["lat"], cstate["lng"], t["lat"], t["lng"])

                    # aggiorna il miglior match globale
                    if best_travel is None or trav < best_travel:
                        best_cleaner_id = cid
                        best_task = t
                        best_travel = trav

        # Se non abbiamo trovato nessuna combinazione valida, esci
        if best_cleaner_id is None or best_task is None:
            break

        # Assegna la task al cleaner migliore
        cstate = state[best_cleaner_id]
        
        # calcola orari
        start_min = cstate["available_min"] + (best_travel or 0)
        end_min   = start_min + int(best_task["cleaning_time"])

        premium_fallback = False
        if best_task.get("premium", False) and best_cleaner_id not in premium_vehicle_ids and not has_premium:
            premium_fallback = True
            premium_fallback_today.append(best_task["task_id"])

        # registra sul cleaner (usa fw_start_time e fw_end_time per followup)
        cstate["route"].append({
            "task_id": best_task["task_id"],
            "logistic_code": best_task.get("logistic_code", best_task["task_id"]),
            "address": best_task.get("address",""),
            "alias": best_task.get("alias"),
            "fw_start_time": minutes_to_hhmm(start_min),
            "fw_end_time": minutes_to_hhmm(end_min),
            "service_min": int(best_task["cleaning_time"]),
            "premium": bool(best_task.get("premium", False)),
            "premium_fallback": premium_fallback,
            "followup": True
        })
        # aggiorna stato cleaner
        cstate["available_min"] = end_min
        cstate["lat"], cstate["lng"] = best_task["lat"], best_task["lng"]

        # togli la task dalla lista
        remaining.remove(best_task)
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

# 1. Salva followup_assignments.json (formato originale)
OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
meta = {
    "method": "greedy_round_robin_nearest",
    "fixed_travel_minutes": FIXED_TRAVEL_MINUTES,
    "premium_rule": "premium tasks require premium cleaners; if none exist, allow standard and mark premium_fallback=true",
    "apartment_type_rule": "cleaners can only be assigned tasks for apartment types they are configured to handle in settings.json",
    "premium_fallback_dates": list(premium_fallback_dates.keys()),
    "premium_fallback_task_ids": dict(premium_fallback_dates)
}
with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
    json.dump({"meta": meta, "assignments": all_results}, f, ensure_ascii=False, indent=2)

total_assigned = sum(len(r["assigned_tasks"]) for r in all_results)
print(f"✅ OK. Scritto {OUTPUT_FILE} con {total_assigned} task assegnate (greedy, tempo fisso {FIXED_TRAVEL_MINUTES} min tra task).")

# 2. Aggiungi task followup anche in early_out_assignments.json
existing_data = {"early_out_tasks_assigned": [], "meta": {}}
if OUTPUT_EARLY_OUT.exists():
    with open(OUTPUT_EARLY_OUT, "r", encoding="utf-8") as f:
        existing_data = json.load(f)

existing_tasks = existing_data.get("early_out_tasks_assigned", [])

# Per ogni assegnazione followup, aggiorna la task esistente
for assignment in all_results:
    for task in assignment["assigned_tasks"]:
        # Trova la task originale per recuperare tutti i dettagli
        original_task = None
        for t in pool_unassigned:
            if t["task_id"] == task["task_id"]:
                original_task = t
                break

        if original_task:
            # Cerca la task esistente nell'array
            task_found = False
            for i, existing_task in enumerate(existing_tasks):
                if existing_task["task_id"] == task["task_id"]:
                    # Aggiorna la task esistente (usa fw_start_time e fw_end_time per followup)
                    existing_tasks[i]["assigned_cleaner"] = {
                        "id": assignment["cleaner_id"],
                        "name": assignment["cleaner_name"].split()[0] if assignment["cleaner_name"] else "",
                        "lastname": " ".join(assignment["cleaner_name"].split()[1:]) if len(assignment["cleaner_name"].split()) > 1 else "",
                        "role": assignment["cleaner_role"],
                        "fw_start_time": task["fw_start_time"],
                        "fw_end_time": task["fw_end_time"]
                    }
                    existing_tasks[i]["assignment_status"] = "assigned"
                    existing_tasks[i]["followup"] = True
                    existing_tasks[i]["logistic_code"] = task["logistic_code"]
                    task_found = True
                    break

            # Se la task non esiste, aggiungila (questo non dovrebbe mai accadere)
            if not task_found:
                existing_tasks.append({
                    "task_id": task["task_id"],
                    "logistic_code": task["logistic_code"],
                    "address": task.get("address", ""),
                    "alias": task.get("alias", ""),
                    "lat": str(original_task.get("lat", "")),
                    "lng": str(original_task.get("lng", "")),
                    "cleaning_time": task["service_min"],
                    "checkin_date": assignment["date"],
                    "premium": task.get("premium", False),
                    "type_apt": original_task.get("type_apt", "X"), # Aggiunto per compatibilità appartamento
                    "assigned_cleaner": {
                        "id": assignment["cleaner_id"],
                        "name": assignment["cleaner_name"].split()[0] if assignment["cleaner_name"] else "",
                        "lastname": " ".join(assignment["cleaner_name"].split()[1:]) if len(assignment["cleaner_name"].split()) > 1 else "",
                        "role": assignment["cleaner_role"],
                        "fw_start_time": task["fw_start_time"],
                        "fw_end_time": task["fw_end_time"]
                    },
                    "assignment_status": "assigned",
                    "followup": True
                })

# Aggiorna i metadati
existing_meta = existing_data.get("meta", {})
existing_meta["followup_added"] = {
    "method": "greedy_round_robin_nearest",
    "fixed_travel_minutes": FIXED_TRAVEL_MINUTES,
    "premium_rule": "premium tasks require premium cleaners; if none exist, allow standard and mark premium_fallback=true",
    "apartment_type_rule": "cleaners can only be assigned tasks for apartment types they are configured to handle in settings.json",
    "total_followup_tasks": total_assigned,
    "premium_fallback_dates": list(premium_fallback_dates.keys()),
    "premium_fallback_task_ids": dict(premium_fallback_dates)
}

# Salva il file aggiornato
output_data = {
    "early_out_tasks_assigned": existing_tasks,
    "meta": existing_meta
}

with open(OUTPUT_EARLY_OUT, "w", encoding="utf-8") as f:
    json.dump(output_data, f, ensure_ascii=False, indent=2)

print(f"✅ OK. Aggiunte {total_assigned} task followup anche in {OUTPUT_EARLY_OUT}.")

# 3. Aggiorna timeline_assignments.json con le task followup
TIMELINE_ASSIGNMENTS = BASE / "output" / "timeline_assignments.json"

# Carica o crea timeline_assignments.json
timeline_data = {"assignments": []}
if TIMELINE_ASSIGNMENTS.exists():
    with open(TIMELINE_ASSIGNMENTS, "r", encoding="utf-8") as f:
        timeline_data = json.load(f)

# Aggiungi le assegnazioni followup alla timeline
for assignment in all_results:
    for task in assignment["assigned_tasks"]:
        # Rimuovi eventuali assegnazioni precedenti per questo logistic_code
        timeline_data["assignments"] = [
            a for a in timeline_data["assignments"] 
            if a.get("logistic_code") != str(task.get("logistic_code"))
        ]

        # Aggiungi la nuova assegnazione followup
        timeline_data["assignments"].append({
            "logistic_code": str(task.get("logistic_code")),
            "cleanerId": assignment["cleaner_id"],
            "assignment_type": "followup_auto"
        })

# Salva timeline_assignments.json aggiornato
with open(TIMELINE_ASSIGNMENTS, "w", encoding="utf-8") as f:
    json.dump(timeline_data, f, ensure_ascii=False, indent=2)

print(f"✅ OK. Aggiunte {total_assigned} task followup anche in {TIMELINE_ASSIGNMENTS}.")