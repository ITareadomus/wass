import json
import math
from datetime import datetime
from collections import defaultdict
from typing import List, Dict, Any, Optional

# -----------------------------
# Parametri di modello/config
# -----------------------------
URBAN_SPEED_KMPH = 25.0          # velocità media per stimare i tempi di viaggio
SERVICE_BUFFER_MIN = 0           # buffer aggiuntivo al cleaning_time (min)
CHECKIN_TOLERANCE_MIN = 10       # tolleranza sulle task con checkin_time noto (± min)
DAY_START_DEFAULT = "08:00"      # finestra larga quando orari non noti
DAY_END_DEFAULT = "21:00"
MAX_ROUTE_MIN = 10 * 60          # limite orario massimo per turno (min) — 10h

INPUT_ASSIGNMENTS = "client/public/data/output/early_out_assignments.json"
INPUT_EARLYOUT = "client/public/data/output/early_out.json"
INPUT_CLEANERS = "client/public/data/cleaners/selected_cleaners.json"
OUTPUT_FILE = "client/public/data/output/followup_assignments.json"

# -----------------------------
# Utility
# -----------------------------
def hhmm_to_minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)

def minutes_to_hhmm(m: int) -> str:
    m = int(round(m))
    h = m // 60
    mm = m % 60
    return f"{h:02d}:{mm:02d}"

def haversine_km(lat1, lon1, lat2, lon2) -> float:
    R = 6371.0
    phi1, phi2 = math.radians(float(lat1)), math.radians(float(lat2))
    dphi = phi2 - phi1
    dlambda = math.radians(float(lon2) - float(lon1))
    a = math.sin(dphi/2.0)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlambda/2.0)**2
    return 2 * R * math.asin(math.sqrt(a))

def travel_minutes(lat1, lon1, lat2, lon2, speed_kmph=URBAN_SPEED_KMPH) -> int:
    km = haversine_km(lat1, lon1, lat2, lon2)
    hours = km / max(1e-6, speed_kmph)
    return int(round(hours * 60))

def parse_date(s: str) -> datetime.date:
    return datetime.strptime(s, "%Y-%m-%d").date()

def try_hhmm(s: Optional[str], fallback: str) -> str:
    return s if s and ":" in s else fallback

# -----------------------------
# Carica dati
# -----------------------------
with open(INPUT_ASSIGNMENTS, "r", encoding="utf-8") as f:
    assignments = json.load(f)
with open(INPUT_EARLYOUT, "r", encoding="utf-8") as f:
    earlyout = json.load(f)
with open(INPUT_CLEANERS, "r", encoding="utf-8") as f:
    cleaners_blob = json.load(f)

assigned_items = assignments.get("early_out_tasks_assigned", [])
selected_cleaners = cleaners_blob.get("cleaners", [])
earlyout_tasks = earlyout.get("early_out_tasks", [])

# -----------------------------
# Indici e pool task
# -----------------------------
cleaner_by_id = {c["id"]: c for c in selected_cleaners}

seed_by_cleaner_and_date = defaultdict(list)  # (cleaner_id, date) -> EO già assegnate
unassigned_pool = []  # task da assegnare

