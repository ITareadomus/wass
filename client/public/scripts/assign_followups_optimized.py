# -*- coding: utf-8 -*-
import json
import math
from datetime import datetime
from collections import defaultdict
from typing import List, Dict, Any, Optional, Tuple
from pathlib import Path
import random

# =============================
# Percorsi relativi (compatibile Linux/Replit)
# =============================
BASE = Path(__file__).parents[1] / "data"

INPUT_ASSIGNMENTS = BASE / "output" / "early_out_assignments.json"
INPUT_EARLYOUT    = BASE / "output" / "early_out.json"
INPUT_CLEANERS    = BASE / "cleaners" / "selected_cleaners.json"
OUTPUT_FILE       = BASE / "output" / "followup_assignments.json"
OUTPUT_EARLY_OUT  = BASE / "output" / "early_out_assignments.json"

# =============================
# Parametri
# =============================
URBAN_SPEED_KMPH   = 25.0             # km/h -> viaggi in minuti
FIXED_TRAVEL_MINUTES = 15.0             # Minuti fissi per ogni viaggio tra task
DAY_START_DEFAULT  = "08:00"          # anchor quando non esiste EO per il cleaner
USE_CLUSTERING     = True             # clustering k-means (senza sklearn)
MAX_KMEANS_ITERS   = 20
RANDOM_SEED        = 13               # determinismo
# Nessuna finestra oraria: costruiamo gli orari in catena (anchor end_time -> travel -> cleaning)

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

def travel_minutes(lat1, lon1, lat2, lon2, speed_kmph=URBAN_SPEED_KMPH) -> int:
    # Se è stato impostato un tempo di viaggio fisso, usalo
    if FIXED_TRAVEL_MINUTES > 0:
        return int(FIXED_TRAVEL_MINUTES)
    # Altrimenti, calcola come prima
    km = haversine_km(lat1, lon1, lat2, lon2)
    hours = km / max(1e-6, speed_kmph)
    return int(round(hours * 60))

def centroid(points: List[Tuple[float,float]]) -> Tuple[float,float]:
    if not points:
        return (0.0, 0.0)
    sx = sum(p[0] for p in points); sy = sum(p[1] for p in points)
    return (sx/len(points), sy/len(points))

# =============================
# K-means minimale (senza sklearn)
# =============================
def kmeans(points: List[Tuple[float,float]], k: int, max_iters: int = MAX_KMEANS_ITERS, seed: int = RANDOM_SEED):
    random.seed(seed)
    if k <= 0 or not points:
        return [0]*len(points), [(0.0,0.0)]
    k = min(k, len(points))
    # init: campiona k punti distinti
    centroids = random.sample(points, k)
    labels = [0]*len(points)
    for _ in range(max_iters):
        # assign
        changed = False
        for i, p in enumerate(points):
            best = None; bestd = None
            for ci, c in enumerate(centroids):
                d = (p[0]-c[0])**2 + (p[1]-c[1])**2
                if best is None or d < bestd:
                    best, bestd = ci, d
            if labels[i] != best:
                labels[i] = best; changed = True
        # update
        groups = [[] for _ in range(k)]
        for lbl, p in zip(labels, points):
            groups[lbl].append(p)
        new_centroids = []
        for g in groups:
            if g:
                new_centroids.append(centroid(g))
            else:
                # cluster vuoto: riassegna random
                new_centroids.append(random.choice(points))
        if new_centroids == centroids:
            break
        centroids = new_centroids
        if not changed:
            break
    return labels, centroids

# =============================
# 2-opt semplice per route
# =============================
def route_distance(lat0, lon0, tasks_seq: List[Dict[str,Any]]) -> float:
    """Distanza percorso (km) partendo da (lat0,lon0) visitando le task in ordine."""
    if not tasks_seq:
        return 0.0
    dist = 0.0
    cur_lat, cur_lon = lat0, lon0
    for t in tasks_seq:
        dist += haversine_km(cur_lat, cur_lon, t["lat"], t["lng"])
        cur_lat, cur_lon = t["lat"], t["lng"]
    return dist

