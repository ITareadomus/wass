# -*- coding: utf-8 -*-
"""
Optimizer a 4 Fasi per Assegnazione Task

FASE 0: Pre-processing - Filtro task locked
FASE 1: Raggruppamento - Clustering geografico task vicini
FASE 2: Assegnazione - Matching gruppi a cleaner compatibili
FASE 3: Scheduling - Pianificazione cronologica con vincoli orari
FASE 4: Persistenza - Salvataggio risultati nello schema optimizer

Uso:
    python optimizer_phases.py --date 2025-12-30 --use-api
"""

from __future__ import annotations
import json
import math
import argparse
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple, Set
from pathlib import Path
from datetime import datetime, timedelta

try:
    from api_client import ApiClient, load_settings_from_api
    API_AVAILABLE = True
except ImportError:
    ApiClient = None
    load_settings_from_api = None
    API_AVAILABLE = False

from task_validation import TaskValidator
from assign_utils import (
    NEARBY_TRAVEL_THRESHOLD, NEW_CLEANER_PENALTY_MIN,
    TARGET_MIN_LOAD_MIN, FAIRNESS_DELTA_HOURS, LOAD_WEIGHT,
    cleaner_load_minutes, cleaner_load_hours
)

WORK_DATE: Optional[str] = None
RUN_ID: Optional[str] = None

CLUSTER_THRESHOLD_TIGHT = 15  # 15 min: soglia stretta per cluster
CLUSTER_THRESHOLD_EXTENDED = 20  # 20 min: soglia estesa

EO_START_MIN = 10 * 60  # 10:00
EO_END_MIN = 10 * 60 + 59  # 10:59
HP_START_MIN = 11 * 60  # 11:00
HP_END_MIN = 15 * 60 + 30  # 15:30
LP_START_MIN = 11 * 60  # 11:00

PENALTY_K_EO = 2
PENALTY_K_HP = 1
PENALTY_K_LP = 1
MAX_PENALTY_EO = 120
MAX_PENALTY_HP = 90
MAX_PENALTY_LP = 60


@dataclass
class Task:
    task_id: str
    logistic_code: str
    priority: str  # early_out, high_priority, low_priority
    lat: float
    lng: float
    cleaning_time: int
    checkout_time: Optional[int] = None
    checkin_time: Optional[int] = None
    checkout_dt: Optional[datetime] = None
    checkin_dt: Optional[datetime] = None
    is_premium: bool = False
    apt_type: Optional[str] = None
    address: Optional[str] = None
    alias: Optional[str] = None
    customer_name: Optional[str] = None
    customer_reference: Optional[str] = None
    client_id: Optional[int] = None
    small_equipment: bool = False
    straordinaria: bool = False
    locked: bool = False
    locked_reason: Optional[str] = None


@dataclass
class TaskGroup:
    group_id: str
    tasks: List[Task]
    logistic_codes: Set[str]
    center_lat: float
    center_lng: float
    total_cleaning_time: int
    priority: str  # priorità dominante del gruppo


@dataclass
class Cleaner:
    id: Any
    name: str
    lastname: str
    role: str
    can_do_straordinaria: bool = False
    home_lat: Optional[float] = None
    home_lng: Optional[float] = None
    start_time: str = "10:00"
    counter_hours: float = 0.0
    route: List[Task] = field(default_factory=list)
    available_from: Optional[int] = None  # minuti dalla mezzanotte


@dataclass
class Assignment:
    cleaner_id: int
    task_id: str
    sequence: int
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    travel_minutes: int = 0
    reasons: List[str] = field(default_factory=list)


@dataclass
class OptimizerDecision:
    phase: int
    event_type: str
    payload: Dict


decisions: List[OptimizerDecision] = []
assignments: List[Assignment] = []
unassigned: List[Dict] = []


