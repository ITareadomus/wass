
# -*- coding: utf-8 -*-
from __future__ import annotations
import json, math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path

# =============================
# I/O paths
# =============================
BASE = Path(__file__).parent.parent / "data"

INPUT_CONTAINERS = BASE / "output" / "containers.json"
INPUT_CLEANERS = BASE / "cleaners" / "selected_cleaners.json"
INPUT_EO_ASSIGN = BASE / "output" / "early_out_assignments.json"
INPUT_HP_ASSIGN = BASE / "output" / "high_priority_assignments.json"
OUTPUT_ASSIGN = BASE / "output" / "low_priority_assignments.json"

# =============================
# CONFIG - REGOLE SEMPLIFICATE
# =============================
MAX_TASKS_PER_CLEANER = 3  # Massimo 3 task per LP
PREFERRED_TRAVEL = 15.0  # Preferenza per percorsi < 15'

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


@dataclass
class Task:
    task_id: str
    logistic_code: str
    lat: float
    lng: float
    cleaning_time: int
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
    available_from: Optional[int] = None  # in minuti da mezzanotte
    last_address: Optional[str] = None
    last_lat: Optional[float] = None
    last_lng: Optional[float] = None
    last_sequence: int = 0
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
    a = math.sin(dphi / 2)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(dl / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


def travel_minutes(a_lat: float, a_lng: float, b_lat: float, b_lng: float,
                   a_addr: Optional[str] = None, b_addr: Optional[str] = None) -> float:
    km = haversine_km(a_lat, a_lng, b_lat, b_lng)

    if a_addr and b_addr and same_building(a_addr, b_addr):
        t = SHORT_BASE_MIN
        return max(MIN_TRAVEL, min(MAX_TRAVEL, t))

    if km < SHORT_RANGE_KM:
        t = SHORT_BASE_MIN + WALK_SLOW_MIN_PER_KM * km
    else:
        overhead = BASE_OVERHEAD_MIN * (km / SCALED_OH_KM) if km < SCALED_OH_KM else BASE_OVERHEAD_MIN
        t = overhead
        if km <= K_SWITCH_KM:
            t += WALK_MIN_PER_KM * km
        else:
            t += WALK_MIN_PER_KM * K_SWITCH_KM + RIDE_MIN_PER_KM * (km - K_SWITCH_KM)

    if a_addr and b_addr and same_street(a_addr, b_addr) and km < 0.10:
        t += 1.0

    return max(MIN_TRAVEL, min(MAX_TRAVEL, t))


def can_handle_premium(cleaner: Cleaner, task: Task) -> bool:
    if task.is_premium and not cleaner.is_premium:
        return False
    if task.straordinaria and not cleaner.is_premium:
        return False
    return True


# -------- Schedulazione / costo --------
def evaluate_route(cleaner: Cleaner, route: List[Task]) -> Tuple[bool, List[Tuple[int, int, int]]]:
    """
    Valuta se una route è fattibile per un cleaner LP.
    Ritorna: (is_feasible, schedule)
    schedule = [(arrival, start, finish), ...]
    """
    if not route:
        return True, []

    # Orario massimo di fine task: 19:00 (1140 minuti da mezzanotte)
    MAX_END_TIME = 19 * 60

    schedule: List[Tuple[int, int, int]] = []

    # Primo task LP
    first = route[0]

    # Calcola l'arrivo al primo task
    base = cleaner.available_from if cleaner.available_from else 10 * 60  # default 10:00

    # Viaggio da ultima posizione a LP
    if cleaner.last_lat is not None and cleaner.last_lng is not None:
        tt = travel_minutes(cleaner.last_lat, cleaner.last_lng,
                          first.lat, first.lng,
                          cleaner.last_address, first.address)
    else:
        tt = 3.0 if same_street(cleaner.last_address, first.address) else 12.0

    arrival = base + tt
    start = arrival
    finish = start + first.cleaning_time

    # Vincolo orario: nessuna task deve finire dopo le 19:00
    if finish > MAX_END_TIME:
        return False, []

    schedule.append((int(arrival), int(start), int(finish)))
    cur = finish

    # Task successive
    for i in range(1, len(route)):
        t = route[i]
        prev = route[i - 1]
        tt = travel_minutes(prev.lat, prev.lng, t.lat, t.lng, prev.address, t.address)
        cur += tt
        arrival = cur
        start = cur
        finish = start + t.cleaning_time

        # Vincolo orario: nessuna task deve finire dopo le 19:00
        if finish > MAX_END_TIME:
            return False, []

        schedule.append((int(arrival), int(start), int(finish)))
        cur = finish

    return True, schedule


def can_add_task(cleaner: Cleaner, task: Task) -> bool:
    """
    Verifica se è possibile aggiungere una task al cleaner secondo le regole:
    1. Premium task -> premium cleaner
    2. Straordinaria -> premium cleaner, deve essere la prima (pos=0)
    3. Max 3 task per cleaner per LP
    """
    if not can_handle_premium(cleaner, task):
        return False

    # Straordinaria deve essere la prima
    if task.straordinaria:
        if len(cleaner.route) > 0:
            return False

    # Se il cleaner ha già una straordinaria, non può aggiungerne altre
    if len(cleaner.route) > 0 and cleaner.route[0].straordinaria:
        if task.straordinaria:
            return False

    # Max 3 task per LP
    if len(cleaner.route) >= MAX_TASKS_PER_CLEANER:
        return False

    return True


def find_best_position(cleaner: Cleaner, task: Task) -> Optional[Tuple[int, float]]:
    """
    Trova la migliore posizione per inserire la task.
    Ritorna: (position, travel_time) oppure None se non fattibile

    Regola: favorisce percorsi < 15', altrimenti sceglie il minore dei > 15'
    """
    if not can_add_task(cleaner, task):
        return None

    best_pos = None
    best_travel = float('inf')

    # Straordinaria deve andare per forza in pos 0
    if task.straordinaria:
        test_route = [task] + cleaner.route
        feasible, _ = evaluate_route(cleaner, test_route)
        if feasible:
            return (0, 0.0)
        else:
            return None

    # Prova tutte le posizioni possibili
    for pos in range(len(cleaner.route) + 1):
        test_route = cleaner.route[:pos] + [task] + cleaner.route[pos:]
        feasible, _ = evaluate_route(cleaner, test_route)

        if not feasible:
            continue

        # Calcola il tempo di viaggio max generato da questo inserimento
        if pos == 0:
            # Prima task LP: calcola viaggio da ultima posizione
            if cleaner.last_lat is not None and cleaner.last_lng is not None:
                travel_to = travel_minutes(cleaner.last_lat, cleaner.last_lng,
                                         task.lat, task.lng,
                                         cleaner.last_address, task.address)
            else:
                travel_to = 3.0 if same_street(cleaner.last_address, task.address) else 12.0

            if len(cleaner.route) > 0:
                next_task = cleaner.route[0]
                travel_from = travel_minutes(task.lat, task.lng, next_task.lat, next_task.lng,
                                            task.address, next_task.address)
            else:
                travel_from = 0.0

            max_travel = max(travel_to, travel_from)
        else:
            prev_task = cleaner.route[pos - 1]
            travel_to = travel_minutes(prev_task.lat, prev_task.lng, task.lat, task.lng,
                                      prev_task.address, task.address)

            if pos < len(cleaner.route):
                next_task = cleaner.route[pos]
                travel_from = travel_minutes(task.lat, task.lng, next_task.lat, next_task.lng,
                                            task.address, next_task.address)
            else:
                travel_from = 0.0

            max_travel = max(travel_to, travel_from)

        # Scegli la posizione con minor viaggio
        if max_travel < best_travel:
            best_travel = max_travel
            best_pos = pos

    if best_pos is not None:
        return (best_pos, best_travel)

    return None


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
            ))
    return cleaners