def two_opt(lat0, lon0, tasks_seq: List[Dict[str,Any]]) -> List[Dict[str,Any]]:
    """Semplice 2-opt sul percorso. Non cambia gli orari: dopo il riordino, verranno ricalcolati."""
    improved = True
    seq = tasks_seq[:]
    while improved:
        improved = False
        for i in range(len(seq)-2):
            for j in range(i+2, len(seq)):
                # salto se lo swap non ha senso
                before = route_distance(lat0, lon0, seq)
                # swap segment i+1..j
                new_seq = seq[:i+1] + list(reversed(seq[i+1:j+1])) + seq[j+1:]
                after = route_distance(lat0, lon0, new_seq)
                if after + 1e-9 < before:
                    seq = new_seq
                    improved = True
        # loop finché non migliora più
    return seq

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
# Seed (ancore) e pool task
# =============================
seed_by_cleaner_and_date: Dict[Tuple[int, object], List[Dict[str, Any]]] = defaultdict(list)
pool_unassigned: List[Dict[str, Any]] = []

# seed: EO già assegnate (posizione + end_time)
for t in assigned_items:
    d = parse_date(t["checkin_date"])
    if t.get("assigned_cleaner"):
        cid = t["assigned_cleaner"]["id"]
        if any(c["id"] == cid for c in selected_cleaners):
            start_hhmm = try_hhmm(t["assigned_cleaner"].get("start_time"), DAY_START_DEFAULT)
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

# aggiungi early_out.json
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

# de-dup task_id
seen = set(); dedup_pool = []
for t in pool_unassigned:
    if t["task_id"] not in seen:
        seen.add(t["task_id"]); dedup_pool.append(t)
pool_unassigned = dedup_pool

# =============================
# Stato cleaner per data
# =============================
def build_initial_state_for_date(the_date, cleaners):
    """Per ogni cleaner crea stato: available_time e current (lat,lng), nome/ruolo."""
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
                "lat": float(last["lat"]), "lng": float(last["lng"]),
                "role": c.get("role"),
                "name": f"{c.get('name','')} {c.get('lastname','')}".strip(),
                "seq": []  # conterrà dict task (lat,lng,cleaning_time, premium, id, alias, address)
            }
        else:
            # nessuna EO: parte dalla sua start_time e senza posizione iniziale
            state[cid] = {
                "available_min": hhmm_to_minutes(c_start),
                "lat": None, "lng": None,
                "role": c.get("role"),
                "name": f"{c.get('name','')} {c.get('lastname','')}".strip(),
                "seq": []
            }
    return state

# =============================
# Clustering opzionale
# =============================
def prepare_clusters(tasks: List[Dict[str,Any]], cleaners: List[Dict[str,Any]], the_date):
    """Ritorna: cluster_id per ogni task, centroidi cluster, mapping cleaner->cluster_id vicino."""
    if not USE_CLUSTERING or len(tasks) == 0:
        return [0]*len(tasks), [(0.0,0.0)], {c["id"]: 0 for c in cleaners}
    k = min(len(cleaners), len(tasks))
    pts = [(t["lat"], t["lng"]) for t in tasks]
    labels, cents = kmeans(pts, k)
    # cluster più vicino per ogni cleaner (ancora = EO end position se esiste, altrimenti centroid di tutte le task)
    all_centroid = centroid(pts)
    cleaner_to_cluster = {}
    for c in cleaners:
        cid = c["id"]
        seeds = seed_by_cleaner_and_date.get((cid, the_date), [])
        if seeds:
            seeds_sorted = sorted(seeds, key=lambda s: hhmm_to_minutes(s["end_hhmm"]))
            last = seeds_sorted[-1]
            base_lat, base_lng = last["lat"], last["lng"]
        else:
            base_lat, base_lng = all_centroid
        # nearest centroid
        best = 0; bestd = None
        for i, cent in enumerate(cents):
            d = (base_lat-cent[0])**2 + (base_lng-cent[1])**2
            if bestd is None or d < bestd:
                best, bestd = i, d
        cleaner_to_cluster[cid] = best
    return labels, cents, cleaner_to_cluster

