
# -*- coding: utf-8 -*-
"""
Assegna task HIGH-PRIORITY ai cleaners già assegnati in early-out.

Logica:
- Carica i cleaner da early_out_assignments.json
- Carica le task da high_priority.json con checkin_time tra 10:00 e 15:30
- Se checkout_time è null, usa 11:00 come default
- Assegna una task HP a ciascun cleaner (basandosi su premium match e disponibilità)
- Genera combined_assignments.json con entrambe le assegnazioni
"""
from __future__ import annotations
from pathlib import Path
from typing import List, Dict, Any, Optional
from datetime import datetime, timedelta
import json

def parse_time_str(t: Optional[str]) -> Optional[datetime]:
    if not t:
        return None
    return datetime.strptime(t, "%H:%M")

def fmt_time(dt: Optional[datetime]) -> Optional[str]:
    return dt.strftime("%H:%M") if dt is not None else None

def load_early_out_assignments(path: Path) -> List[Dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)

def load_high_priority_tasks(path: Path) -> List[Dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    
    tasks = data.get("high_priority_tasks", [])
    
    # Filtra task con checkin_time tra 10:00 e 15:30
    eo_time = parse_time_str("10:00")
    hp_time = parse_time_str("15:30")
    
    filtered_tasks = []
    for task in tasks:
        checkin_time_str = task.get("checkin_time")
        if checkin_time_str:
            checkin_time = parse_time_str(checkin_time_str)
            if checkin_time and eo_time <= checkin_time <= hp_time:
                # Se checkout_time è null, imposta a 11:00
                if task.get("checkout_time") is None:
                    task["checkout_time"] = "11:00"
                filtered_tasks.append(task)
    
    return filtered_tasks

def assign_hp_tasks(eo_assignments: List[Dict[str, Any]], hp_tasks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    # Raggruppa i cleaner da early-out
    cleaners_map = {}
    for eo_task in eo_assignments:
        cleaner_id = eo_task.get("assigned_cleaner_id")
        if cleaner_id and cleaner_id not in cleaners_map:
            cleaners_map[cleaner_id] = {
                "cleaner_id": cleaner_id,
                "cleaner_name": eo_task.get("assigned_cleaner_name"),
                "cleaner_role": eo_task.get("assigned_cleaner_role"),
                "early_out_task": eo_task,
                "end_time_eo": parse_time_str(eo_task.get("end_time")),
                "high_priority_task": None
            }
    
    # Ordina le task HP per checkin_time
    hp_tasks_sorted = sorted(hp_tasks, key=lambda x: (
        0 if x.get("premium") else 1,
        parse_time_str(x.get("checkin_time")) or datetime.max
    ))
    
    # Assegna task HP ai cleaner
    for task in hp_tasks_sorted:
        task_premium = task.get("premium", False)
        task_checkout = parse_time_str(task.get("checkout_time"))
        task_cleaning_minutes = int(task.get("cleaning_time", 0))
        
        # Trova il cleaner più adatto
        best_cleaner = None
        for cleaner_id, cleaner_data in cleaners_map.items():
            # Se già ha una task HP, salta
            if cleaner_data["high_priority_task"] is not None:
                continue
            
            # Verifica compatibilità premium
            cleaner_role = cleaner_data["cleaner_role"]
            if task_premium and cleaner_role != "Premium":
                continue
            
            # Verifica disponibilità temporale
            eo_end = cleaner_data["end_time_eo"]
            if eo_end and task_checkout:
                # Il cleaner deve finire l'EO prima del checkout della HP
                if eo_end <= task_checkout:
                    if best_cleaner is None or eo_end < cleaners_map[best_cleaner]["end_time_eo"]:
                        best_cleaner = cleaner_id
        
        # Assegna la task al cleaner migliore
        if best_cleaner:
            cleaner_data = cleaners_map[best_cleaner]
            start_time = max(cleaner_data["end_time_eo"], task_checkout) if cleaner_data["end_time_eo"] and task_checkout else (cleaner_data["end_time_eo"] or task_checkout)
            end_time = start_time + timedelta(minutes=task_cleaning_minutes) if start_time else None
            
            cleaner_data["high_priority_task"] = {
                **task,
                "hp_start_time": fmt_time(start_time),
                "hp_end_time": fmt_time(end_time)
            }
    
    return list(cleaners_map.values())

def save_json(obj: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)

def main() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    
    eo_path = repo_root / "data" / "output" / "early_out_assignments.json"
    hp_path = repo_root / "data" / "output" / "high_priority.json"
    output_path = repo_root / "data" / "output" / "combined_assignments.json"
    
    # Carica dati
    eo_assignments = load_early_out_assignments(eo_path)
    hp_tasks = load_high_priority_tasks(hp_path)
    
    # Assegna task HP
    combined = assign_hp_tasks(eo_assignments, hp_tasks)
    
    # Salva risultati
    output = {
        "assignments": combined,
        "total_cleaners": len(combined),
        "total_hp_assigned": sum(1 for c in combined if c["high_priority_task"] is not None)
    }
    
    save_json(output, output_path)
    print(f"[OK] Wrote combined assignments -> {output_path}")
    print(f"Cleaners con task HP assegnate: {output['total_hp_assigned']}/{output['total_cleaners']}")

if __name__ == "__main__":
    main()
