
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
assign_eo.py
Assegna i task Early-Out ai cleaner disponibili usando un algoritmo greedy ottimizzato.
"""

import json
from pathlib import Path
from dataclasses import dataclass
from typing import List, Optional, Dict, Any
from datetime import datetime, time, timedelta
import math

# =============================
# CONFIGURAZIONE PATHS
# =============================
BASE_DIR = Path(__file__).parent.parent
INPUT_CLEANERS = BASE_DIR / "data/cleaners/selected_cleaners.json"
INPUT_TASKS = BASE_DIR / "data/output/early_out.json"
OUTPUT_ASSIGNMENTS = BASE_DIR / "data/output/early_out_assignments.json"

# =============================
# COSTANTI
# =============================
DEFAULT_START_TIME = "10:00"
MAX_TRAVEL_MINUTES = 22
PREFERRED_TRAVEL_MINUTES = 15

# =============================
# DATA CLASSES
# =============================
@dataclass
class Cleaner:
    id: int
    name: str
    lastname: str
    role: str
    premium: bool
    home_lat: float = 45.4642
    home_lng: float = 9.1900

@dataclass
class Task:
    task_id: int
    logistic_code: int
    address: str
    lat: float
    lng: float
    premium: bool
    cleaning_time: int
    checkout_time: Optional[str]
    checkin_time: Optional[str]
    is_straordinaria: bool
    client_id: int

@dataclass
class Assignment:
    task: Task
    start_time: str
    end_time: str
    travel_time: int
    sequence: int

# =============================
# FUNZIONI DI UTILITÀ
# =============================
def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Calcola la distanza in km tra due coordinate usando la formula di Haversine."""
    R = 6371.0
    lat1_rad = math.radians(lat1)
    lat2_rad = math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(dlng / 2) ** 2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    
    return R * c

def travel_time_minutes(lat1: float, lng1: float, lat2: float, lng2: float) -> int:
    """Calcola il tempo di viaggio in minuti assumendo 25 km/h."""
    km = haversine_km(lat1, lng1, lat2, lng2)
    return int(round((km / 25.0) * 60.0))

def time_to_minutes(time_str: str) -> int:
    """Converte HH:MM in minuti dal midnight."""
    h, m = map(int, time_str.split(':'))
    return h * 60 + m

def minutes_to_time(minutes: int) -> str:
    """Converte minuti dal midnight in HH:MM."""
    h = minutes // 60
    m = minutes % 60
    return f"{h:02d}:{m:02d}"

# =============================
# CARICAMENTO DATI
# =============================
def load_cleaners() -> List[Cleaner]:
    raw = json.loads(INPUT_CLEANERS.read_text(encoding="utf-8"))
    # Il file selected_cleaners.json ha la struttura: {"cleaners": [...], "total_selected": N}
    cleaners_list = raw.get("cleaners", raw) if isinstance(raw, dict) else raw
    cleaners: List[Cleaner] = []
    for c in cleaners_list:
        cleaners.append(Cleaner(
            id=c.get("id"),
            name=c.get("name", ""),
            lastname=c.get("lastname", ""),
            role=c.get("role", "Standard"),
            premium=(c.get("role") == "Premium"),
            home_lat=45.4642,  # Default Milano centro
            home_lng=9.1900
        ))
    return cleaners

def load_tasks() -> List[Task]:
    raw = json.loads(INPUT_TASKS.read_text(encoding="utf-8"))
    # Il file early_out.json ha la struttura: {"early_out_tasks": [...], "total_apartments": N}
    tasks_list = raw.get("early_out_tasks", raw) if isinstance(raw, dict) else raw
    tasks: List[Task] = []
    for t in tasks_list:
        tasks.append(Task(
            task_id=t.get("task_id"),
            logistic_code=t.get("logistic_code"),
            address=t.get("address", ""),
            lat=float(t.get("lat", 45.4642)),
            lng=float(t.get("lng", 9.1900)),
            premium=bool(t.get("premium", False)),
            cleaning_time=int(t.get("cleaning_time", 60)),
            checkout_time=t.get("checkout_time"),
            checkin_time=t.get("checkin_time"),
            is_straordinaria=bool(t.get("is_straordinaria", False)),
            client_id=int(t.get("client_id", 0))
        ))
    return tasks

# =============================
# LOGICA DI ASSEGNAZIONE
# =============================
def can_assign_task(cleaner: Cleaner, task: Task) -> bool:
    """Verifica se un cleaner può essere assegnato a un task."""
    # Premium e straordinarie solo a Premium
    if (task.premium or task.is_straordinaria) and not cleaner.premium:
        return False
    return True

