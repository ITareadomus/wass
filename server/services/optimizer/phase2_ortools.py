#!/usr/bin/env python3
"""
Phase 2 assignment: assign candidate groups to cleaners using OR-Tools CP-SAT.
Reads JSON from stdin, writes JSON to stdout.
Business rules (see plan): compatibility, load cap, max tasks per cleaner,
straordinaria (reserve, existing OT, long OT empty cleaner, short OT + 1 extra <=2h), anchored.
"""

import json
import sys

try:
    from ortools.sat.python import cp_model
except ImportError:
    print(json.dumps({"status": "error", "message": "ortools not installed (pip install ortools)"}), flush=True)
    sys.exit(1)

# Scale minutes to integers for CP-SAT (avoid float)
SCALE = 10
LONG_OT_THRESHOLD = 360  # 6h
EXTRA_TASK_MAX_MIN = 120  # 2h


def normalize_role(role):
    if not role:
        return "standard_cleaner"
    r = role.lower().strip()
    if "standard" in r:
        return "standard_cleaner"
    if "premium" in r:
        return "premium_cleaner"
    if "straord" in r:
        return "straordinario_cleaner"
    if "formatore" in r:
        return "formatore_cleaner"
    return "standard_cleaner"


def can_handle_apt(role_key, type_apt, apartment_types):
    if not type_apt:
        return True
    apt = (type_apt or "").upper().strip()
    if role_key == "standard_cleaner":
        allowed = apartment_types.get("standard_apt") or []
    elif role_key == "premium_cleaner":
        allowed = apartment_types.get("premium_apt") or []
    elif role_key == "straordinario_cleaner":
        allowed = apartment_types.get("straordinario_apt") or []
    elif role_key == "formatore_cleaner":
        allowed = apartment_types.get("formatore_apt") or []
    else:
        return True
    return apt in [a.upper() for a in allowed]


def task_cleaner_compatible(cleaner, task, apartment_types):
    role_key = normalize_role(cleaner.get("role"))
    if task.get("premium") and role_key != "premium_cleaner":
        return False
    if task.get("straordinaria") and role_key != "straordinario_cleaner":
        return False
    if not can_handle_apt(role_key, task.get("typeApt"), apartment_types):
        return False
    return True


def normalize_task_priority(priority):
    """Normalize task priority to early_out / high_priority / low_priority."""
    if priority is None or (isinstance(priority, str) and not priority.strip()):
        return None
    s = (priority or "").lower().strip().replace("-", "_")
    if s in ("early_out", "earlyout", "eo"):
        return "early_out"
    if s in ("high_priority", "highpriority", "hp", "high"):
        return "high_priority"
    if s in ("low_priority", "lowpriority", "lp", "low"):
        return "low_priority"
    return s if s else None


def task_formatore_compatible(task, formatore_rules, apartment_types):
    """True iff task is allowed for a formatore by app_settings (priority + task type + typeApt)."""
    if not formatore_rules:
        return True
    allowed_priorities = formatore_rules.get("allowedPriorities") or []
    if allowed_priorities:
        task_pri = normalize_task_priority(task.get("priority"))
        allowed_set = set()
        for p in allowed_priorities:
            n = normalize_task_priority(p)
            if n:
                allowed_set.add(n)
            elif p:
                allowed_set.add(p.lower().replace("-", "_"))
        # Task must have a recognized priority that is in the allowed list
        if not allowed_set:
            pass
        elif task_pri is None:
            return False
        elif task_pri not in allowed_set:
            return False
    if task.get("premium") and not formatore_rules.get("premiumApt", False):
        return False
    if task.get("straordinaria") and not formatore_rules.get("straordinarioApt", False):
        return False
    if not task.get("premium") and not task.get("straordinaria") and not formatore_rules.get("standardApt", True):
        return False
    if not can_handle_apt("formatore_cleaner", task.get("typeApt"), apartment_types):
        return False
    return True


