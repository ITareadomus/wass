
#!/usr/bin/env python3
import sys
import json
from datetime import datetime, timedelta

def parse_time(t_str):
    """HH:MM -> minutes from midnight"""
    if not t_str or not isinstance(t_str, str):
        return 0
    h, m = map(int, t_str.split(':'))
    return h * 60 + m

def format_time(minutes):
    """minutes from midnight -> HH:MM"""
    h = minutes // 60
    m = minutes % 60
    return f"{h:02d}:{m:02d}"

def remix_timeline(payload):
    """
    Remix timeline to insert leftover tasks
    Input:
      - day_start: "HH:MM"
      - assigned_by_cleaner: {cleanerId: [tasks]}
      - leftovers_by_cleaner: {cleanerId: [tasks]}
    Output:
      - timeline_by_cleaner: {cleanerId: [tasks with updated times]}
    """
    day_start = payload.get("day_start", "08:00")
    assigned = payload.get("assigned_by_cleaner", {})
    leftovers = payload.get("leftovers_by_cleaner", {})
    
    result = {}
    
    # Process each cleaner
    for cleaner_id in set(list(assigned.keys()) + list(leftovers.keys())):
        cleaner_tasks = assigned.get(cleaner_id, [])
        leftover_tasks = leftovers.get(cleaner_id, [])
        
        # Merge tasks
        all_tasks = cleaner_tasks + leftover_tasks
        
        # Sort by priority and time
        priority_order = {"early_out": 1, "high_priority": 2, "low_priority": 3}
        all_tasks.sort(key=lambda t: (
            priority_order.get(t.get("priority", "low_priority"), 99),
            t.get("checkout_time") or "23:59"
        ))
        
        # Recalculate times
        current_time = parse_time(day_start)
        
        for i, task in enumerate(all_tasks):
            cleaning_time = task.get("cleaning_time", 0)
            travel_time = task.get("travel_time", 0)
            
            # Start time
            task["start_time"] = format_time(current_time)
            
            # End time
            current_time += cleaning_time
            task["end_time"] = format_time(current_time)
            
            # Add travel to next task
            if i < len(all_tasks) - 1:
                current_time += travel_time
            
            task["sequence"] = i + 1
            task["followup"] = i > 0
        
        result[cleaner_id] = all_tasks
    
    return {"timeline_by_cleaner": result}

if __name__ == "__main__":
    try:
        # Read JSON from stdin
        payload = json.load(sys.stdin)
        result = remix_timeline(payload)
        print(json.dumps(result))
        sys.exit(0)
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
