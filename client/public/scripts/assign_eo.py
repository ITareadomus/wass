# -*- coding: utf-8 -*-
from __future__ import annotations
import json, math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path
from collections import defaultdict, Counter

# Motivi di scarto/assegnazione
REASON_MAP: dict[int, Counter] = defaultdict(Counter)

def _add_reason(task: "Task", reason: str):
    try:
        lc = int(task.logistic_code)
    except Exception:
        lc = -1
    REASON_MAP[lc][reason] += 1


# =============================
# I/O paths
# =============================
BASE = Path(__file__).parent.parent / "data"

INPUT_TASKS = BASE / "output" / "early_out.json"
INPUT_CLEANERS = BASE / "cleaners" / "selected_cleaners.json"
OUTPUT_ASSIGN = BASE / "output" / "early_out_assignments.json"

# =============================
# CONFIG
# =============================
MAX_TASKS_PER_CLEANER = 3  # 3, ma la 3ª segue la regola "vicina"
REGRET_K = 2

# Hard caps (sempre attivi)
HARD_MAX_TRAVEL = 22.0  # travel > 22' => infeasible
HARD_MAX_GAP = 22.0  # (start_B - end_A) > 22' => infeasible

# 3ª task (2→3 hop) - default e deroga stessa via/edificio
THIRD_TASK_MAX_TRAVEL = 10.0
THIRD_TASK_MAX_GAP = 10.0
THIRD_TASK_SAME_STREET_TRAVEL = 12.0
THIRD_TASK_SAME_STREET_GAP = 12.0

# Redirect: se un inserimento crea hop > 15', preferisci un cleaner libero idoneo
REDIRECT_TRAVEL = 15.0

# Travel model (min)
SHORT_RANGE_KM = 0.30
SHORT_BASE_MIN = 3.5
WALK_SLOW_MIN_PER_KM = 16.0

BASE_OVERHEAD_MIN = 6.0
SCALED_OH_KM = 0.50
K_SWITCH_KM = 1.2
WALK_MIN_PER_KM = 12.0
RIDE_MIN_PER_KM = 4.5

EQ_EXTRA_LT05 = 2.0
EQ_EXTRA_GE05 = 1.0

MIN_TRAVEL = 2.0
MAX_TRAVEL = 45.0

# Costi/penalità
ACTIVATION_COST = 0.0
PENALTY_STANDARD_TO_PREMIUM = 0.0  # i premium possono fare standard senza malus


@dataclass
class Task:
    task_id: str
    logistic_code: str
    lat: float
    lng: float
    cleaning_time: int
    checkout_time: int
    checkin_time: int
    is_premium: bool
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
    route: List[Task] = field(default_factory=list)


# -------- Utils --------
def hhmm_to_min(hhmm: Optional[str], default: str = "10:00") -> int:
    if not hhmm or not isinstance(hhmm, str) or ":" not in hhmm:
        hhmm = default
    h, m = hhmm.strip().split(":")
    return int(h) * 60 + int(m)


def min_to_hhmm(m: float) -> str:
    m = int(round(m))
    return f"{m//60:02d}:{m%60:02d}"


def normalize_addr(s: Optional[str]) -> str:
    s = (s or "").upper()
    for ch in [".", ","]:
        s = s.replace(ch, " ")
    s = " ".join(s.split())
    return s.strip()


def split_street_number(addr: str):
    tokens = addr.split()
    if not tokens:
        return "", None
    last = tokens[-1]
    if any(ch.isdigit() for ch in last):
        return " ".join(tokens[:-1]).strip(), last
    return addr, None


def same_building(a: Optional[str], b: Optional[str]) -> bool:
    na, nb = normalize_addr(a), normalize_addr(b)
    if not na or not nb:
        return False
    sa, ca = split_street_number(na)
    sb, cb = split_street_number(nb)
    return (sa == sb) and (ca is not None) and (cb is not None) and (ca == cb)


