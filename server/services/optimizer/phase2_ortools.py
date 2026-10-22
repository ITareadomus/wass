#!/usr/bin/env python3
"""
Phase 2 assignment: assign candidate groups to cleaners using OR-Tools CP-SAT.
Reads JSON from stdin, writes JSON to stdout.
Business rules (see plan): compatibility, load cap, max tasks per cleaner,
straordinaria duration (long OT on an empty cleaner, short OT + 1 extra <=2h), anchored.
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
CONTINUAZIONE_PS_OPERATION_ID = 37
CONTINUAZIONE_PS_OPERATION_NAME = "continuazione ps"


def normalize_role(role):
    if not role:
        return "standard_cleaner"
    r = role.lower().strip()
    if "standard" in r:
        return "standard_cleaner"
    if "premium" in r:
        return "premium_cleaner"
    if "ufficio" in r:
        return "ufficio_cleaner"
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
    elif role_key == "ufficio_cleaner":
        allowed = apartment_types.get("ufficio_apt") or []
    else:
        return True
    return apt in [a.upper() for a in allowed]


def is_office_task(task, office_operation_ids):
    if task.get("isOfficeTask") is True:
        return True
    op_id = task.get("operationId")
    try:
        return op_id is not None and int(op_id) in office_operation_ids
    except Exception:
        return False


def is_real_straordinaria(task, office_operation_ids):
    return (bool(task.get("straordinaria")) or is_continuazione_ps_task(task)) and not is_office_task(task, office_operation_ids)


def is_continuazione_ps_task(task):
    op_id = task.get("operationId")
    try:
        if op_id is None or int(op_id) != CONTINUAZIONE_PS_OPERATION_ID:
            return False
    except Exception:
        return False

    op_name = task.get("operationName") or task.get("operation_name") or task.get("operation_label")
    if op_name is None or str(op_name).strip() == "":
        return True
    return str(op_name).strip().lower() == CONTINUAZIONE_PS_OPERATION_NAME


def task_triade_weight(value):
    try:
        weight = int(value)
    except (TypeError, ValueError):
        return 1
    if weight < 1:
        return 1
    return min(weight, 3)


def constraint_mode(constraints, key, default="hard"):
    raw = (constraints or {}).get(key, default)
    if raw in ("off", "soft", "hard"):
        return raw
    return default


def apply_pair(mode, violated, penalty):
    """None blocks the pair. An int is a soft penalty and the pair stays allowed."""
    if not violated or mode == "off":
        return 0
    if mode == "soft":
        return int(penalty)
    return None


def task_pair_penalty(cleaner, task, apartment_types, office_operation_ids, constraints, formatore_rules):
    role_key = normalize_role(cleaner.get("role"))
    office_task = is_office_task(task, office_operation_ids)
    penalty = 0

    if office_task:
        office_penalty = apply_pair(constraint_mode(constraints, "officeRole"), role_key != "ufficio_cleaner", 40000)
        if office_penalty is None:
            return None
        return office_penalty

    office_penalty = apply_pair(constraint_mode(constraints, "officeRole"), role_key == "ufficio_cleaner", 40000)
    if office_penalty is None:
        return None
    penalty += office_penalty

    cleaner_weight = task_triade_weight(cleaner.get("triadeWeight"))
    task_weight = task_triade_weight(task.get("triadeWeight"))
    ceiling = apply_pair(
        constraint_mode(constraints, "triadeCeiling"),
        cleaner_weight < task_weight,
        15000 * max(1, task_weight - cleaner_weight),
    )
    if ceiling is None:
        return None
    penalty += ceiling

    apt = apply_pair(
        constraint_mode(constraints, "apartmentType"),
        not can_handle_apt(role_key, task.get("typeApt"), apartment_types),
        12000,
    )
    if apt is None:
        return None
    penalty += apt

    if role_key == "formatore_cleaner":
        priority_blocked = not task_formatore_priority_ok(task, formatore_rules)
        priority = apply_pair(constraint_mode(constraints, "formatorePriority"), priority_blocked, 12000)
        if priority is None:
            return None
        penalty += priority
        standard_blocked = (
            not task.get("premium")
            and not is_real_straordinaria(task, office_operation_ids)
            and formatore_rules
            and not formatore_rules.get("standardApt", True)
        )
        standard = apply_pair(constraint_mode(constraints, "formatoreStandard"), bool(standard_blocked), 12000)
        if standard is None:
            return None
        penalty += standard
        if not can_handle_apt("formatore_cleaner", task.get("typeApt"), apartment_types):
            apt_formatore = apply_pair(constraint_mode(constraints, "apartmentType"), True, 12000)
            if apt_formatore is None:
                return None
            penalty += apt_formatore

    return penalty


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


def task_formatore_priority_ok(task, formatore_rules):
    if not formatore_rules:
        return True
    allowed_priorities = formatore_rules.get("allowedPriorities") or []
    if not allowed_priorities:
        return True
    task_pri = normalize_task_priority(task.get("priority"))
    allowed_set = set()
    for p in allowed_priorities:
        n = normalize_task_priority(p)
        if n:
            allowed_set.add(n)
        elif p:
            allowed_set.add(p.lower().replace("-", "_"))
    if not allowed_set:
        return True
    if task_pri is None or task_pri not in allowed_set:
        return False
    return True


def task_formatore_compatible(task, formatore_rules, apartment_types, office_operation_ids):
    """True iff task is allowed for a formatore by app_settings (priority + task type + typeApt)."""
    if is_office_task(task, office_operation_ids):
        return True
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
    if not task.get("premium") and not is_real_straordinaria(task, office_operation_ids) and not formatore_rules.get("standardApt", True):
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
    office_operation_ids = set()
    for op_id in (data.get("officeOperationIds") or []):
        try:
            office_operation_ids.add(int(op_id))
        except Exception:
            pass
    formatore_rules = data.get("formatoreRules")
    task_types_by_cleaner = data.get("taskTypesByCleaner") or {}
    fairness = data.get("fairness") or {}
    w_t = float(fairness.get("wT", 1.0))
    targets = data.get("targets") or {}
    max_target = int(targets.get("maxTarget", 600)) * SCALE
    min_target_scaled = int((targets.get("minTarget") or 0) * SCALE)
    target_load_scaled = int((targets.get("targetLoadMin") or 0) * SCALE)
    travel_to_first = data.get("travelToFirstTaskMin") or []  # [g][c] in minutes
    constraints = data.get("constraints") or {}
    travel_mode = constraint_mode(constraints, "travel", "soft")
    match_mode = constraint_mode(constraints, "triadeMatch", "soft")
    travel_weight = 0.0 if travel_mode == "off" else float(constraints.get("travelWeight", data.get("travelWeight", 2)))
    travel_hard_max = int(constraints.get("travelHardMaxMin", 45))
    triad_level_bonus = 0 if match_mode != "soft" else int(constraints.get("triadeMatchBonus", data.get("triadLevelBonus", 8000)))
    triad_overqual_penalty = 0 if match_mode != "soft" else int(constraints.get("triadeOverqualPenalty", data.get("triadOverqualPenalty", 3000)))
    load_mode = constraint_mode(constraints, "loadCap", "hard")
    count_mode = constraint_mode(constraints, "taskCount", "hard")
    long_mode = constraint_mode(constraints, "longOt", "hard")
    short_mode = constraint_mode(constraints, "shortOt", "hard")
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
    group_triade = []

    for g in groups:
        task_ids = g.get("taskIds") or []
        tasks = [tasks_by_id[tid] for tid in task_ids if tasks_by_id.get(tid)]
        work_min = sum((t.get("cleaningTime") or 60) for t in tasks)
        travel_min = int((g.get("avgTravelMin") or 0) * SCALE)
        group_work.append(int(work_min * SCALE))
        group_travel.append(travel_min)
        group_ntasks.append(len(task_ids))
        has_ot = any(is_real_straordinaria(t, office_operation_ids) for t in tasks)
        ot_dur = sum((t.get("cleaningTime") or 60) for t in tasks if is_real_straordinaria(t, office_operation_ids))
        long_ot = ot_dur >= long_ot_min
        group_has_ot.append(has_ot)
        group_long_ot.append(long_ot)
        group_ot_duration.append(ot_dur)
        group_anchored.append(g.get("anchoredCleanerId"))
        group_triade.append(max((task_triade_weight(t.get("triadeWeight")) for t in tasks), default=1))

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

    # Allowed (g, c) plus soft penalty collected while checking modes.
    allowed = [[False] * n_c for _ in range(n_g)]
    pair_soft = [[0] * n_c for _ in range(n_g)]

    cleaner_is_formatore = [normalize_role(cleaners[c].get("role")) == "formatore_cleaner" for c in range(n_c)]
    cleaner_triade = [task_triade_weight(cleaners[c].get("triadeWeight")) for c in range(n_c)]

    def ot_violation(mode, amount, g_idx, c_idx):
        if mode == "off":
            return False
        if mode == "soft":
            pair_soft[g_idx][c_idx] += amount
            return False
        return True

    for g_idx in range(n_g):
        group = groups[g_idx]
        task_ids = group.get("taskIds") or []
        tasks = [tasks_by_id[tid] for tid in task_ids if tasks_by_id.get(tid)]
        group_has_straordinaria = group_has_ot[g_idx]
        group_long = group_long_ot[g_idx]
        group_work_min = (group_work[g_idx] // SCALE) if SCALE else 0

        for c_idx in range(n_c):
            cleaner = cleaners[c_idx]
            pair_penalty = 0
            blocked = False
            for task in tasks:
                one = task_pair_penalty(
                    cleaner, task, apartment_types, office_operation_ids, constraints, formatore_rules
                )
                if one is None:
                    blocked = True
                    break
                pair_penalty += one
            if blocked:
                continue
            if match_mode == "hard" and cleaner_triade[c_idx] != group_triade[g_idx]:
                continue
            if travel_mode == "hard":
                travel_first = float(travel_to_first[g_idx][c_idx] if g_idx < len(travel_to_first) and c_idx < len(travel_to_first[g_idx]) else 0) or 0
                if travel_first + (group_travel[g_idx] / SCALE) > travel_hard_max:
                    continue

            pair_soft[g_idx][c_idx] += pair_penalty
            fixed_count = fixed_task_count(c_idx)
            has_ot_c = has_any_ot(c_idx)
            long_ot_c = has_long_ot(c_idx)
            existing_work = existing_work_min(c_idx)

            if group_has_straordinaria and group_long and fixed_count > 0:
                if ot_violation(long_mode, 25000, g_idx, c_idx):
                    continue
                allowed[g_idx][c_idx] = True
                continue

            if has_ot_c and long_ot_c:
                if ot_violation(long_mode, 25000, g_idx, c_idx):
                    continue

            if has_ot_c and not long_ot_c:
                short_bad = fixed_count != 1 or group_has_straordinaria or group_work_min > extra_task_max
                if short_bad and ot_violation(short_mode, 12000, g_idx, c_idx):
                    continue

            if group_has_straordinaria and fixed_count > 0 and not has_ot_c:
                short_bad = fixed_count != 1 or existing_work > extra_task_max or group_long
                mode_for_bad = long_mode if group_long else short_mode
                if short_bad and ot_violation(mode_for_bad, 25000 if group_long else 12000, g_idx, c_idx):
                    continue

            allowed[g_idx][c_idx] = True

    group_is_formatore_compatible = []
    for g_idx in range(n_g):
        group = groups[g_idx]
        task_ids = group.get("taskIds") or []
        tasks = [tasks_by_id[tid] for tid in task_ids if tasks_by_id.get(tid)]
        ok = True
        for task in tasks:
            if not task_formatore_compatible(task, formatore_rules, apartment_types, office_operation_ids):
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
        if load_mode == "hard":
            model.add(load_expr <= max_target)

    # Constraint: task count per cleaner <= maxTasksPerCleaner
    extra_task_slack = []
    for c in range(n_c):
        count_expr = fixed_task_count(c)
        for g in range(n_g):
            if x[g][c] is not None:
                count_expr += x[g][c] * group_ntasks[g]
        if count_mode == "hard":
            model.add(count_expr <= max_tasks_per_cleaner)
        elif count_mode == "soft":
            slack = model.new_int_var(0, 30, f"extra_tasks_{c}")
            model.add(count_expr <= max_tasks_per_cleaner + slack)
            extra_task_slack.append(slack)

    long_soft_vars = []
    if long_mode == "hard":
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
    elif long_mode == "soft":
        for g in range(n_g):
            if not group_long_ot[g]:
                continue
            for c in range(n_c):
                if x[g][c] is None:
                    continue
                others = [x[g2][c] for g2 in range(n_g) if g2 != g and x[g2][c] is not None]
                if not others:
                    continue
                together = model.new_bool_var(f"long_with_other_{g}_{c}")
                model.add(sum(others) >= 1).OnlyEnforceIf(together)
                model.add(sum(others) == 0).OnlyEnforceIf(together.Not())
                both = model.new_bool_var(f"long_soft_{g}_{c}")
                model.add(both <= x[g][c])
                model.add(both <= together)
                model.add(both >= x[g][c] + together - 1)
                long_soft_vars.append(both)

    # Build load expression per cleaner (scaled) for fairness auxiliary variables
    def load_expr(c_idx):
        expr = initial_load_min(c_idx)
        for g in range(n_g):
            if x[g][c_idx] is not None:
                expr = expr + x[g][c_idx] * (group_work[g] + int(w_t * group_travel[g]))
        return expr

    # Auxiliary variables for legacy fairness weights
    max_aux = max(max_target, min_target_scaled, target_load_scaled)
    load_bound = max_aux if load_mode == "hard" else 20000 * SCALE
    under_c = [model.new_int_var(0, load_bound, f"under_{c}") for c in range(n_c)]
    balance_c = [model.new_int_var(0, load_bound, f"balance_{c}") for c in range(n_c)]
    over_c = [model.new_int_var(0, load_bound, f"over_{c}") for c in range(n_c)]
    product_over_c = (
        [model.new_int_var(0, load_bound * load_bound, f"product_over_{c}") for c in range(n_c)]
        if load_mode == "hard"
        else []
    )
    for c in range(n_c):
        load_c = load_expr(c)
        model.add(under_c[c] >= min_target_scaled - load_c)
        model.add(under_c[c] >= 0)
        model.add(balance_c[c] >= load_c - target_load_scaled)
        model.add(balance_c[c] >= 0)
        model.add(over_c[c] >= load_c - max_target)
        model.add(over_c[c] >= 0)
        if load_mode == "hard":
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

    # Objective: cover tasks first. Soft constraints cost less than one dropped task.
    task_weight = 100000
    obj_terms = []

    for g in range(n_g):
        for c in range(n_c):
            if x[g][c] is None:
                continue
            obj_terms.append(task_weight * x[g][c] * group_ntasks[g])
            obj_terms.append(-pair_soft[g][c] * x[g][c])
            group_weight = group_triade[g]
            level_gap = max(0, cleaner_triade[c] - group_weight)
            obj_terms.append((triad_level_bonus * group_weight - triad_overqual_penalty * level_gap) * x[g][c])
            travel_first_min = float(travel_to_first[g][c] if g < len(travel_to_first) and c < len(travel_to_first[g]) else 0) or 0
            travel_min = travel_first_min + (group_travel[g] / SCALE)
            obj_terms.append((-travel_weight * travel_min) * x[g][c])
            if c < len(cleaner_is_formatore) and cleaner_is_formatore[c] and g < len(group_is_formatore_compatible) and group_is_formatore_compatible[g]:
                obj_terms.append(FORMATORE_BONUS * x[g][c])
    for c in range(n_c):
        if load_mode != "off":
            obj_terms.append((k_under / SCALE) * under_c[c])
            obj_terms.append(-(k_balance / SCALE) * balance_c[c])
        if load_mode == "hard":
            obj_terms.append(-(k_over / (SCALE * SCALE)) * product_over_c[c])
        elif load_mode == "soft":
            obj_terms.append(-(20 / SCALE) * over_c[c])
    for slack in extra_task_slack:
        obj_terms.append(-8000 * slack)
    for both in long_soft_vars:
        obj_terms.append(-25000 * both)
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