# =============================
# Assegnazione globale "regret-2"
# =============================
def assign_regret2_for_date(the_date, tasks: List[Dict[str,Any]], cleaners: List[Dict[str,Any]]):
    """Strategy:
    - Calcola per ogni task i 2 migliori cleaner (tempo viaggio dal loro stato attuale) tra quelli ammessi (premium+cluster).
    - Scegli la task con regret = (secondo_migliore - migliore) massimo → assegnala al suo migliore cleaner.
    - Aggiorna lo stato del cleaner (available_time, posizione) e ripeti finché non restano task possibili.
    """
    if not tasks:
        return [], []

    state = build_initial_state_for_date(the_date, cleaners)
    premium_cleaners = {c["id"] for c in cleaners if str(c.get("role","")).lower() == "premium"}
    has_premium = len(premium_cleaners) > 0

    labels, cents, cleaner_to_cluster = prepare_clusters(tasks, cleaners, the_date)

    # Copia tasks arricchite con cluster id
    remaining = []
    for i, t in enumerate(tasks):
        tt = dict(t)  # copy
        tt["_cluster"] = labels[i] if labels else 0
        remaining.append(tt)

    premium_fallback_today = []
    random.seed(RANDOM_SEED)

    def eligible_cleaners_for_task(task):
        # premium rule
        if task.get("premium", False) and has_premium:
            allowed = [cid for cid in state.keys() if cid in premium_cleaners]
        else:
            allowed = list(state.keys())
        # cluster gating: preferisci cleaner il cui cluster coincide con quello della task
        cluster_allowed = [cid for cid in allowed if cleaner_to_cluster.get(cid, 0) == task.get("_cluster", 0)]
        if cluster_allowed:
            return cluster_allowed
        # se nessuno coincide, sblocca a tutti gli allowed
        return allowed

    def travel_from_state(cid, t):
        cs = state[cid]
        if cs["lat"] is None or cs["lng"] is None:
            return 0
        return travel_minutes(cs["lat"], cs["lng"], t["lat"], t["lng"])

    # loop finché riusciamo ad assegnare qualcosa
    assigned_any = True
    while remaining and assigned_any:
        assigned_any = False

        # Calcola per ogni task i due migliori cleaner e il regret
        candidates = []
        for t in remaining:
            elig = eligible_cleaners_for_task(t)
            if not elig:
                continue
            best = None; best2 = None
            best_c = None; best2_c = None
            for cid in elig:
                trav = travel_from_state(cid, t)
                if best is None or trav < best:
                    best2, best2_c = best, best_c
                    best, best_c = trav, cid
                elif best2 is None or trav < best2:
                    best2, best2_c = trav, cid
            # se un solo cleaner possibile → regret alto (priorità)
            if best2 is None:
                regret = float('inf')
            else:
                regret = best2 - best
            candidates.append((regret, best, best_c, t))

        if not candidates:
            break

        # Scegli la task con regret massimo (tie-break: best più piccolo)
        candidates.sort(key=lambda x: (-float('inf') if x[0]==float('inf') else -x[0], x[1]))
        regret, best_travel, best_cid, chosen = candidates[0]

        # Assegna
        cs = state[best_cid]
        start_min = cs["available_min"] + (best_travel or 0)
        end_min   = start_min + int(chosen["cleaning_time"])

        premium_fallback = False
        if chosen.get("premium", False) and best_cid not in premium_cleaners and not has_premium:
            premium_fallback = True
            premium_fallback_today.append(chosen["task_id"])

        cs["seq"].append({
            "task_id": chosen["task_id"],
            "address": chosen.get("address",""),
            "alias": chosen.get("alias"),
            "lat": chosen["lat"],
            "lng": chosen["lng"],
            "start_time": minutes_to_hhmm(start_min),
            "end_time": minutes_to_hhmm(end_min),
            "service_min": int(chosen["cleaning_time"]),
            "premium": bool(chosen.get("premium", False)),
            "premium_fallback": premium_fallback
        })
        # update stato cleaner
        cs["available_min"] = end_min
        cs["lat"], cs["lng"] = chosen["lat"], chosen["lng"]

        # rimuovi task
        remaining.remove(chosen)
        assigned_any = True

    # 2-opt locale per ogni cleaner, poi ricalcola orari in catena
    results = []
    for c in cleaners:
        cid = c["id"]
        cs = state[cid]
        if not cs["seq"]:
            continue

        # anchor position/time
        seeds = seed_by_cleaner_and_date.get((cid, the_date), [])
        if seeds:
            seeds_sorted = sorted(seeds, key=lambda s: hhmm_to_minutes(s["end_hhmm"]))
            last = seeds_sorted[-1]
            base_lat, base_lng = last["lat"], last["lng"]
            base_time = hhmm_to_minutes(last["end_hhmm"])
        else:
            # nessuna EO: anchor senza posizione; usa centroide delle task assegnate
            base_lat, base_lng = centroid([(it["lat"], it["lng"]) for it in cs["seq"]])
            base_time = cs["available_min"] - sum(it["service_min"] for it in cs["seq"])  # approx invert

        # prepara lista “solo coord & task”
        seq_simple = [{"lat": it["lat"], "lng": it["lng"], **it} for it in cs["seq"]]
        seq_opt = two_opt(base_lat, base_lng, seq_simple)

        # ricalcola orari in catena
        cur_lat, cur_lng = base_lat, base_lng
        cur_time = base_time
        route_out = []
        for it in seq_opt:
            trav = 0 if (cur_lat is None or cur_lng is None) else travel_minutes(cur_lat, cur_lng, it["lat"], it["lng"])
            start_min = cur_time + trav
            end_min   = start_min + int(it["service_min"])
            route_out.append({
                "task_id": it["task_id"],
                "address": it.get("address",""),
                "alias": it.get("alias"),
                "start_time": minutes_to_hhmm(start_min),
                "end_time": minutes_to_hhmm(end_min),
                "service_min": int(it["service_min"]),
                "premium": bool(it.get("premium", False)),
                "premium_fallback": bool(it.get("premium_fallback", False))
            })
            cur_time = end_min
            cur_lat, cur_lng = it["lat"], it["lng"]

        results.append({
            "date": the_date.isoformat(),
            "cleaner_id": cid,
            "cleaner_name": cs["name"],
            "cleaner_role": cs["role"],
            "assigned_tasks": route_out
        })

    return results, list(set(premium_fallback_today))