for t in assigned_items:
    d = parse_date(t["checkin_date"])
    if t.get("assigned_cleaner"):
        cid = t["assigned_cleaner"]["id"]
        if cid in cleaner_by_id:
            # Usa start_time dall'assigned_cleaner, o calcola da checkout_time se manca
            ac = t["assigned_cleaner"]
            if ac.get("start_time"):
                start_hhmm = ac["start_time"]
            elif t.get("checkout_time"):
                # Se non c'è start_time ma c'è checkout, usa checkout come riferimento
                start_hhmm = t["checkout_time"]
            else:
                start_hhmm = DAY_START_DEFAULT
            
            # Calcola end_time: se presente usa quello, altrimenti start + cleaning_time
            if ac.get("end_time"):
                end_hhmm = ac["end_time"]
            else:
                end_hhmm = minutes_to_hhmm(hhmm_to_minutes(start_hhmm) + int(t["cleaning_time"]))
            
            seed_by_cleaner_and_date[(cid, d)].append({
                "task_id": t["task_id"],
                "lat": float(t["lat"]),
                "lng": float(t["lng"]),
                "start_hhmm": start_hhmm,
                "end_hhmm": end_hhmm,
                "cleaning_time": int(t["cleaning_time"]),
                "address": t["address"],
            })
    # Aggiungi solo task veramente non assegnate (senza cleaner o con status unassigned)
    if (t.get("assignment_status") or "").startswith("unassigned") and not t.get("assigned_cleaner"):
        # Per le follow-up non serve il checkin_time, usiamo l'end_time delle EO come riferimento
        unassigned_pool.append({
            "task_id": t["task_id"],
            "date": d,
            "lat": float(t["lat"]), "lng": float(t["lng"]),
            "cleaning_time": int(t["cleaning_time"]),
            "checkin_time": None,  # Non serve per follow-up
            "address": t["address"],
            "alias": t.get("alias"),
            "premium": bool(t.get("premium", False))
        })

for t in earlyout_tasks:
    unassigned_pool.append({
        "task_id": t["task_id"],
        "date": parse_date(t["checkin_date"]),
        "lat": float(t["lat"]), "lng": float(t["lng"]),
        "cleaning_time": int(t["cleaning_time"]),
        "checkin_time": t.get("checkin_time"),
        "address": t["address"],
        "alias": t.get("alias"),
        "premium": bool(t.get("premium", False))
    })

tasks_by_date = defaultdict(list)
for t in unassigned_pool:
    tasks_by_date[t["date"]].append(t)

# -----------------------------
# Funzione helper per identificare i Formatori
# -----------------------------
def is_formatore(cleaner: Dict[str, Any]) -> bool:
    return str(cleaner.get("role", "")).strip().lower() == "formatore"

# -----------------------------
# OR-Tools
# -----------------------------
from ortools.constraint_solver import routing_enums_pb2
from ortools.constraint_solver import pywrapcp