def seed_cleaners_from_assignments(cleaners: List[Cleaner]):
    """
    Seed cleaners con informazioni da EO e HP assignments
    """
    # Carica EO assignments
    if INPUT_EO_ASSIGN.exists():
        data = json.loads(INPUT_EO_ASSIGN.read_text(encoding="utf-8"))
        for block in data.get("early_out_tasks_assigned", []):
            cid = int(block["cleaner"]["id"])
            tasks = block.get("tasks", [])
            if not tasks:
                continue
            last = tasks[-1]
            end_time = hhmm_to_min(last.get("end_time"))
            last_addr = last.get("address")
            last_lat = last.get("lat")
            last_lng = last.get("lng")
            last_seq = last.get("sequence") or len(tasks)
            for cl in cleaners:
                if cl.id == cid:
                    cl.available_from = end_time
                    cl.last_address = last_addr
                    cl.last_lat = float(last_lat) if last_lat is not None else None
                    cl.last_lng = float(last_lng) if last_lng is not None else None
                    cl.last_sequence = int(last_seq)
                    break

    # Carica HP assignments (sovrascrive EO se presenti)
    if INPUT_HP_ASSIGN.exists():
        data = json.loads(INPUT_HP_ASSIGN.read_text(encoding="utf-8"))
        for block in data.get("high_priority_tasks_assigned", []):
            cid = int(block["cleaner"]["id"])
            tasks = block.get("tasks", [])
            if not tasks:
                continue
            last = tasks[-1]
            end_time = hhmm_to_min(last.get("end_time"))
            last_addr = last.get("address")
            last_lat = last.get("lat")
            last_lng = last.get("lng")
            last_seq = last.get("sequence") or len(tasks)
            for cl in cleaners:
                if cl.id == cid:
                    cl.available_from = end_time
                    cl.last_address = last_addr
                    cl.last_lat = float(last_lat) if last_lat is not None else None
                    cl.last_lng = float(last_lng) if last_lng is not None else None
                    cl.last_sequence = int(last_seq)
                    break