def main():
    try:
        data = json.load(sys.stdin)
    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}), flush=True)
        sys.exit(1)

    groups = data.get("groups") or []
    tasks_list = data.get("tasks") or []
    cleaners = data.get("cleaners") or []
    apartment_types = data.get("apartmentTypes") or {}
    formatore_rules = data.get("formatoreRules")
    fairness = data.get("fairness") or {}
    w_t = float(fairness.get("wT", 1.0))
    targets = data.get("targets") or {}
    max_target = int(targets.get("maxTarget", 600)) * SCALE
    min_target_scaled = int((targets.get("minTarget") or 0) * SCALE)
    target_load_scaled = int((targets.get("targetLoadMin") or 0) * SCALE)
    travel_to_first = data.get("travelToFirstTaskMin") or []  # [g][c] in minutes
    travel_weight = float(data.get("travelWeight", 2))
    k_under = float(fairness.get("k_under", 6))
    k_balance = float(fairness.get("k_balance", 2))
    k_over = float(fairness.get("k_over", 0.05))
    zero_bonus = float(fairness.get("zeroBonus", 30))
    initial_load = data.get("initialLoadByCleanerMin") or {}
    fixed_stats = data.get("initialFixedStatsByCleaner") or {}
    max_tasks_per_cleaner = int(data.get("maxTasksPerCleaner", 4))
    long_ot_min = int(data.get("straordinariaLongThresholdMin", 360))
    extra_task_max = int(data.get("straordinariaExtraTaskMaxMin", 120))

    tasks_by_id = {t["taskId"]: t for t in tasks_list}

    # Index cleaners by position for variables; keep cleanerId for output
    cleaner_ids = [c["cleanerId"] for c in cleaners]
    n_g = len(groups)
    n_c = len(cleaners)

    if n_c == 0 or n_g == 0:
        out = {
            "status": "ok",
            "assignments": [{"groupIndex": i, "cleanerId": None} for i in range(n_g)],
            "stats": {"groupsAssigned": 0, "groupsUnassigned": n_g, "tasksDropped": 0},
            "fairnessTargets": targets,
            "fairnessFinal": {},
        }
        print(json.dumps(out), flush=True)
        return

    # Precompute per-group: workMin (scaled), travelMin (scaled), task count, hasStraordinaria, isLong, anchoredCleanerId
    group_work = []
    group_travel = []
    group_ntasks = []
    group_has_ot = []
    group_long_ot = []
    group_ot_duration = []
    group_anchored = []

    for g in groups:
        task_ids = g.get("taskIds") or []
        tasks = [tasks_by_id[tid] for tid in task_ids if tasks_by_id.get(tid)]
        work_min = sum((t.get("cleaningTime") or 60) for t in tasks)
        travel_min = int((g.get("avgTravelMin") or 0) * SCALE)
        group_work.append(int(work_min * SCALE))
        group_travel.append(travel_min)
        group_ntasks.append(len(task_ids))
        has_ot = g.get("hasStraordinaria", False)
        long_ot = g.get("isLongStraordinaria", False)
        ot_dur = sum((t.get("cleaningTime") or 60) for t in tasks if t.get("straordinaria"))
        group_has_ot.append(has_ot)
        group_long_ot.append(long_ot)
        group_ot_duration.append(ot_dur)
        group_anchored.append(g.get("anchoredCleanerId"))

    # Per-cleaner initial state
    def fixed_task_count(c_idx):
        cid = cleaner_ids[c_idx]
        stats = fixed_stats.get(str(cid)) or fixed_stats.get(cid) or {}
        return int(stats.get("fixedTaskCount", 0))

    def initial_load_min(c_idx):
        cid = cleaner_ids[c_idx]
        return int((initial_load.get(str(cid)) or initial_load.get(cid) or 0) * SCALE)

    def has_any_ot(c_idx):
        cid = cleaner_ids[c_idx]
        stats = fixed_stats.get(str(cid)) or fixed_stats.get(cid) or {}
        return bool(stats.get("fixedHasAnyOT", False))

    def has_long_ot(c_idx):
        cid = cleaner_ids[c_idx]
        stats = fixed_stats.get(str(cid)) or fixed_stats.get(cid) or {}
        return bool(stats.get("fixedHasLongOT", False))

    def existing_work_min(c_idx):
        """Return existing work minutes (not scaled) for straordinaria rule."""
        cid = cleaner_ids[c_idx]
        stats = fixed_stats.get(str(cid)) or fixed_stats.get(cid) or {}
        return int(stats.get("fixedWorkMinutes") or 0)

    # Allowed (g, c): compatibility + straordinaria rules (business rules)
    allowed = [[False] * n_c for _ in range(n_g)]

    cleaner_is_formatore = [normalize_role(cleaners[c].get("role")) == "formatore_cleaner" for c in range(n_c)]

    for g_idx in range(n_g):
        group = groups[g_idx]
        task_ids = group.get("taskIds") or []
        tasks = [tasks_by_id[tid] for tid in task_ids if tasks_by_id.get(tid)]
        group_has_straordinaria = group_has_ot[g_idx]
        group_long = group_long_ot[g_idx]
        group_work_min = (group_work[g_idx] // SCALE) if SCALE else 0
        anchored = group_anchored[g_idx]

        for c_idx in range(n_c):
            cleaner = cleaners[c_idx]

            # Compatibility: all tasks in group compatible with cleaner.
            # For formatori, also enforce formatore_rules (priority + task type).
            compat = True
            for task in tasks:
                if not task_cleaner_compatible(cleaner, task, apartment_types):
                    compat = False
                    break
                if cleaner_is_formatore[c_idx] and not task_formatore_compatible(task, formatore_rules, apartment_types):
                    compat = False
                    break
            if not compat:
                continue

            fixed_count = fixed_task_count(c_idx)
            has_ot_c = has_any_ot(c_idx)
            long_ot_c = has_long_ot(c_idx)
            existing_work = existing_work_min(c_idx)

            # Business: long OT group only to empty cleaner (no other tasks)
            if group_has_straordinaria and group_long:
                if fixed_count > 0:
                    continue
                # This cleaner can only get this one group (enforced by constraint: if assigned this group, no other)
                allowed[g_idx][c_idx] = True
                continue

            # Business: cleaner already has straordinaria
            if has_ot_c:
                if long_ot_c:
                    continue  # no more tasks
                # Short OT: can add exactly 1 task with duration <= 2h, no OT in group
                if fixed_count != 1:
                    continue
                if group_has_straordinaria or group_work_min > extra_task_max:
                    continue
                allowed[g_idx][c_idx] = True
                continue

            # Business: cleaner has non-OT tasks; can add short OT only if 1 task <= 2h
            if group_has_straordinaria and fixed_count > 0:
                if fixed_count != 1 or existing_work > extra_task_max or group_long:
                    continue
                allowed[g_idx][c_idx] = True
                continue

            allowed[g_idx][c_idx] = True

    group_is_formatore_compatible = []
    for g_idx in range(n_g):
        group = groups[g_idx]
        task_ids = group.get("taskIds") or []
        tasks = [tasks_by_id[tid] for tid in task_ids if tasks_by_id.get(tid)]
        ok = True
        for task in tasks:
            if not task_formatore_compatible(task, formatore_rules, apartment_types):
                ok = False
                break
        group_is_formatore_compatible.append(ok)

    FORMATORE_BONUS = 80000

    model = cp_model.CpModel()

    # x[g][c] = 1 if group g assigned to cleaner c (only where allowed)
    x = []
    for g in range(n_g):
        row = []
        for c in range(n_c):
            if allowed[g][c]:
                row.append(model.new_bool_var(f"x_{g}_{c}"))
            else:
                row.append(None)
        x.append(row)

    # Constraint: each group at most one cleaner
    for g in range(n_g):
        model.add(sum(x[g][c] for c in range(n_c) if x[g][c] is not None) <= 1)

    # Constraint: load per cleaner <= maxTarget (scaled). Business: carico massimo per cleaner.
    for c in range(n_c):
        load_expr = initial_load_min(c)
        for g in range(n_g):
            if x[g][c] is not None:
                load_expr = load_expr + x[g][c] * (group_work[g] + int(w_t * group_travel[g]))
        model.add(load_expr <= max_target)

    # Constraint: task count per cleaner <= maxTasksPerCleaner
    for c in range(n_c):
        count_expr = fixed_task_count(c)
        for g in range(n_g):
            if x[g][c] is not None:
                count_expr += x[g][c] * group_ntasks[g]
        model.add(count_expr <= max_tasks_per_cleaner)

    # Business: long OT group -> cleaner gets only that group (no other group to same cleaner)
    for g in range(n_g):
        if not group_long_ot[g]:
            continue
        for c in range(n_c):
            if x[g][c] is None:
                continue
            for g2 in range(n_g):
                if g2 == g:
                    continue
                if x[g2][c] is not None:
                    model.add(x[g][c] + x[g2][c] <= 1)

    # Build load expression per cleaner (scaled) for fairness auxiliary variables
    def load_expr(c_idx):
        expr = initial_load_min(c_idx)
        for g in range(n_g):
            if x[g][c_idx] is not None:
                expr = expr + x[g][c_idx] * (group_work[g] + int(w_t * group_travel[g]))
        return expr

    # Auxiliary variables for legacy fairness weights
    max_aux = max(max_target, min_target_scaled, target_load_scaled)
    under_c = [model.new_int_var(0, max_aux, f"under_{c}") for c in range(n_c)]
    balance_c = [model.new_int_var(0, max_aux, f"balance_{c}") for c in range(n_c)]
    over_c = [model.new_int_var(0, max_aux, f"over_{c}") for c in range(n_c)]
    product_over_c = [model.new_int_var(0, max_aux * max_aux, f"product_over_{c}") for c in range(n_c)]
    for c in range(n_c):
        load_c = load_expr(c)
        model.add(under_c[c] >= min_target_scaled - load_c)
        model.add(under_c[c] >= 0)
        model.add(balance_c[c] >= load_c - target_load_scaled)
        model.add(balance_c[c] >= 0)
        model.add(over_c[c] >= load_c - max_target)
        model.add(over_c[c] >= 0)
        model.add_multiplication_equality(product_over_c[c], [over_c[c], over_c[c]])

    has_any_c = []
    for c in range(n_c):
        if initial_load_min(c) == 0:
            h = model.new_bool_var(f"has_any_{c}")
            model.add(sum(x[g][c] for g in range(n_g) if x[g][c] is not None) >= 1).OnlyEnforceIf(h)
            model.add(sum(x[g][c] for g in range(n_g) if x[g][c] is not None) == 0).OnlyEnforceIf(h.Not())
            has_any_c.append((c, h))
        else:
            has_any_c.append((c, None))

    # Objective: legacy weights (task_weight dominant, then travel, under, balance, over, zeroBonus)
    task_weight = 100000
    obj_terms = []

    for g in range(n_g):
        for c in range(n_c):
            if x[g][c] is None:
                continue
            obj_terms.append(task_weight * x[g][c] * group_ntasks[g])
            travel_first_min = float(travel_to_first[g][c] if g < len(travel_to_first) and c < len(travel_to_first[g]) else 0) or 0
            travel_min = travel_first_min + (group_travel[g] / SCALE)
            obj_terms.append((-travel_weight * travel_min) * x[g][c])
            if c < len(cleaner_is_formatore) and cleaner_is_formatore[c] and g < len(group_is_formatore_compatible) and group_is_formatore_compatible[g]:
                obj_terms.append(FORMATORE_BONUS * x[g][c])
    for c in range(n_c):
        obj_terms.append((k_under / SCALE) * under_c[c])
        obj_terms.append(-(k_balance / SCALE) * balance_c[c])
        obj_terms.append(-(k_over / (SCALE * SCALE)) * product_over_c[c])
    for (c, h) in has_any_c:
        if h is not None:
            obj_terms.append(zero_bonus)
            obj_terms.append(-zero_bonus * h)

    model.maximize(sum(obj_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 60.0

    status = solver.solve(model)

    if status in (cp_model.INFEASIBLE, cp_model.MODEL_INVALID):
        print(
            json.dumps(
                {
                    "status": "infeasible",
                    "message": "Model infeasible or invalid",
                    "assignments": [],
                    "stats": {"groupsAssigned": 0, "groupsUnassigned": n_g, "tasksDropped": 0},
                }
            ),
            flush=True,
        )
        sys.exit(0)

    if status != cp_model.OPTIMAL and status != cp_model.FEASIBLE:
        print(
            json.dumps(
                {
                    "status": "error",
                    "message": f"Solver status {status}",
                    "assignments": [],
                }
            ),
            flush=True,
        )
        sys.exit(1)

    assignments = []
    groups_assigned = 0
    for g in range(n_g):
        cid = None
        for c in range(n_c):
            if x[g][c] is not None and solver.value(x[g][c]) == 1:
                cid = cleaner_ids[c]
                groups_assigned += 1
                break
        assignments.append({"groupIndex": g, "cleanerId": cid})

    out = {
        "status": "ok",
        "assignments": assignments,
        "stats": {
            "groupsAssigned": groups_assigned,
            "groupsUnassigned": n_g - groups_assigned,
            "tasksDropped": 0,
        },
        "fairnessTargets": targets,
        "fairnessFinal": {"groupsAssigned": groups_assigned, "groupsUnassigned": n_g - groups_assigned},
    }
    print(json.dumps(out), flush=True)


if __name__ == "__main__":
    main()