def build_and_solve_for_date(the_date, tasks: List[Dict[str, Any]], cleaners: List[Dict[str, Any]]):
    if not tasks:
        return [], []

    # Filtra i Formatori dal pool di cleaners disponibili
    cleaners = [c for c in cleaners if not is_formatore(c)]
    
    if not cleaners:
        return [], []

    # start per cleaner (dopo EO di seed)
    start_info = []
    for c in cleaners:
        cid = c["id"]
        c_start = try_hhmm(c.get("start_time"), DAY_START_DEFAULT)
        seeds = seed_by_cleaner_and_date.get((cid, the_date), [])
        if seeds:
            seeds_sorted = sorted(seeds, key=lambda s: hhmm_to_minutes(s["end_hhmm"]))
            last = seeds_sorted[-1]
            origin_lat, origin_lng = last["lat"], last["lng"]
            origin_time_min = hhmm_to_minutes(last["end_hhmm"])
        else:
            origin_lat = sum(t["lat"] for t in tasks)/len(tasks)
            origin_lng = sum(t["lng"] for t in tasks)/len(tasks)
            origin_time_min = hhmm_to_minutes(c_start)
        start_info.append({
            "cleaner_id": cid,
            "origin_lat": origin_lat,
            "origin_lng": origin_lng,
            "origin_time_min": origin_time_min
        })

    # nodi: task (0..N-1) + start veicoli (N..N+V-1)
    N = len(tasks)
    V = len(cleaners)

    lats = [t["lat"] for t in tasks] + [s["origin_lat"] for s in start_info]
    lngs = [t["lng"] for t in tasks] + [s["origin_lng"] for s in start_info]

    day_start = hhmm_to_minutes(DAY_START_DEFAULT)
    day_end = hhmm_to_minutes(DAY_END_DEFAULT)
    service = [0]*(N+V)
    tw_early = [day_start]*(N+V)
    tw_late = [day_end]*(N+V)

    for i, t in enumerate(tasks):
        service[i] = int(t["cleaning_time"] + SERVICE_BUFFER_MIN)
        # Per follow-up: finestra temporale ampia, partono dopo l'end_time delle EO
        tw_early[i] = day_start
        tw_late[i] = day_end

    for j, s in enumerate(start_info):
        idx = N + j
        service[idx] = 0
        # Il cleaner parte dall'end_time della sua ultima task EO
        tw_early[idx] = s["origin_time_min"]
        tw_late[idx] = day_end

    def travel(i, j):
        if i == j: return 0
        return travel_minutes(lats[i], lngs[i], lats[j], lngs[j])

    travel_cache = {}
    def travel_cached(i, j):
        key = (i, j)
        if key not in travel_cache:
            travel_cache[key] = travel(i, j)
        return travel_cache[key]

    starts = [N + v for v in range(V)]
    ends = [N + v for v in range(V)]
    manager = pywrapcp.RoutingIndexManager(N + V, V, starts, ends)
    routing = pywrapcp.RoutingModel(manager)

    def time_callback(from_index, to_index):
        i = manager.IndexToNode(from_index)
        j = manager.IndexToNode(to_index)
        return travel_cached(i, j)
    transit_callback_index = routing.RegisterTransitCallback(time_callback)
    routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)

    def time_with_service(from_index, to_index):
        i = manager.IndexToNode(from_index)
        j = manager.IndexToNode(to_index)
        return service[i] + travel_cached(i, j)
    time_ws_index = routing.RegisterTransitCallback(time_with_service)
    routing.AddDimension(
        time_ws_index,
        60,                  # slack
        MAX_ROUTE_MIN,       # max durata route
        False,               # non forzare lo start a 0
        "Time"
    )
    time_dim = routing.GetDimensionOrDie("Time")

    # Finestre temporali
    for node in range(N + V):
        index = manager.NodeToIndex(node)
        time_dim.CumulVar(index).SetRange(tw_early[node], tw_late[node])

    # ===== VINCOLO PREMIUM =====
    # mappa veicoli Premium
    premium_vehicle_ids = {v for v, c in enumerate(cleaners) if str(c.get("role", "")).lower() == "premium"}
    has_premium_cleaners = len(premium_vehicle_ids) > 0
    premium_fallback_today = []  # colleziona task_id se saremo costretti a usare Standard (solo quando non ci sono Premium)

    # Se ci sono cleaner Premium: restringi i nodi premium ai soli veicoli premium
    # Se non ci sono: permetti a tutti, ma segna fallback (visivo in output)
    for node in range(N):
        if tasks[node].get("premium", False):
            if has_premium_cleaners:
                allowed = sorted(list(premium_vehicle_ids))
                routing.SetAllowedVehiclesForIndex(allowed, manager.NodeToIndex(node))
            else:
                # nessun premium: lascio tutti i veicoli, ma segno che questa data va in fallback
                premium_fallback_today.append(tasks[node]["task_id"])

    # Disjunction per consentire opzionalità (penalità alta -> solver proverà ad assegnare)
    penalty = 100000
    for node in range(N):
        routing.AddDisjunction([manager.NodeToIndex(node)], penalty)

    # Parametri di ricerca
    search_params = pywrapcp.DefaultRoutingSearchParameters()
    search_params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    search_params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    search_params.time_limit.FromSeconds(30)  # Aumentato a 30s per problemi più complessi
    search_params.log_search = False  # Disabilita log verboso

    solution = routing.SolveWithParameters(search_params)
    results = []

    if solution:
        for v in range(V):
            cleaner = cleaners[v]
            cid = cleaner["id"]
            idx = routing.Start(v)
            route = []
            path_nodes = []
            while not routing.IsEnd(idx):
                node = manager.IndexToNode(idx)
                path_nodes.append(node)
                if node < N:
                    t = tasks[node]
                    start_min = solution.Min(time_dim.CumulVar(idx))
                    end_min = start_min + service[node]
                    # flag visivo: premium assegnata a Standard SOLO nel caso fallback (nessun premium disponibile)
                    premium_fallback = False
                    if t.get("premium", False) and str(cleaner.get("role","")).lower() != "premium" and not has_premium_cleaners:
                        premium_fallback = True
                    route.append({
                        "task_id": t["task_id"],
                        "address": t["address"],
                        "alias": t.get("alias"),
                        "start_time": minutes_to_hhmm(start_min),
                        "end_time": minutes_to_hhmm(end_min),
                        "service_min": service[node],
                        "premium": bool(t.get("premium", False)),
                        "premium_fallback": premium_fallback
                    })
                idx = solution.Value(routing.NextVar(idx))

            if route:
                # km totali stimati sulla path (incluso start virtuale)
                km_total = 0.0
                for a, b in zip(path_nodes, path_nodes[1:]):
                    km_total += haversine_km(lats[a], lngs[a], lats[b], lngs[b])
                results.append({
                    "date": the_date.isoformat(),
                    "cleaner_id": cid,
                    "cleaner_name": f"{cleaner.get('name','')}".strip(),
                    "cleaner_role": cleaner.get("role"),
                    "route_km_est": round(km_total, 2),
                    "assigned_tasks": route
                })

    return results, premium_fallback_today