def load_tasks() -> List[Task]:
    data = json.loads(INPUT_CONTAINERS.read_text(encoding="utf-8"))
    tasks: List[Task] = []
    for t in data.get("containers", {}).get("low_priority", {}).get("tasks", []):
        tasks.append(
            Task(
                task_id=str(t.get("task_id")),
                logistic_code=str(t.get("logistic_code")),
                lat=float(t.get("lat")),
                lng=float(t.get("lng")),
                cleaning_time=int(t.get("cleaning_time") or 60),
                is_premium=bool(t.get("premium", False)),
                apt_type=t.get("type_apt"),
                address=t.get("address"),
                alias=t.get("alias"),
                small_equipment=bool(t.get("small_equipment", False)),
                straordinaria=bool(t.get("straordinaria", False)),
            ))

    # Ordina: straordinarie first, poi premium
    tasks.sort(key=lambda x: (not x.straordinaria, not x.is_premium))
    return tasks


# -------- Planner --------
def plan_day(tasks: List[Task], cleaners: List[Cleaner]) -> Tuple[List[Cleaner], List[Task]]:
    """
    Assegna le task ai cleaner con regole semplificate:
    - Favorisce percorsi < 15'
    - Se non ci sono percorsi < 15', sceglie il minore dei > 15'
    - Max 3 task per cleaner per LP
    """
    unassigned = []

    for task in tasks:
        # Trova tutti i cleaner che possono prendere questa task
        candidates = []

        for cleaner in cleaners:
            result = find_best_position(cleaner, task)
            if result is not None:
                pos, travel = result
                candidates.append((cleaner, pos, travel))

        if not candidates:
            unassigned.append(task)
            continue

        # Dividi i candidati in due gruppi: < 15' e >= 15'
        preferred = [(c, p, t) for c, p, t in candidates if t < PREFERRED_TRAVEL]
        others = [(c, p, t) for c, p, t in candidates if t >= PREFERRED_TRAVEL]

        # Scegli dal gruppo preferito se esiste, altrimenti dal gruppo altri
        if preferred:
            # Scegli quello con minor viaggio tra i preferiti
            preferred.sort(key=lambda x: (len(x[0].route), x[2]))
            chosen = preferred[0]
        else:
            # Scegli quello con minor viaggio tra gli altri
            others.sort(key=lambda x: (len(x[0].route), x[2]))
            chosen = others[0]

        cleaner, pos, travel = chosen
        cleaner.route.insert(pos, task)

    return cleaners, unassigned


