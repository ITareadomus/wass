#!/usr/bin/env python3
"""
Phase 5 neighborhood: select a subset of non-conflicting relocations and swaps to maximize
total travel improvement. Reads JSON from stdin, writes JSON to stdout.
Constraints: at most one move per task; per-cleaner task count within maxTasks.
"""

import json
import sys
from collections import defaultdict

try:
    from ortools.sat.python import cp_model
except ImportError:
    print(
        json.dumps({
            "status": "error",
            "message": "ortools not installed (pip install ortools)",
            "applyRelocationIndices": [],
            "applySwapIndices": []
        }),
        flush=True,
    )
    sys.exit(1)


def main():
    try:
        import io
        stdin_text = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8-sig")
        data = json.load(stdin_text)
    except Exception as e:
        print(
            json.dumps({
                "status": "error",
                "message": str(e),
                "applyRelocationIndices": [],
                "applySwapIndices": []
            }),
            flush=True,
        )
        sys.exit(1)

    relocations = data.get("relocations") or []
    swaps = data.get("swaps") or []
    cleaners_list = data.get("cleaners") or []

    if not relocations and not swaps:
        out = {"status": "ok", "applyRelocationIndices": [], "applySwapIndices": []}
        print(json.dumps(out), flush=True)
        return

    cleaner_id_to_idx = {c["cleanerId"]: i for i, c in enumerate(cleaners_list)}
    n_cleaners = len(cleaners_list)
    # currentTaskCount and maxTasks per cleaner index
    current_count = [0] * n_cleaners
    max_tasks = [6] * n_cleaners
    for c in cleaners_list:
        i = cleaner_id_to_idx.get(c["cleanerId"])
        if i is not None:
            current_count[i] = int(c.get("currentTaskCount", 0))
            max_tasks[i] = int(c.get("maxTasks", 6))

    model = cp_model.CpModel()

    # Variables: one per relocation, one per swap
    x_rel = []
    for r_idx, r in enumerate(relocations):
        x_rel.append(model.new_bool_var(f"rel_{r_idx}"))
    x_swap = []
    for s_idx, s in enumerate(swaps):
        x_swap.append(model.new_bool_var(f"swap_{s_idx}"))

    # Constraint: each task in at most one move (relocation or swap)
    task_to_rel_indices = defaultdict(list)
    for r_idx, r in enumerate(relocations):
        task_to_rel_indices[r["taskId"]].append(r_idx)
    task_to_swap_indices = defaultdict(list)
    for s_idx, s in enumerate(swaps):
        task_to_swap_indices[s["taskAId"]].append(s_idx)
        task_to_swap_indices[s["taskBId"]].append(s_idx)

    all_task_ids = set(task_to_rel_indices.keys()) | set(task_to_swap_indices.keys())
    for task_id in all_task_ids:
        expr = sum(x_rel[i] for i in task_to_rel_indices.get(task_id, []))
        expr += sum(x_swap[s_idx] for s_idx in task_to_swap_indices.get(task_id, []))
        model.add(expr <= 1)

    # Constraint: per-cleaner task count after moves
    # delta: relocation (from A, to B) => -1 for A, +1 for B; swap => 0
    for c_idx in range(n_cleaners):
        cid = cleaners_list[c_idx]["cleanerId"]
        delta = 0
        for r_idx, r in enumerate(relocations):
            if r.get("fromCleanerId") == cid:
                delta -= x_rel[r_idx]
            if r.get("toCleanerId") == cid:
                delta += x_rel[r_idx]
        model.add(current_count[c_idx] + delta <= max_tasks[c_idx])

    # Objective: maximize total improvement
    obj_rel = sum(
        int(r.get("improvement", 0)) * x_rel[r_idx] for r_idx, r in enumerate(relocations)
    )
    obj_swap = sum(
        int(s.get("improvement", 0)) * x_swap[s_idx] for s_idx, s in enumerate(swaps)
    )
    model.maximize(obj_rel + obj_swap)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 30.0
    status = solver.solve(model)

    if status in (cp_model.INFEASIBLE, cp_model.MODEL_INVALID):
        out = {"status": "infeasible", "applyRelocationIndices": [], "applySwapIndices": []}
        print(json.dumps(out), flush=True)
        return
    if status != cp_model.OPTIMAL and status != cp_model.FEASIBLE:
        out = {
            "status": "error",
            "message": f"Solver status {status}",
            "applyRelocationIndices": [],
            "applySwapIndices": []
        }
        print(json.dumps(out), flush=True)
        return

    apply_rel = [r_idx for r_idx in range(len(relocations)) if solver.value(x_rel[r_idx]) == 1]
    apply_swap = [s_idx for s_idx in range(len(swaps)) if solver.value(x_swap[s_idx]) == 1]
    out = {"status": "ok", "applyRelocationIndices": apply_rel, "applySwapIndices": apply_swap}
    print(json.dumps(out), flush=True)


if __name__ == "__main__":
    main()