# -----------------------------
# Risolvi per ogni data
# -----------------------------
all_results = []
premium_fallback_dates = defaultdict(list)  # date -> task_ids premium in fallback

for the_date in sorted(tasks_by_date.keys()):
    cleaners_ordered = [c for c in selected_cleaners]
    tasks_for_date = tasks_by_date[the_date]
    
    print(f"\n=== Elaborazione data {the_date.isoformat()} ===")
    print(f"Task da assegnare: {len(tasks_for_date)}")
    print(f"Cleaners disponibili: {len([c for c in cleaners_ordered if not is_formatore(c)])}")
    
    # Mostra dettagli task problematiche (senza checkin_time)
    no_checkin = [t for t in tasks_for_date if not t.get("checkin_time")]
    if no_checkin:
        print(f"WARN: {len(no_checkin)} task senza checkin_time: {[t['task_id'] for t in no_checkin]}")
    
    try:
        day_results, day_fallback = build_and_solve_for_date(the_date, tasks_for_date, cleaners_ordered)
        all_results.extend(day_results)
        if day_fallback:
            premium_fallback_dates[the_date.isoformat()] = day_fallback
        print(f"✓ Assegnate {sum(len(r['assigned_tasks']) for r in day_results)} task per {len(day_results)} cleaners")
    except Exception as e:
        print(f"✗ ERRORE nella data {the_date.isoformat()}: {e}")
        import traceback
        traceback.print_exc()
        # Continua con le altre date invece di fermarsi
        continue

# -----------------------------
# Salva output
# -----------------------------
with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
    json.dump({
        "meta": {
            "speed_kmph": URBAN_SPEED_KMPH,
            "day_start_default": DAY_START_DEFAULT,
            "day_end_default": DAY_END_DEFAULT,
            "checkin_tolerance_min": CHECKIN_TOLERANCE_MIN,
            "max_route_min": MAX_ROUTE_MIN,
            "premium_rule": "premium tasks require premium cleaners; if none exist, allow standard and mark premium_fallback=true",
            "premium_fallback_dates": list(premium_fallback_dates.keys()),
            "premium_fallback_task_ids": premium_fallback_dates
        },
        "assignments": all_results
    }, f, ensure_ascii=False, indent=2)

total_assigned = sum(len(r['assigned_tasks']) for r in all_results)
print(f"OK. Scritto {OUTPUT_FILE} con {total_assigned} task assegnate.")
if premium_fallback_dates:
    print("ATTENZIONE: fallback premium->standard in queste date:", ", ".join(premium_fallback_dates.keys()))