# =============================
# Esecuzione per data + salvataggio
# =============================
tasks_by_date: Dict[object, List[Dict[str, Any]]] = defaultdict(list)
for t in pool_unassigned:
    tasks_by_date[t["date"]].append(t)

all_results = []
premium_fallback_dates = defaultdict(list)

for the_date in sorted(tasks_by_date.keys()):
    day_tasks = tasks_by_date[the_date]
    day_cleaners = selected_cleaners
    print(f"--- Regret-2 + 2-opt {the_date} | tasks={len(day_tasks)} | cleaners={len(day_cleaners)} ---")
    day_results, day_fallback = assign_regret2_for_date(the_date, day_tasks, day_cleaners)
    all_results.extend(day_results)
    if day_fallback:
        premium_fallback_dates[the_date.isoformat()] = day_fallback

OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
meta = {
    "method": "clustering(k-means)+global_regret2+2opt",
    "fixed_travel_minutes": FIXED_TRAVEL_MINUTES,
    "use_clustering": USE_CLUSTERING,
    "premium_rule": "premium tasks require premium cleaners; if none exist, allow standard and mark premium_fallback=true",
    "premium_fallback_dates": list(premium_fallback_dates.keys()),
    "premium_fallback_task_ids": dict(premium_fallback_dates),
    "notes": [
        "Tempo di viaggio fisso: 15 minuti tra ogni task",
        "Ignoriamo completamente checkin/checkout: gli orari sono calcolati in catena.",
        "Anchor su end_time dell'ultima EO del cleaner (se manca: start_time).",
        "Se vuoi disattivare il clustering, metti USE_CLUSTERING=False."
    ]
}
with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
    json.dump({"meta": meta, "assignments": all_results}, f, ensure_ascii=False, indent=2)

total_assigned = sum(len(r["assigned_tasks"]) for r in all_results)
print(f"✅ OK. Scritto {OUTPUT_FILE} con {total_assigned} task assegnate (regret-2 + 2-opt).")