def assign_early_out_tasks(cleaners: List[Cleaner], tasks: List[Task]) -> Dict[str, Any]:
    """Assegna i task early-out ai cleaner disponibili."""
    
    # Dizionario per tenere traccia delle assegnazioni per cleaner
    cleaner_assignments: Dict[int, List[Assignment]] = {c.id: [] for c in cleaners}
    cleaner_lookup = {c.id: c for c in cleaners}
    
    # Lista dei task non assegnati
    unassigned = []
    
    # Ordina i task per checkout_time (prima i più urgenti)
    sorted_tasks = sorted(tasks, key=lambda t: t.checkout_time or "23:59")
    
    for task in sorted_tasks:
        best_cleaner_id = None
        best_travel = float('inf')
        
        for cleaner in cleaners:
            # Verifica se il cleaner può fare questo task
            if not can_assign_task(cleaner, task):
                continue
            
            # Massimo 3 task per cleaner
            if len(cleaner_assignments[cleaner.id]) >= 3:
                continue
            
            # Calcola la posizione attuale del cleaner
            assignments = cleaner_assignments[cleaner.id]
            if assignments:
                # Ultima task assegnata
                last_task = assignments[-1].task
                current_lat = last_task.lat
                current_lng = last_task.lng
            else:
                # Home del cleaner
                current_lat = cleaner.home_lat
                current_lng = cleaner.home_lng
            
            # Calcola tempo di viaggio
            travel = travel_time_minutes(current_lat, current_lng, task.lat, task.lng)
            
            # Se ha già 2 task, deve essere vicino (max 10 minuti)
            if len(assignments) == 2 and travel > 10:
                continue
            
            # Hard cap: max 22 minuti
            if travel > MAX_TRAVEL_MINUTES:
                continue
            
            # Preferisci cleaner con travel < 15 minuti
            if travel < best_travel:
                best_travel = travel
                best_cleaner_id = cleaner.id
        
        # Assegna al miglior cleaner trovato
        if best_cleaner_id is not None:
            cleaner = cleaner_lookup[best_cleaner_id]
            assignments = cleaner_assignments[best_cleaner_id]
            
            # Calcola gli orari
            if assignments:
                # Parti dalla fine dell'ultima task + travel time
                last_assignment = assignments[-1]
                start_minutes = time_to_minutes(last_assignment.end_time) + best_travel
            else:
                # Prima task: parti da 10:00 + travel dalla home
                start_minutes = time_to_minutes(DEFAULT_START_TIME) + best_travel
            
            end_minutes = start_minutes + task.cleaning_time
            
            assignment = Assignment(
                task=task,
                start_time=minutes_to_time(start_minutes),
                end_time=minutes_to_time(end_minutes),
                travel_time=best_travel,
                sequence=len(assignments) + 1
            )
            
            cleaner_assignments[best_cleaner_id].append(assignment)
        else:
            # Nessun cleaner disponibile
            unassigned.append({
                "task_id": task.task_id,
                "logistic_code": task.logistic_code,
                "reason": "no_eligible_cleaner_or_time_window"
            })
    
    # Prepara l'output
    early_out_tasks_assigned = []
    for cleaner_id, assignments in cleaner_assignments.items():
        if assignments:  # Solo cleaner con task assegnate
            cleaner = cleaner_lookup[cleaner_id]
            tasks_output = []
            for assignment in assignments:
                tasks_output.append({
                    "task_id": assignment.task.task_id,
                    "logistic_code": assignment.task.logistic_code,
                    "address": assignment.task.address,
                    "lat": assignment.task.lat,
                    "lng": assignment.task.lng,
                    "premium": assignment.task.premium,
                    "cleaning_time": assignment.task.cleaning_time,
                    "start_time": assignment.start_time,
                    "end_time": assignment.end_time,
                    "followup": assignment.sequence > 1,
                    "sequence": assignment.sequence,
                    "travel_time": assignment.travel_time
                })
            
            early_out_tasks_assigned.append({
                "cleaner": {
                    "id": cleaner.id,
                    "name": cleaner.name,
                    "lastname": cleaner.lastname,
                    "role": cleaner.role,
                    "premium": cleaner.premium
                },
                "tasks": tasks_output
            })
    
    # Conta le statistiche
    total_tasks = len(tasks)
    assigned_count = sum(len(assignments) for assignments in cleaner_assignments.values())
    
    return {
        "early_out_tasks_assigned": early_out_tasks_assigned,
        "unassigned_tasks": unassigned,
        "meta": {
            "total_tasks": total_tasks,
            "assigned": assigned_count,
            "unassigned": len(unassigned),
            "cleaners_used": len([a for a in cleaner_assignments.values() if a]),
            "max_tasks_per_cleaner": max((len(a) for a in cleaner_assignments.values()), default=0),
            "algorithm": "greedy + travel-time optimization",
            "notes": [
                "Start alle 10:00 + travel dalla home",
                "Primo hop calcolato con haversine",
                "Premium/straordinarie solo a Premium",
                "Hard cap viaggi: 22'",
                "Se 2 task già assegnate, max 10' per la terza"
            ]
        }
    }

# =============================
# MAIN
# =============================
def main():
    print("📋 Caricamento dati...")
    cleaners = load_cleaners()
    tasks = load_tasks()
    
    print(f"👥 Cleaner disponibili: {len(cleaners)}")
    print(f"📦 Task Early-Out da assegnare: {len(tasks)}")
    
    print("\n🔄 Assegnazione in corso...")
    result = assign_early_out_tasks(cleaners, tasks)
    
    # Salva il risultato
    OUTPUT_ASSIGNMENTS.write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    
    print(f"\n✅ Assegnazione completata!")
    print(f"   - Task assegnati: {result['meta']['assigned']}/{result['meta']['total_tasks']}")
    print(f"   - Cleaner utilizzati: {result['meta']['cleaners_used']}")
    print(f"   - Task non assegnati: {result['meta']['unassigned']}")
    print(f"\n💾 Risultati salvati in: {OUTPUT_ASSIGNMENTS}")

if __name__ == "__main__":
    main()