def same_street(a: Optional[str], b: Optional[str]) -> bool:
    na, nb = normalize_addr(a), normalize_addr(b)
    if not na or not nb:
        return False
    sa, _ = split_street_number(na)
    sb, _ = split_street_number(nb)
    return sa == sb


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(
        dphi / 2)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(dl / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


def travel_minutes(a: Optional[Task], b: Optional[Task]) -> float:
    if a is None or b is None:
        return 0.0
    km = haversine_km(a.lat, a.lng, b.lat, b.lng)

    if same_building(a.address, b.address):
        t = SHORT_BASE_MIN
        return max(MIN_TRAVEL, min(MAX_TRAVEL, t))

    if km < SHORT_RANGE_KM:
        t = SHORT_BASE_MIN + WALK_SLOW_MIN_PER_KM * km
    else:
        overhead = BASE_OVERHEAD_MIN * (
            km / SCALED_OH_KM) if km < SCALED_OH_KM else BASE_OVERHEAD_MIN
        t = overhead
        if km <= K_SWITCH_KM:
            t += WALK_MIN_PER_KM * km
        else:
            t += WALK_MIN_PER_KM * K_SWITCH_KM + RIDE_MIN_PER_KM * (
                km - K_SWITCH_KM)

    if getattr(a, "small_equipment", False) or getattr(b, "small_equipment",
                                                       False):
        t += (EQ_EXTRA_LT05 if km < 0.5 else EQ_EXTRA_GE05)

    if same_street(a.address, b.address) and km < 0.10:
        t += 1.0

    return max(MIN_TRAVEL, min(MAX_TRAVEL, t))


def can_handle_premium(cleaner: Cleaner, task: Task) -> bool:
    # Premium task requires premium cleaner
    if task.is_premium and not cleaner.is_premium:
        return False
    # Straordinaria requires premium cleaner
    if task.straordinaria and not cleaner.is_premium:
        return False
    return True


def premium_soft_penalty(cleaner: Cleaner, task: Task) -> float:
    return PENALTY_STANDARD_TO_PREMIUM if (not task.is_premium
                                           and cleaner.is_premium) else 0.0


# -------- Schedulazione / costo --------
def evaluate_route_cost(
        route: List[Task]) -> Tuple[float, List[Tuple[int, int, int]]]:
    if not route:
        return 0.0, []
    total = ACTIVATION_COST
    schedule: List[Tuple[int, int, int]] = []
    prev: Optional[Task] = None
    prev_finish: Optional[float] = None
    cur = 0.0
    for i, t in enumerate(route):
        tt = travel_minutes(prev, t)
        total += tt
        # Hard cap travel
        if tt > HARD_MAX_TRAVEL:
            return float("inf"), []
        cur += tt
        arrival = cur
        wait = max(0.0, t.checkout_time - arrival)
        total += wait
        cur += wait
        start = cur
        finish = start + t.cleaning_time

        # Hard cap gap porta-a-porta
        if prev_finish is not None and (start - prev_finish) > HARD_MAX_GAP:
            return float("inf"), []

        # Regola 3ª task
        if i == 2 and prev is not None:
            relax = same_building(prev.address, t.address) or same_street(
                prev.address, t.address)
            t_travel_cap = THIRD_TASK_SAME_STREET_TRAVEL if relax else THIRD_TASK_MAX_TRAVEL
            t_gap_cap = THIRD_TASK_SAME_STREET_GAP if relax else THIRD_TASK_MAX_GAP
            door2door = start - prev_finish if prev_finish is not None else 0.0
            if tt > t_travel_cap or door2door > t_gap_cap:
                return float("inf"), []

        if finish >= t.checkin_time:
            return float("inf"), []

        total += t.cleaning_time
        cur = finish
        schedule.append((int(arrival), int(start), int(finish)))
        prev = t
        prev_finish = finish
    return total, schedule

def analyze_route_infeasibility(route: List["Task"]) -> str:
    """
    Ricalcola la schedule e restituisce il primo motivo plausibile di infeasibilità.
    (Uso diagnostico: non influenza la scelta dell'ottimizzatore standard.)
    """
    if not route:
        return "vuoto"
    prev: Optional[Task] = None
    prev_finish: Optional[float] = None
    cur = 0.0
    for i, t in enumerate(route):
        tt = travel_minutes(prev, t)
        if tt > HARD_MAX_TRAVEL:
            return "violato cap travel 22' (hop)"
        cur += tt
        arrival = cur
        wait = max(0.0, t.checkout_time - arrival)
        cur += wait
        start = cur
        finish = start + t.cleaning_time
        if prev_finish is not None and (start - prev_finish) > HARD_MAX_GAP:
            return "violato cap gap 22' (porta-a-porta)"
        if i == 2 and prev is not None:
            relax = same_building(prev.address, t.address) or same_street(prev.address, t.address)
            t_travel_cap = THIRD_TASK_SAME_STREET_TRAVEL if relax else THIRD_TASK_MAX_TRAVEL
            t_gap_cap = THIRD_TASK_SAME_STREET_GAP if relax else THIRD_TASK_MAX_GAP
            door2door = start - prev_finish if prev_finish is not None else 0.0
            if tt > t_travel_cap:
                return "regola 3ª task: travel oltre cap"
            if door2door > t_gap_cap:
                return "regola 3ª task: gap oltre cap"
        if finish >= t.checkin_time:
            return "deadline supera check-in"
        cur = finish
        prev = t
        prev_finish = finish
    return "infeasible (causa non specificata)"



def delta_insert_cost(route: List[Task], task: Task,
                      pos: int) -> Tuple[float, List[Task]]:
    base, _ = evaluate_route_cost(route)
    new_route = route[:pos] + [task] + route[pos:]
    new, _ = evaluate_route_cost(new_route)
    return new - base, new_route


def max_new_hop_if_insert(route: List[Task], task: Task, pos: int) -> float:
    prev_t = route[pos -
                   1] if (pos - 1) >= 0 and (pos - 1) < len(route) else None
    next_t = route[pos] if pos < len(route) else None
    hop_left = travel_minutes(prev_t, task) if prev_t else 0.0
    hop_right = travel_minutes(task, next_t) if next_t else 0.0
    return max(hop_left, hop_right)


def has_free_cleaner_for(task: Task, cleaners: List[Cleaner]) -> bool:
    for free in cleaners:
        if free.route:
            continue
        if not can_handle_premium(free, task):
            continue
        new_route = [task]
        cost, _ = evaluate_route_cost(new_route)  # applica cap, orari
        if not math.isinf(cost):
            return True
    return False


# -------- Loader --------
def load_cleaners() -> List[Cleaner]:
    data = json.loads(INPUT_CLEANERS.read_text(encoding="utf-8"))
    cleaners: List[Cleaner] = []
    for c in data.get("cleaners", []):
        role = (c.get("role") or "").strip()
        is_premium = bool(c.get("premium", (role.lower() == "premium")))
        if (role or "").lower() == "formatore":
            continue
        cleaners.append(
            Cleaner(
                id=c.get("id"),
                name=c.get("name") or str(c.get("id")),
                lastname=c.get("lastname", ""),
                role=role or ("Premium" if is_premium else "Standard"),
                is_premium=is_premium,
                home_lat=c.get("home_lat"),
                home_lng=c.get("home_lng"),
            ))
    return cleaners


def load_tasks() -> List[Task]:
    data = json.loads(INPUT_TASKS.read_text(encoding="utf-8"))
    eo_start_min = hhmm_to_min("10:00")
    tasks: List[Task] = []
    for t in data.get("early_out_tasks", []):
        # Per gli early-out, checkout_time NON è rilevante come vincolo di inizio
        # Tutte le task possono iniziare dalle 10:00 in poi
        # L'unico vincolo è finire prima del checkin_time
        checkout = eo_start_min  # Tutte le early-out possono iniziare dalle 10:00
        checkin = hhmm_to_min(t.get("checkin_time"), default="23:59")
        
        tasks.append(
            Task(
                task_id=str(t.get("task_id")),
                logistic_code=str(t.get("logistic_code")),
                lat=float(t.get("lat")),
                lng=float(t.get("lng")),
                cleaning_time=int(t.get("cleaning_time") or 45),
                checkout_time=checkout,
                checkin_time=checkin,
                is_premium=bool(t.get("premium", False)),
                apt_type=t.get("type_apt"),
                address=t.get("address"),
                alias=t.get("alias"),
                small_equipment=bool(t.get("small_equipment", False)),
                straordinaria=bool(t.get("straordinaria", False)),
            ))
    # Straordinarie first, poi premium-first, poi per checkout
    tasks.sort(key=lambda x: (not x.straordinaria, not x.is_premium, x.checkout_time))
    return tasks


# -------- Planner --------
def plan_day(tasks: List[Task],
             cleaners: List[Cleaner]) -> Tuple[List[Cleaner], List[Task]]:
    unassigned = tasks[:]
    iteration = 0
    while unassigned:
        iteration += 1
        chosen = None  # (regret, delta, task, cleaner, pos, new_route)
        tasks_with_no_options = []
        global_min_infeasible = None  # (hop, task, cleaner, pos, new_route)
        
        for task in list(unassigned):
            per_cleaner_best: List[Tuple[Cleaner, float, float, int,
                                         List[Task]]] = []
            min_infeasible_hop = None
            min_infeasible_choice = None  # (cleaner, pos, new_route, hop)

            for cl in cleaners:
                if len(cl.route) >= MAX_TASKS_PER_CLEANER:
                    _add_reason(task, "limite max task per cleaner")
                    continue
                if not can_handle_premium(cl, task):
                    _add_reason(task, "richiede premium")
                    continue

                best_local = (float("inf"), -1, [])  # (delta, pos, new_route)
                second_local = float("inf")

                for pos in range(len(cl.route) + 1):
                    # Straordinaria MUST be first (pos=0, sequence=1)
                    if task.straordinaria and pos != 0:
                        _add_reason(task, "straordinaria deve essere prima (sequence=1)")
                        continue
                    # If route already has straordinaria at pos=0, can't add another straordinaria
                    if task.straordinaria and len(cl.route) > 0 and cl.route[0].straordinaria:
                        _add_reason(task, "presente un'altra straordinaria in sequenza 1")
                        continue
                    
                    # redirect: se l'inserimento crea hop > 15' e c'è un libero idoneo, salta
                    prev_t = cl.route[pos -
                                      1] if (pos - 1) >= 0 and (pos - 1) < len(
                                          cl.route) else None
                    next_t = cl.route[pos] if pos < len(cl.route) else None
                    hop_left = travel_minutes(prev_t, task) if prev_t else 0.0
                    hop_right = travel_minutes(task, next_t) if next_t else 0.0
                    if (hop_left > REDIRECT_TRAVEL or hop_right
                            > REDIRECT_TRAVEL) and has_free_cleaner_for(
                                task, cleaners):
                        _add_reason(task, "redirect hop>15 con cleaner libero")
                        continue

                    local_max_hop = max(hop_left, hop_right)
                    d, new_r = delta_insert_cost(cl.route, task, pos)

                    # se infeasible o hop > 22', tienila come fallback "best-of-infeasible"
                    if math.isinf(d) or local_max_hop > HARD_MAX_TRAVEL:
                        if math.isinf(d):
                            _add_reason(task, analyze_route_infeasibility(new_r))
                        if local_max_hop > HARD_MAX_TRAVEL:
                            _add_reason(task, "violato cap travel 22' (hop)")
                        if (min_infeasible_hop
                                is None) or (local_max_hop
                                             < min_infeasible_hop):
                            min_infeasible_hop = local_max_hop
                            min_infeasible_choice = (cl, pos, new_r,
                                                     local_max_hop)
                        continue

                    if d < best_local[0]:
                        second_local = best_local[0]
                        best_local = (d, pos, new_r)
                    elif d < second_local:
                        second_local = d

                if best_local[1] != -1:
                    per_cleaner_best.append((cl, best_local[0], second_local,
                                             best_local[1], best_local[2]))

            # nessuna mossa fattibile ≤22'? usa il fallback se esiste
            if not per_cleaner_best:
                if min_infeasible_choice is not None:
                    _cl, _pos, _route, _hop = min_infeasible_choice
                    _cl.route = _route
                    unassigned.remove(task)
                    continue
                # altrimenti resta unassigned - tracciala
                tasks_with_no_options.append(task)
                continue

            per_cleaner_best.sort(
                key=lambda x: x[1])  # ordina per miglior delta
            d1_cl, d1, d2, pos1, route1 = per_cleaner_best[0][
                0], per_cleaner_best[0][1], per_cleaner_best[0][
                    2], per_cleaner_best[0][3], per_cleaner_best[0][4]
            # second-best globale (per regret)
            second_delta = None
            for c, dd1, dd2, ppos, rroute in per_cleaner_best[1:]:
                second_delta = dd1
                break
            if second_delta is None:
                second_delta = d1 + 60.0
            regret = second_delta - d1
            if (chosen is None) or (regret > chosen[0]) or (
                    abs(regret - chosen[0]) < 1e-6 and d1 < chosen[1]):
                chosen = (regret, d1, task, d1_cl, pos1, route1)

        # aggiorna best-of-infeasible globale
        if min_infeasible_choice is not None:
            clx, pposx, rrx, hopx = min_infeasible_choice
            if (global_min_infeasible is None) or (hopx < global_min_infeasible[0]):
                global_min_infeasible = (hopx, task, clx, pposx, rrx)

        if chosen is None:
            # Nessuna mossa feasible: se esiste best-of-infeasible, applicalo (minor hop)
            if global_min_infeasible is not None:
                _, task, cl_b, pos_b, new_r_b = global_min_infeasible
                _add_reason(task, "best-of-infeasible applicato")
                cl_b.route = new_r_b
                unassigned.remove(task)
                continue
            break
        _, _, task, cl, pos, new_r = chosen
        cl.route = new_r  # commit
        unassigned.remove(task)

    # Ritorna i cleaner con le route assegnate e le task rimaste non assegnate
    return cleaners, unassigned







def _relaxed_append_cost(route: List[Task], task: Task) -> Tuple[bool, float, List[Task]]:
    """
    Prova ad appendere alla fine della route rilassando i cap (hop/gap/3rd).
    Ritorna (feasible, finish_time, new_route). Rispetta solo la deadline (finish < check-in).
    """
    new_r = list(route)
    # ricostruisci prev_finish con caps rilassati
    prev = None
    cur = 0.0
    prev_finish = 0.0
    for i, t in enumerate(new_r):
        tt = travel_minutes(prev, t)
        cur += tt
        wait = max(0.0, t.checkout_time - cur)
        cur += wait
        start = cur
        fin = start + t.cleaning_time
        prev = t
        prev_finish = fin
        cur = fin
    arrival = prev_finish + travel_minutes(prev, task) if new_r else travel_minutes(None, task)
    wait = max(0.0, task.checkout_time - arrival)
    start = arrival + wait
    fin = start + task.cleaning_time
    if fin >= task.checkin_time:
        return (False, fin, route)
    new_r.append(task)
    return (True, fin, new_r)


def final_fallback_assign(cleaners: List[Cleaner], leftovers: List[Task]) -> Tuple[List[Cleaner], List[Task]]:
    """
    HARD fallback: assegna le leftover rilassando i cap.
    Priorità candidati: (1) cleaners occupati con capacità residua (len(route)<MAX) idonei,
                        (2) cleaners liberi (premium prima).
    Criterio scelta: finish_time minimo (più "vicina" al check-in).
    """
    remaining = leftovers[:]
    # Ordina leftover: premium-first poi check-in crescente
    remaining.sort(key=lambda t: (not t.is_premium, t.checkin_time))

    for task in list(remaining):
        # (1) Occupati con cap
        occ = [cl for cl in cleaners if 0 < len(cl.route) < MAX_TASKS_PER_CLEANER and can_handle_premium(cl, task)]
        best = None  # (fin, cl, new_r, tag)
        for cl in occ:
            ok, fin, nr = _relaxed_append_cost(cl.route, task)
            if ok and (best is None or fin < best[0]):
                best = (fin, cl, nr, "occupied")
        # (2) Liberi
        free = [cl for cl in cleaners if len(cl.route)==0 and can_handle_premium(cl, task)]
        free.sort(key=lambda c: (not c.is_premium))  # premium-first
        for cl in free:
            ok, fin, nr = _relaxed_append_cost([], task)
            if ok and (best is None or fin < best[0]):
                best = (fin, cl, nr, "free")

        if best is not None:
            _, cl_sel, nr_sel, tag = best
            cl_sel.route = nr_sel
            try:
                remaining.remove(task)
            except ValueError:
                pass
            _add_reason(task, f"assegnata via HARD fallback ({tag})")
    return cleaners, remaining
def build_output(cleaners: List[Cleaner],
                 unassigned: List[Task],
                 original_tasks: List[Task]) -> Dict[str, Any]:
    cleaners_with_tasks: List[Dict[str, Any]] = []
    for cl in cleaners:
        if not cl.route:
            continue
        total, schedule = evaluate_route_cost(cl.route)
        if math.isinf(total) or not schedule:
            continue
        tasks_list: List[Dict[str, Any]] = []
        prev_finish_time = None
        for idx, (t, (arr, start, fin)) in enumerate(zip(cl.route, schedule)):
            # Calcola il tempo di viaggio effettivo dalla schedulazione
            travel_time = 0
            if idx > 0 and prev_finish_time is not None:
                # Il travel time è la differenza tra arrivo e fine del task precedente
                travel_time = arr - prev_finish_time
            
            tasks_list.append({
                "task_id": int(t.task_id),
                "logistic_code": int(t.logistic_code),
                "address": t.address,
                "lat": t.lat,
                "lng": t.lng,
                "premium": t.is_premium,
                "cleaning_time": t.cleaning_time,
                "start_time": min_to_hhmm(start),
                "end_time": min_to_hhmm(fin),
                "followup": idx > 0,
                "sequence": idx + 1,
                "travel_time": travel_time
            })
            prev_finish_time = fin
        cleaners_with_tasks.append({
            "cleaner": {
                "id": cl.id,
                "name": cl.name,
                "lastname": cl.lastname,
                "role": cl.role,
                "premium": cl.is_premium
            },
            "tasks": tasks_list
        })
    
    # Costruisci la lista delle task non assegnate con i motivi
    unassigned_list = []
    for t in unassigned:
        try:
            lc = int(t.logistic_code)
        except:
            lc = -1
        
        # Recupera i motivi dal REASON_MAP
        reasons = []
        if lc in REASON_MAP and REASON_MAP[lc]:
            reasons = [f"{reason} (x{count})" for reason, count in REASON_MAP[lc].most_common()]
        
        if not reasons:
            reasons = ["nessun cleaner disponibile o tutti i vincoli violati"]
        
        unassigned_list.append({
            "task_id": int(t.task_id),
            "logistic_code": int(t.logistic_code),
            "address": t.address,
            "lat": t.lat,
            "lng": t.lng,
            "premium": t.is_premium,
            "straordinaria": t.straordinaria,
            "cleaning_time": t.cleaning_time,
            "checkout_time": min_to_hhmm(t.checkout_time),
            "checkin_time": min_to_hhmm(t.checkin_time),
            "alias": t.alias,
            "apt_type": t.apt_type,
            "reasons": reasons
        })

    total_assigned = sum(len(c["tasks"]) for c in cleaners_with_tasks)
    return {
        "early_out_tasks_assigned": cleaners_with_tasks,
        "unassigned_tasks": unassigned_list,
        "meta": {
            "total_tasks":
            total_assigned + len(unassigned_list),
            "assigned":
            total_assigned,
            "unassigned":
            len(unassigned_list),
            "cleaners_used":
            len(cleaners_with_tasks),
            "max_tasks_per_cleaner":
            MAX_TASKS_PER_CLEANER,
            "algorithm":
            "regret_insertion + redirect + best-of-infeasible",
            "notes": [
                "Straordinarie-first (only premium, must be sequence=1)",
                "Premium-first",
                "Hard cap: travel/gap > 22' infeasible (tranne fallback quando TUTTE le mosse superano 22')",
                "3rd task only if travel<=10' and gap<=10' (12'/12' if same street/building)",
                "Redirect: if hop>15' and a free cleaner is feasible, prefer the free cleaner",
                "Activation cost = 0; premium can do standard"
            ]
        }
    }


def main():
    if not INPUT_TASKS.exists():
        raise SystemExit(f"Missing input file: {INPUT_TASKS}")
    if not INPUT_CLEANERS.exists():
        raise SystemExit(f"Missing input file: {INPUT_CLEANERS}")
    
    cleaners = load_cleaners()
    tasks = load_tasks()
    planners, leftovers = plan_day(tasks, cleaners)
    planners, leftovers = final_fallback_assign(planners, leftovers)
    output = build_output(planners, leftovers, tasks)
    
    # Ensure output directory exists
    OUTPUT_ASSIGN.parent.mkdir(parents=True, exist_ok=True)
    
    OUTPUT_ASSIGN.write_text(json.dumps(output, ensure_ascii=False, indent=2),
                             encoding="utf-8")
    print(f"✅ Wrote {OUTPUT_ASSIGN}")
    
    # Update timeline_assignments.json
    timeline_assignments_path = OUTPUT_ASSIGN.parent / "timeline_assignments.json"
    timeline_data = {"assignments": []}
    
    # Load existing timeline assignments if they exist
    if timeline_assignments_path.exists():
        try:
            timeline_data = json.loads(timeline_assignments_path.read_text(encoding="utf-8"))
        except:
            timeline_data = {"assignments": []}
    
    # Remove old early-out assignments
    assigned_codes = set()
    for cleaner_entry in output["early_out_tasks_assigned"]:
        for task in cleaner_entry.get("tasks", []):
            assigned_codes.add(str(task["logistic_code"]))
    
    timeline_data["assignments"] = [
        a for a in timeline_data.get("assignments", [])
        if str(a.get("logistic_code")) not in assigned_codes
    ]
    
    # Add new assignments
    for cleaner_entry in output["early_out_tasks_assigned"]:
        cleaner_id = cleaner_entry["cleaner"]["id"]
        for task in cleaner_entry.get("tasks", []):
            timeline_data["assignments"].append({
                "logistic_code": str(task["logistic_code"]),
                "cleanerId": cleaner_id,
                "assignment_type": "optimizer",
                "sequence": task.get("sequence", 0)
            })
    
    timeline_assignments_path.write_text(json.dumps(timeline_data, ensure_ascii=False, indent=2),
                                         encoding="utf-8")
    print(f"✅ Aggiornato {timeline_assignments_path}")


if __name__ == "__main__":
    main()