def log_decision(phase: int, event_type: str, payload: Dict):
    decisions.append(OptimizerDecision(phase=phase, event_type=event_type, payload=payload))
    print(f"   [FASE {phase}] {event_type}: {json.dumps(payload, default=str, ensure_ascii=False)[:200]}")


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def estimate_travel_time(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    km = haversine_km(lat1, lng1, lat2, lng2)
    if km < 0.5:
        return max(3, km * 12)  # a piedi
    else:
        return max(5, 6 + km * 4.5)  # in bici/mezzi


def hhmm_to_min(hhmm: Optional[str], default: str = "10:00") -> int:
    if not hhmm or not isinstance(hhmm, str) or ":" not in hhmm:
        hhmm = default
    parts = hhmm.strip().split(":")
    return int(parts[0]) * 60 + int(parts[1])


def min_to_hhmm(m: float) -> str:
    m = int(round(m))
    return f"{m // 60:02d}:{m % 60:02d}"


def load_settings():
    global EO_START_MIN, EO_END_MIN, HP_START_MIN, HP_END_MIN
    if not API_AVAILABLE or load_settings_from_api is None:
        return
    try:
        settings = load_settings_from_api()
        eo_cfg = settings.get("early-out", {}) if settings else {}
        hp_cfg = settings.get("high-priority", {}) if settings else {}
        
        if eo_cfg.get("eo_start_time"):
            EO_START_MIN = hhmm_to_min(eo_cfg["eo_start_time"])
        if eo_cfg.get("eo_end_time"):
            EO_END_MIN = hhmm_to_min(eo_cfg["eo_end_time"])
        if hp_cfg.get("hp_start_time"):
            HP_START_MIN = hhmm_to_min(hp_cfg["hp_start_time"])
        if hp_cfg.get("hp_end_time"):
            HP_END_MIN = hhmm_to_min(hp_cfg["hp_end_time"])
            
        print(f"   ✅ Settings caricati: EO {min_to_hhmm(EO_START_MIN)}-{min_to_hhmm(EO_END_MIN)}, HP {min_to_hhmm(HP_START_MIN)}-{min_to_hhmm(HP_END_MIN)}")
    except Exception as e:
        print(f"   ⚠️ Errore caricamento settings: {e}")


def load_all_tasks() -> List[Task]:
    """
    Carica tutti i task dai containers (senza filtrare locked).
    Il filtro locked viene applicato in FASE 0.
    
    Returns:
        Lista di tutti i task
    """
    if not API_AVAILABLE or ApiClient is None:
        raise RuntimeError("API non disponibile")
    
    if not WORK_DATE:
        raise RuntimeError("WORK_DATE non impostata")
    
    client = ApiClient()
    data = client.get_containers(WORK_DATE)
    
    all_tasks: List[Task] = []
    containers = data.get("containers", {})
    
    priority_map = {
        "early_out": "early_out",
        "high_priority": "high_priority",
        "low_priority": "low_priority"
    }
    
    for container_key, priority in priority_map.items():
        container = containers.get(container_key, {})
        for t in container.get("tasks", []):
            task = Task(
                task_id=str(t.get("task_id")),
                logistic_code=str(t.get("logistic_code")),
                priority=priority,
                lat=float(t.get("lat", 0)),
                lng=float(t.get("lng", 0)),
                cleaning_time=int(t.get("cleaning_time") or 45),
                checkout_time=hhmm_to_min(t.get("checkout_time")) if t.get("checkout_time") else None,
                checkin_time=hhmm_to_min(t.get("checkin_time")) if t.get("checkin_time") else None,
                is_premium=bool(t.get("premium", False)),
                apt_type=t.get("type_apt"),
                address=t.get("address"),
                alias=t.get("alias"),
                customer_name=t.get("customer_name"),
                customer_reference=t.get("customer_reference"),
                client_id=t.get("client_id"),
                small_equipment=bool(t.get("small_equipment", False)),
                straordinaria=bool(t.get("straordinaria", False)),
                locked=bool(t.get("locked", False)),
                locked_reason=t.get("locked_reason")
            )
            all_tasks.append(task)
    
    return all_tasks


def load_cleaners() -> List[Cleaner]:
    if not API_AVAILABLE or ApiClient is None:
        raise RuntimeError("API non disponibile")
    
    if not WORK_DATE:
        raise RuntimeError("WORK_DATE non impostata")
    
    client = ApiClient()
    selected_response = client.get_selected_cleaners(WORK_DATE)
    all_cleaners_response = client.get_cleaners(WORK_DATE)
    
    selected_ids = set(selected_response.get("cleaner_ids", []) if isinstance(selected_response, dict) else [])
    cleaners: List[Cleaner] = []
    
    cleaners_list = all_cleaners_response.get("cleaners", []) if isinstance(all_cleaners_response, dict) else []
    for c in cleaners_list:
        if c.get("id") in selected_ids:
            cleaners.append(Cleaner(
                id=c.get("id"),
                name=c.get("name", ""),
                lastname=c.get("lastname", ""),
                role=c.get("role", "standard"),
                can_do_straordinaria=bool(c.get("can_do_straordinaria", False)),
                home_lat=float(c["home_lat"]) if c.get("home_lat") else None,
                home_lng=float(c["home_lng"]) if c.get("home_lng") else None,
                start_time=c.get("start_time", "10:00"),
                counter_hours=float(c.get("counter_hours", 0))
            ))
    
    return cleaners


def phase_0_filter_locked(all_tasks: List[Task]) -> Tuple[List[Task], List[Task]]:
    """
    FASE 0: Pre-processing - Filtra task locked
    
    Returns:
        Tuple di (unlocked_tasks, locked_tasks)
    """
    unlocked = [t for t in all_tasks if not t.locked]
    locked = [t for t in all_tasks if t.locked]
    
    log_decision(0, "LOCKED_FILTER", {
        "total_tasks": len(all_tasks),
        "unlocked_count": len(unlocked),
        "locked_count": len(locked),
        "locked_task_ids": [t.task_id for t in locked]
    })
    
    for t in locked:
        unassigned.append({
            "task_id": t.task_id,
            "reason_code": "LOCKED",
            "details": {"locked_reason": t.locked_reason, "priority": t.priority}
        })
    
    return unlocked, locked


def phase_1_clustering(tasks: List[Task]) -> List[TaskGroup]:
    """
    FASE 1: Raggruppamento - Clustering geografico task vicini
    
    Usa soglie duali:
    - 15 min: soglia stretta per clustering prioritario
    - 20 min: soglia estesa per task isolati
    
    Returns:
        Lista di TaskGroup
    """
    if not tasks:
        return []
    
    used = set()
    groups: List[TaskGroup] = []
    
    tasks_by_priority = {"early_out": [], "high_priority": [], "low_priority": []}
    for t in tasks:
        tasks_by_priority[t.priority].append(t)
    
    for priority in ["early_out", "high_priority", "low_priority"]:
        priority_tasks = tasks_by_priority[priority]
        
        for task in priority_tasks:
            if task.task_id in used:
                continue
            
            cluster = [task]
            used.add(task.task_id)
            
            for other in priority_tasks:
                if other.task_id in used:
                    continue
                
                travel = estimate_travel_time(task.lat, task.lng, other.lat, other.lng)
                
                if travel <= CLUSTER_THRESHOLD_TIGHT:
                    cluster.append(other)
                    used.add(other.task_id)
            
            if len(cluster) == 1:
                for other in priority_tasks:
                    if other.task_id in used:
                        continue
                    travel = estimate_travel_time(task.lat, task.lng, other.lat, other.lng)
                    if travel <= CLUSTER_THRESHOLD_EXTENDED:
                        cluster.append(other)
                        used.add(other.task_id)
            
            center_lat = sum(t.lat for t in cluster) / len(cluster)
            center_lng = sum(t.lng for t in cluster) / len(cluster)
            total_time = sum(t.cleaning_time for t in cluster)
            logistic_codes = {t.logistic_code for t in cluster}
            
            group = TaskGroup(
                group_id=str(uuid.uuid4())[:8],
                tasks=cluster,
                logistic_codes=logistic_codes,
                center_lat=center_lat,
                center_lng=center_lng,
                total_cleaning_time=total_time,
                priority=priority
            )
            groups.append(group)
            
            log_decision(1, "GROUP_CREATED", {
                "group_id": group.group_id,
                "priority": priority,
                "task_count": len(cluster),
                "task_ids": [t.task_id for t in cluster],
                "logistic_codes": list(logistic_codes),
                "total_cleaning_time": total_time
            })
    
    print(f"   ✅ FASE 1: {len(groups)} gruppi creati da {len(tasks)} task")
    return groups


def phase_2_assign_groups(groups: List[TaskGroup], cleaners: List[Cleaner], 
                          assigned_logistic_codes: Optional[Set[str]] = None) -> Dict[int, List[TaskGroup]]:
    """
    FASE 2: Assegnazione - Matching gruppi a cleaner compatibili
    
    Scoring basato su:
    - Travel time dalla posizione corrente
    - Carico di lavoro (bilanciamento)
    - Preferenze ruolo
    
    Returns:
        Dict cleaner_id -> list of TaskGroup
    """
    if assigned_logistic_codes is None:
        assigned_logistic_codes = set()
    
    validator = TaskValidator()
    cleaner_groups: Dict[int, List[TaskGroup]] = {c.id: [] for c in cleaners}
    
    for priority in ["early_out", "high_priority", "low_priority"]:
        priority_groups = [g for g in groups if g.priority == priority]
        
        for group in priority_groups:
            if group.logistic_codes & assigned_logistic_codes:
                log_decision(2, "GROUP_SKIPPED_DUPLICATE", {
                    "group_id": group.group_id,
                    "reason": "logistic_code già assegnato"
                })
                continue
            
            best_cleaner = None
            best_score = float('inf')
            
            for cleaner in cleaners:
                if not validator.can_cleaner_handle_priority(cleaner.role, priority):
                    continue
                
                can_handle_all = True
                for task in group.tasks:
                    if not validator.can_cleaner_handle_task(
                        cleaner.role, task.is_premium, task.straordinaria, cleaner.can_do_straordinaria
                    ):
                        can_handle_all = False
                        break
                
                if can_handle_all:
                    if cleaner.home_lat and cleaner.home_lng:
                        travel = estimate_travel_time(
                            cleaner.home_lat, cleaner.home_lng,
                            group.center_lat, group.center_lng
                        )
                    else:
                        travel = 20
                    
                    load = cleaner_load_hours(cleaner) + (group.total_cleaning_time / 60)
                    
                    score = travel + (load * LOAD_WEIGHT)
                    
                    if "formatore" in cleaner.role.lower():
                        score -= 10
                    
                    if score < best_score:
                        best_score = score
                        best_cleaner = cleaner
            
            if best_cleaner:
                cleaner_groups[best_cleaner.id].append(group)
                assigned_logistic_codes.update(group.logistic_codes)
                
                for task in group.tasks:
                    best_cleaner.route.append(task)
                
                log_decision(2, "GROUP_ASSIGNED", {
                    "group_id": group.group_id,
                    "cleaner_id": best_cleaner.id,
                    "cleaner_name": f"{best_cleaner.name} {best_cleaner.lastname}",
                    "score": round(best_score, 2),
                    "task_ids": [t.task_id for t in group.tasks]
                })
            else:
                for task in group.tasks:
                    unassigned.append({
                        "task_id": task.task_id,
                        "reason_code": "NO_COMPATIBLE_CLEANER",
                        "details": {"priority": priority, "group_id": group.group_id}
                    })
                
                log_decision(2, "GROUP_UNASSIGNED", {
                    "group_id": group.group_id,
                    "reason": "Nessun cleaner compatibile"
                })
    
    assigned_count = sum(len(gs) for gs in cleaner_groups.values())
    print(f"   ✅ FASE 2: {assigned_count} gruppi assegnati a {len([c for c in cleaners if cleaner_groups[c.id]])} cleaner")
    return cleaner_groups


def calculate_priority_penalty(start_min: int, priority: str) -> Tuple[float, Optional[str]]:
    """
    Calcola penalità basata sulla distanza dalla finestra oraria preferita.
    
    Returns:
        Tuple (penalty, violation_reason)
    """
    violation_reason = None
    
    if priority == "early_out":
        if EO_START_MIN <= start_min <= EO_END_MIN:
            return 0, None
        distance = min(abs(start_min - EO_START_MIN), abs(start_min - EO_END_MIN))
        penalty = min(distance * PENALTY_K_EO, MAX_PENALTY_EO)
        if start_min < EO_START_MIN or start_min > EO_END_MIN:
            violation_reason = "EO_OUT_OF_PREFERRED_START_WINDOW"
        return penalty, violation_reason
    
    elif priority == "high_priority":
        if HP_START_MIN <= start_min <= HP_END_MIN:
            return 0, None
        distance = min(abs(start_min - HP_START_MIN), abs(start_min - HP_END_MIN))
        penalty = min(distance * PENALTY_K_HP, MAX_PENALTY_HP)
        if start_min < HP_START_MIN or start_min > HP_END_MIN:
            violation_reason = "HP_OUT_OF_PREFERRED_START_WINDOW"
        return penalty, violation_reason
    
    else:  # low_priority
        if start_min >= LP_START_MIN:
            return 0, None
        distance = LP_START_MIN - start_min
        penalty = min(distance * PENALTY_K_LP, MAX_PENALTY_LP)
        violation_reason = "LP_BEFORE_MIN_START"
        return penalty, violation_reason


def phase_3_scheduling(cleaner_groups: Dict[int, List[TaskGroup]], 
                       cleaners: List[Cleaner]) -> List[Assignment]:
    """
    FASE 3: Scheduling - Pianificazione cronologica con vincoli orari
    
    Per ogni cleaner:
    1. Ordina task per priorità e checkout time
    2. Calcola start/end time sequenziali
    3. Applica penalità per violazioni finestra oraria
    
    Returns:
        Lista di Assignment
    """
    global assignments
    assignments = []
    
    ref_date = datetime.strptime(WORK_DATE, "%Y-%m-%d")
    
    for cleaner in cleaners:
        groups = cleaner_groups.get(cleaner.id, [])
        if not groups:
            continue
        
        all_tasks = []
        for g in groups:
            all_tasks.extend(g.tasks)
        
        priority_order = {"early_out": 0, "high_priority": 1, "low_priority": 2}
        all_tasks.sort(key=lambda t: (
            priority_order.get(t.priority, 2),
            t.checkout_time or 0
        ))
        
        start_time_min = hhmm_to_min(cleaner.start_time)
        current_time = start_time_min
        last_lat, last_lng = cleaner.home_lat, cleaner.home_lng
        
        for seq, task in enumerate(all_tasks, 1):
            if last_lat and last_lng:
                travel = estimate_travel_time(last_lat, last_lng, task.lat, task.lng)
            else:
                travel = 10
            
            task_start = current_time + travel
            task_end = task_start + task.cleaning_time
            
            penalty, violation = calculate_priority_penalty(task_start, task.priority)
            
            reasons = []
            if violation:
                reasons.append(violation)
            
            start_dt = ref_date + timedelta(minutes=task_start)
            end_dt = ref_date + timedelta(minutes=task_end)
            
            assignment = Assignment(
                cleaner_id=cleaner.id,
                task_id=task.task_id,
                sequence=seq,
                start_time=start_dt,
                end_time=end_dt,
                travel_minutes=int(travel),
                reasons=reasons
            )
            assignments.append(assignment)
            
            log_decision(3, "TASK_SCHEDULED", {
                "cleaner_id": cleaner.id,
                "task_id": task.task_id,
                "sequence": seq,
                "start": min_to_hhmm(task_start),
                "end": min_to_hhmm(task_end),
                "travel_min": int(travel),
                "penalty": penalty,
                "violation": violation
            })
            
            current_time = task_end
            last_lat, last_lng = task.lat, task.lng
    
    print(f"   ✅ FASE 3: {len(assignments)} task schedulati")
    return assignments


def phase_4_persist(dry_run: bool = True):
    """
    FASE 4: Persistenza - Salvataggio risultati nello schema optimizer
    
    In shadow mode (dry_run=True) salva su file JSON locale per verifica.
    In production mode salva su database optimizer.
    """
    global RUN_ID
    
    summary = {
        "total_tasks": len(assignments) + len(unassigned),
        "assigned": len(assignments),
        "unassigned": len(unassigned),
        "locked_count": len([u for u in unassigned if u.get("reason_code") == "LOCKED"]),
        "cleaners_used": len(set(a.cleaner_id for a in assignments))
    }
    
    payload = {
        "run_id": RUN_ID,
        "work_date": WORK_DATE,
        "algorithm_version": "phases_v1",
        "params": {
            "cluster_tight": CLUSTER_THRESHOLD_TIGHT,
            "cluster_extended": CLUSTER_THRESHOLD_EXTENDED
        },
        "status": "success" if summary["unassigned"] == 0 else "partial",
        "summary": summary,
        "decisions": [
            {"phase": d.phase, "event_type": d.event_type, "payload": d.payload}
            for d in decisions
        ],
        "assignments": [
            {
                "cleaner_id": a.cleaner_id,
                "task_id": a.task_id,
                "sequence": a.sequence,
                "start_time": a.start_time.isoformat() if a.start_time else None,
                "end_time": a.end_time.isoformat() if a.end_time else None,
                "travel_minutes": a.travel_minutes,
                "reasons": a.reasons
            }
            for a in assignments
        ],
        "unassigned": unassigned
    }
    
    log_decision(4, "RUN_COMPLETE", {
        "run_id": RUN_ID,
        "summary": summary,
        "dry_run": dry_run
    })
    
    if dry_run:
        output_dir = Path(__file__).parent.parent / "data" / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        output_file = output_dir / f"optimizer_run_{WORK_DATE}_{RUN_ID[:8]}.json"
        
        try:
            with open(output_file, "w", encoding="utf-8") as f:
                json.dump(payload, f, indent=2, ensure_ascii=False, default=str)
            print(f"   ℹ️ SHADOW MODE: Risultati salvati in {output_file}")
            print(f"   📁 File: {output_file.name}")
        except Exception as e:
            print(f"   ⚠️ Errore salvataggio file locale: {e}")
    else:
        print(f"   📤 Salvataggio risultati optimizer su database...")
        print(f"   ⚠️ API endpoint /api/optimizer/results non ancora implementato")
    
    print(f"\n📊 RIEPILOGO:")
    print(f"   - Task totali: {summary['total_tasks']}")
    print(f"   - Assegnati: {summary['assigned']}")
    print(f"   - Non assegnati: {summary['unassigned']}")
    print(f"   - Bloccati: {summary['locked_count']}")
    print(f"   - Cleaner utilizzati: {summary['cleaners_used']}")
    
    return summary


def run_optimizer(work_date: str, dry_run: bool = True):
    """
    Esegue l'optimizer completo a 4 fasi.
    """
    global WORK_DATE, RUN_ID, decisions, assignments, unassigned
    
    if not work_date:
        raise ValueError("work_date è obbligatorio")
    
    WORK_DATE = work_date
    RUN_ID = str(uuid.uuid4())
    decisions = []
    assignments = []
    unassigned = []
    
    print(f"\n🚀 OPTIMIZER FASI - Data: {work_date}")
    print(f"   Run ID: {RUN_ID}")
    print(f"   Mode: {'SHADOW (dry-run)' if dry_run else 'PRODUZIONE'}")
    print("=" * 60)
    
    load_settings()
    
    print("\n📥 Caricamento dati...")
    all_tasks = load_all_tasks()
    locked_count = len([t for t in all_tasks if t.locked])
    unlocked_count = len([t for t in all_tasks if not t.locked])
    print(f"   Task totali: {len(all_tasks)}")
    print(f"   🔓 Sbloccati: {unlocked_count}")
    print(f"   🔒 Bloccati: {locked_count}")
    
    cleaners = load_cleaners()
    print(f"   Cleaner selezionati: {len(cleaners)}")
    
    print("\n" + "=" * 60)
    print("⚙️ FASE 0: Pre-processing (filtro locked)")
    print("-" * 60)
    unlocked, locked = phase_0_filter_locked(all_tasks)
    
    print("\n" + "=" * 60)
    print("⚙️ FASE 1: Raggruppamento geografico")
    print("-" * 60)
    groups = phase_1_clustering(unlocked)
    
    print("\n" + "=" * 60)
    print("⚙️ FASE 2: Assegnazione gruppi a cleaner")
    print("-" * 60)
    cleaner_groups = phase_2_assign_groups(groups, cleaners)
    
    print("\n" + "=" * 60)
    print("⚙️ FASE 3: Scheduling cronologico")
    print("-" * 60)
    phase_3_scheduling(cleaner_groups, cleaners)
    
    print("\n" + "=" * 60)
    print("⚙️ FASE 4: Persistenza risultati")
    print("-" * 60)
    summary = phase_4_persist(dry_run=dry_run)
    
    print("\n" + "=" * 60)
    print("✅ OPTIMIZER COMPLETATO")
    print("=" * 60)
    
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Optimizer a 4 fasi per assegnazione task")
    parser.add_argument("--date", required=True, help="Data di lavoro (YYYY-MM-DD)")
    parser.add_argument("--use-api", action="store_true", help="Usa API per leggere/scrivere dati")
    parser.add_argument("--execute", action="store_true", help="Esegui in modalità produzione (non shadow)")
    
    args = parser.parse_args()
    
    if args.use_api and not API_AVAILABLE:
        print("❌ API non disponibile ma --use-api specificato")
        exit(1)
    
    run_optimizer(args.date, dry_run=not args.execute)
