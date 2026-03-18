#!/usr/bin/env python3
"""
Phase 4 repair batch: assign unassigned tasks to cleaners (append only) using OR-Tools CP-SAT.
Reads JSON from stdin, writes JSON to stdout.
Used as local repair solver: receives pre-computed allowed (task, cleaner) pairs from Node;
enforces load and task-count constraints; maximizes tasks assigned, then minimizes travel.
"""

import json
import sys
from collections import defaultdict

try:
    from ortools.sat.python import cp_model
except ImportError:
    print(json.dumps({"status": "error", "message": "ortools not installed (pip install ortools)"}), flush=True)
    sys.exit(1)

SCALE = 10


def main():
    try:
        import io
        stdin_text = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8-sig')
        data = json.load(stdin_text)
    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}), flush=True)
        sys.exit(1)

    task_ids = data.get("taskIds") or []
    tasks_list = data.get("tasks") or []
    cleaner_ids = data.get("cleanerIds") or []
    cleaners_list = data.get("cleaners") or []
    allowed = data.get("allowed") or []
    w_t = float(data.get("wT", 1.0))

    task_id_to_index = {tid: i for i, tid in enumerate(task_ids)}
    cleaner_id_to_index = {cid: i for i, cid in enumerate(cleaner_ids)}
    tasks_by_id = {t["taskId"]: t for t in tasks_list}
    n_tasks = len(task_ids)
    n_cleaners = len(cleaner_ids)

    if n_cleaners == 0 or n_tasks == 0 or len(allowed) == 0:
        out = {
            "status": "ok",
            "assignments": [],
        }
        print(json.dumps(out), flush=True)
        return

    # Build allowed index pairs and load contribution per (t, c)
    # loadContribution = cleaningTime + wT * deltaTravel (in minutes, then scale)
    allowed_pairs = []  # (t_idx, c_idx, delta_travel_scaled, load_contribution_scaled)
    for a in allowed:
        tid = a.get("taskId")
        cid = a.get("cleanerId")
        if tid not in task_id_to_index or cid not in cleaner_id_to_index:
            continue
        t_idx = task_id_to_index[tid]
        c_idx = cleaner_id_to_index[cid]
        task = tasks_by_id.get(tid)
        cleaning_min = int(task.get("cleaningTimeMinutes", 60)) if task else 60
        delta_travel = float(a.get("deltaTravel", 0))
        load_contribution = cleaning_min + w_t * delta_travel
        allowed_pairs.append((t_idx, c_idx, int(delta_travel * SCALE), int(load_contribution * SCALE)))

    model = cp_model.CpModel()

    # x[(t_idx, c_idx)] = 1 if task t assigned to cleaner c (only for allowed pairs)
    x = {}
    for (t_idx, c_idx, delta_scaled, load_scaled) in allowed_pairs:
        key = (t_idx, c_idx)
        x[key] = model.new_bool_var(f"x_{t_idx}_{c_idx}")

    by_task = defaultdict(list)
    for (t_idx, c_idx, dt, lc) in allowed_pairs:
        by_task[t_idx].append((t_idx, c_idx, dt, lc))
    by_cleaner = defaultdict(list)
    for (t_idx, c_idx, dt, lc) in allowed_pairs:
        by_cleaner[c_idx].append((t_idx, c_idx, dt, lc))

    # Constraint: each task at most one cleaner
    for t_idx in by_task:
        model.add(sum(x[(t_idx, c_idx)] for (_, c_idx, _, _) in by_task[t_idx]) <= 1)

    # Per-cleaner: load and task count
    for c_idx in range(n_cleaners):
        if c_idx not in by_cleaner:
            continue
        pairs_c = by_cleaner[c_idx]
        clean = cleaners_list[c_idx] if c_idx < len(cleaners_list) else {}
        current_load = int(float(clean.get("currentLoadMin", 0)) * SCALE)
        current_count = int(clean.get("currentTaskCount", 0))
        max_load = int(float(clean.get("maxLoad", 600)) * SCALE)
        max_tasks = int(clean.get("maxTasks", 5))
        load_expr = current_load
        count_expr = current_count
        for (t_idx, c_idx, dt, load_scaled) in pairs_c:
            load_expr = load_expr + x[(t_idx, c_idx)] * load_scaled
            count_expr = count_expr + x[(t_idx, c_idx)]
        model.add(load_expr <= max_load)
        model.add(count_expr <= max_tasks)

    # Objective: maximize tasks assigned (priority 1), minimize total travel (priority 2)
    task_weight = 1000000
    travel_weight = 1
    obj_tasks = []
    obj_travel = []
    for (t_idx, c_idx, delta_scaled, _) in allowed_pairs:
        obj_tasks.append(x[(t_idx, c_idx)])
        obj_travel.append(x[(t_idx, c_idx)] * delta_scaled)
    model.maximize(task_weight * sum(obj_tasks) - travel_weight * sum(obj_travel))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 60.0
    status = solver.solve(model)

    if status in (cp_model.INFEASIBLE, cp_model.MODEL_INVALID):
        print(
            json.dumps({"status": "infeasible", "assignments": []}),
            flush=True,
        )
        return
    if status != cp_model.OPTIMAL and status != cp_model.FEASIBLE:
        print(
            json.dumps({"status": "error", "message": f"Solver status {status}", "assignments": []}),
            flush=True,
        )
        sys.exit(1)

    assignments = []
    for (t_idx, c_idx, _, _) in allowed_pairs:
        if solver.value(x[(t_idx, c_idx)]) == 1:
            assignments.append({"taskId": task_ids[t_idx], "cleanerId": cleaner_ids[c_idx]})
    out = {"status": "ok", "assignments": assignments}
    print(json.dumps(out), flush=True)


if __name__ == "__main__":
    main()