# =============================
# Aggiorna early_out_assignments.json con le task followup
# =============================
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
                    # Aggiorna la task esistente (usa start_time e end_time per followup)
                    existing_tasks[i]["assigned_cleaner"] = {
                        "id": assignment["cleaner_id"],
                        "name": assignment["cleaner_name"].split()[0] if assignment["cleaner_name"] else "",
                        "lastname": " ".join(assignment["cleaner_name"].split()[1:]) if len(assignment["cleaner_name"].split()) > 1 else "",
                        "role": assignment["cleaner_role"],
                        "start_time": task["start_time"],
                        "end_time": task["end_time"]
                    }
                    existing_tasks[i]["assignment_status"] = "assigned"
                    existing_tasks[i]["followup"] = True
                    task_found = True
                    break

            # Se la task non esiste, aggiungila
            if not task_found:
                existing_tasks.append({
                    "task_id": task["task_id"],
                    "logistic_code": original_task.get("logistic_code", task["task_id"]),
                    "address": task.get("address", ""),
                    "alias": original_task.get("alias", ""),
                    "lat": str(original_task.get("lat", "")),
                    "lng": str(original_task.get("lng", "")),
                    "cleaning_time": task["service_min"],
                    "checkin_date": assignment["date"],
                    "premium": task.get("premium", False),
                    "type_apt": original_task.get("type_apt", "X"),
                    "assigned_cleaner": {
                        "id": assignment["cleaner_id"],
                        "name": assignment["cleaner_name"].split()[0] if assignment["cleaner_name"] else "",
                        "lastname": " ".join(assignment["cleaner_name"].split()[1:]) if len(assignment["cleaner_name"].split()) > 1 else "",
                        "role": assignment["cleaner_role"],
                        "start_time": task["start_time"],
                        "end_time": task["end_time"]
                    },
                    "assignment_status": "assigned",
                    "followup": True
                })

# Aggiorna i metadati
existing_meta = existing_data.get("meta", {})
existing_meta["followup_added"] = {
    "method": "clustering(k-means)+global_regret2+2opt",
    "fixed_travel_minutes": FIXED_TRAVEL_MINUTES,
    "use_clustering": USE_CLUSTERING,
    "total_followup_tasks": total_assigned
}

# Salva il file aggiornato
output_data = {
    "early_out_tasks_assigned": existing_tasks,
    "meta": existing_meta
}

with open(OUTPUT_EARLY_OUT, "w", encoding="utf-8") as f:
    json.dump(output_data, f, ensure_ascii=False, indent=2)

print(f"✅ OK. Aggiunte {total_assigned} task followup anche in {OUTPUT_EARLY_OUT}.")

# =============================
# Aggiorna timeline_assignments.json con le task followup
# =============================
TIMELINE_ASSIGNMENTS = BASE / "output" / "timeline_assignments.json"

# Carica o crea timeline_assignments.json
timeline_data = {"assignments": []}
if TIMELINE_ASSIGNMENTS.exists():
    with open(TIMELINE_ASSIGNMENTS, "r", encoding="utf-8") as f:
        timeline_data = json.load(f)

# Aggiungi le assegnazioni followup alla timeline
for assignment in all_results:
    for task in assignment["assigned_tasks"]:
        # Trova task originale per logistic_code
        logistic_code = None
        for t in pool_unassigned:
            if t["task_id"] == task["task_id"]:
                logistic_code = str(t.get("logistic_code", t["task_id"]))
                break

        if logistic_code:
            # Rimuovi eventuali assegnazioni precedenti per questo logistic_code
            timeline_data["assignments"] = [
                a for a in timeline_data["assignments"]
                if a.get("logistic_code") != logistic_code
            ]

            # Aggiungi la nuova assegnazione followup
            timeline_data["assignments"].append({
                "logistic_code": logistic_code,
                "cleanerId": assignment["cleaner_id"],
                "assignment_type": "followup_auto"
            })

# Salva timeline_assignments.json aggiornato
with open(TIMELINE_ASSIGNMENTS, "w", encoding="utf-8") as f:
    json.dump(timeline_data, f, ensure_ascii=False, indent=2)

print(f"✅ OK. Aggiunte {total_assigned} task followup anche in {TIMELINE_ASSIGNMENTS}.")