def build_output(cleaners: List[Cleaner], unassigned: List[Task], original_tasks: List[Task]) -> Dict[str, Any]:
    cleaners_with_tasks: List[Dict[str, Any]] = []

    for cl in cleaners:
        if not cl.route:
            continue

        feasible, schedule = evaluate_route(cl, cl.route)
        if not feasible or not schedule:
            continue

        tasks_list: List[Dict[str, Any]] = []

        for idx, (t, (arr, start, fin)) in enumerate(zip(cl.route, schedule)):
            overall_seq = cl.last_sequence + idx + 1

            # Calcola travel_time
            if overall_seq == 1:
                travel_time = 0
            elif idx == 0 and cl.last_sequence >= 1:
                # Primo LP dopo EO/HP
                if cl.last_lat is not None and cl.last_lng is not None:
                    hop = travel_minutes(cl.last_lat, cl.last_lng, t.lat, t.lng,
                                       cl.last_address, t.address)
                    travel_time = int(round(hop))
                else:
                    travel_time = 0 if same_street(cl.last_address, t.address) else 12
            else:
                # Hop da LP precedente
                prev = cl.route[idx - 1]
                hop = travel_minutes(prev.lat, prev.lng, t.lat, t.lng, prev.address, t.address)
                travel_time = int(round(hop))

            # Gestisci logistic_code che può essere None, 'None' stringa, o un numero
            logistic_code_val = 0
            if t.logistic_code and str(t.logistic_code).lower() != 'none':
                try:
                    logistic_code_val = int(t.logistic_code)
                except (ValueError, TypeError):
                    logistic_code_val = 0

            tasks_list.append({
                "task_id": int(t.task_id) if t.task_id else 0,
                "logistic_code": logistic_code_val,
                "address": t.address,
                "lat": t.lat,
                "lng": t.lng,
                "premium": t.is_premium,
                "cleaning_time": t.cleaning_time,
                "start_time": min_to_hhmm(start),
                "end_time": min_to_hhmm(fin),
                "followup": (overall_seq > 1),
                "sequence": overall_seq,
                "travel_time": travel_time
            })

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

    # Trova le task assegnate
    assigned_codes = set()
    for entry in cleaners_with_tasks:
        for t in entry.get("tasks", []):
            assigned_codes.add(int(t["logistic_code"]))

    # Unassigned list
    unassigned_list: List[Dict[str, Any]] = []
    for ot in original_tasks:
        lc = 0
        if ot.logistic_code and str(ot.logistic_code).lower() != 'none':
            try:
                lc = int(ot.logistic_code)
            except (ValueError, TypeError):
                lc = 0
        if lc not in assigned_codes:
            unassigned_list.append({
                "task_id": int(ot.task_id) if ot.task_id else 0,
                "logistic_code": lc,
                "reason": "no_eligible_cleaner_or_time_window"
            })

    total_assigned = sum(len(c["tasks"]) for c in cleaners_with_tasks)

    # Usa la data passata come argomento da riga di comando
    import sys
    if len(sys.argv) > 1:
        current_ref_date = sys.argv[1]
    else:
        from datetime import datetime
        current_ref_date = datetime.now().strftime("%Y-%m-%d")

    return {
        "low_priority_tasks_assigned": cleaners_with_tasks,
        "unassigned_tasks": unassigned_list,
        "current_date": current_ref_date,
        "meta": {
            "total_tasks": len(original_tasks),
            "assigned": total_assigned,
            "unassigned": len(original_tasks) - total_assigned,
            "cleaners_used": len(cleaners_with_tasks),
            "max_tasks_per_cleaner": MAX_TASKS_PER_CLEANER,
            "algorithm": "simplified_greedy",
            "notes": [
                "REGOLE LOW PRIORITY:",
                "1. Max 3 task per cleaner",
                "2. Favorisce percorsi < 15'",
                "3. Se non ci sono percorsi < 15', sceglie il minore dei > 15'",
                "4. Straordinarie solo a premium cleaner, devono essere la prima task",
                "5. Premium task solo a premium cleaner",
                "6. Vincolo orario: nessuna task deve finire dopo le 19:00",
                "7. Seed da EO e HP: disponibilità e posizione dall'ultima task assegnata",
                "8. Nessun vincolo particolare d'orario (flessibilità massima)"
            ]
        }
    }


def main():
    if not INPUT_TASKS.exists():
        raise SystemExit(f"Missing input file: {INPUT_TASKS}")
    if not INPUT_CLEANERS.exists():
        raise SystemExit(f"Missing input file: {INPUT_CLEANERS}")

    # Usa la data passata come argomento da riga di comando
    import sys
    if len(sys.argv) > 1:
        ref_date = sys.argv[1]
        print(f"📅 Usando data da argomento: {ref_date}")
    else:
        # Fallback: usa la data corrente
        from datetime import datetime
        ref_date = datetime.now().strftime("%Y-%m-%d")
        print(f"📅 Nessuna data specificata, usando: {ref_date}")

    cleaners = load_cleaners()
    seed_cleaners_from_assignments(cleaners)
    tasks = load_tasks()

    print(f"📋 Caricamento dati...")
    print(f"👥 Cleaner disponibili: {len(cleaners)}")
    print(f"📦 Task Low-Priority da assegnare: {len(tasks)}")
    print()
    print(f"🔄 Assegnazione in corso...")

    planners, leftovers = plan_day(tasks, cleaners)
    output = build_output(planners, leftovers, tasks)

    OUTPUT_ASSIGN.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_ASSIGN.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")

    print()
    print(f"✅ Assegnazione completata!")
    print(f"   - Task assegnati: {output['meta']['assigned']}/{output['meta']['total_tasks']}")
    print(f"   - Cleaner utilizzati: {output['meta']['cleaners_used']}")
    print(f"   - Task non assegnati: {output['meta']['unassigned']}")
    print()
    print(f"💾 Risultati salvati in: {OUTPUT_ASSIGN}")

    # Update timeline.json con struttura organizzata per cleaner
    timeline_path = OUTPUT_ASSIGN.parent / "timeline.json"

    # Carica timeline esistente o crea nuova struttura
    timeline_data = {
        "cleaners_assignments": [],
        "current_date": ref_date,
        "meta": {
            "total_cleaners": 0,
            "total_tasks": 0,
            "last_updated": datetime.now().isoformat()
        }
    }

    if timeline_path.exists():
        try:
            existing = json.loads(timeline_path.read_text(encoding="utf-8"))
            # Mantieni le assegnazioni esistenti non-LP
            if "cleaners_assignments" in existing:
                timeline_data["cleaners_assignments"] = [
                    c for c in existing.get("cleaners_assignments", [])
                    if c.get("assignment_type") != "low_priority"
                ]
        except:
            pass

    # Aggiungi le nuove assegnazioni LP organizzate per cleaner
    for cleaner_entry in output["low_priority_tasks_assigned"]:
        # Cerca se esiste già un'entry per questo cleaner
        existing_entry = None
        for entry in timeline_data["cleaners_assignments"]:
            if entry["cleaner"]["id"] == cleaner_entry["cleaner"]["id"]:
                existing_entry = entry
                break
        
        if existing_entry:
            # Aggiungi le task LP alle task esistenti
            existing_entry["tasks"].extend(cleaner_entry["tasks"])
        else:
            # Crea nuova entry
            timeline_data["cleaners_assignments"].append({
                "cleaner": cleaner_entry["cleaner"],
                "assignment_type": "low_priority",
                "tasks": cleaner_entry["tasks"]
            })

    # Aggiorna meta
    timeline_data["meta"]["total_cleaners"] = len(timeline_data["cleaners_assignments"])
    timeline_data["meta"]["total_tasks"] = sum(
        len(c.get("tasks", [])) for c in timeline_data["cleaners_assignments"]
    )
    timeline_data["meta"]["last_updated"] = datetime.now().isoformat()
    timeline_data["current_date"] = ref_date

    # Scrivi il file timeline.json
    timeline_path.write_text(json.dumps(timeline_data, ensure_ascii=False, indent=2), encoding="utf-8")
    
    lp_count = len([c for c in timeline_data["cleaners_assignments"] if c.get("assignment_type") == "low_priority"])
    print(f"✅ Aggiornato {timeline_path}")
    print(f"   - Cleaner con assegnazioni LP: {lp_count}")
    print(f"   - Totale task: {timeline_data['meta']['total_tasks']}")


if __name__ == "__main__":
    main()
