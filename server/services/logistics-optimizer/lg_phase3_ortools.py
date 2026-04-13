#!/usr/bin/env python3
"""
Logistics VRP skeleton: multi-vehicle routing with time windows (housekeeping windows).
Reads JSON from stdin, writes JSON to stdout.
Requires: pip install ortools
"""

import json
import sys

try:
    from ortools.constraint_solver import routing_enums_pb2
    from ortools.constraint_solver import pywrapcp
except ImportError:
    print(
        json.dumps(
            {
                "status": "error",
                "message": "ortools not installed (pip install ortools)",
            }
        ),
        flush=True,
    )
    sys.exit(1)


def main():
    try:
        import io

        stdin_text = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8-sig")
        data = json.load(stdin_text)
    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}), flush=True)
        sys.exit(1)

    task_ids = data.get("taskIds") or []
    time_matrix = data.get("timeMatrix") or []
    service_times = data.get("serviceTimes") or []
    time_windows = data.get("timeWindows") or []
    driver_ids = data.get("driverIds") or []
    num_vehicles = int(data.get("numVehicles") or 0)
    vehicle_capacity = int(data.get("vehicleCapacity") or 8)
    target_min = int(data.get("targetMinPerDriver") or 0)
    target_max = int(data.get("targetMaxPerDriver") or vehicle_capacity)
    balance_penalty = int(data.get("balancePenalty") or 1000)
    seed_assignment = data.get("seedAssignment") or {}
    time_limit_s = float(data.get("timeLimitSeconds") or 30.0)

    n = len(time_matrix)
    if n < 2 or len(task_ids) == 0 or num_vehicles <= 0:
        print(
            json.dumps(
                {
                    "status": "ok",
                    "routes": [],
                    "message": "empty_input",
                }
            ),
            flush=True,
        )
        return

    if len(time_matrix) != n or any(len(row) != n for row in time_matrix):
        print(json.dumps({"status": "error", "message": "timeMatrix not square"}), flush=True)
        sys.exit(1)

    if len(service_times) != n or len(time_windows) != n:
        print(
            json.dumps({"status": "error", "message": "serviceTimes/timeWindows length mismatch"}),
            flush=True,
        )
        sys.exit(1)

    demands = [0] * n
    for i in range(1, n):
        demands[i] = 1

    manager = pywrapcp.RoutingIndexManager(n, num_vehicles, 0)
    routing = pywrapcp.RoutingModel(manager)

    def time_callback(from_index, to_index):
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)
        return int(time_matrix[from_node][to_node]) + int(service_times[from_node])

    transit_cb = routing.RegisterTransitCallback(time_callback)
    routing.SetArcCostEvaluatorOfAllVehicles(transit_cb)

    routing.AddDimension(
        transit_cb,
        24 * 60,
        24 * 60,
        True,
        "Time",
    )
    time_dim = routing.GetDimensionOrDie("Time")

    for i in range(n):
        tw = time_windows[i]
        start = int(tw[0])
        end = int(tw[1])
        if i == 0:
            continue
        index = manager.NodeToIndex(i)
        time_dim.CumulVar(index).SetRange(start, end)

    for v in range(num_vehicles):
        idx = routing.Start(v)
        time_dim.CumulVar(idx).SetRange(0, 24 * 60 - 1)
        idxe = routing.End(v)
        time_dim.CumulVar(idxe).SetRange(0, 24 * 60 - 1)

    def demand_cb(from_index):
        from_node = manager.IndexToNode(from_index)
        return demands[from_node]

    demand_cb_idx = routing.RegisterUnaryTransitCallback(demand_cb)
    routing.AddDimensionWithVehicleCapacity(
        demand_cb_idx,
        0,
        [vehicle_capacity] * num_vehicles,
        True,
        "Capacity",
    )
    routing.AddDimension(
        demand_cb_idx,
        0,
        n,
        True,
        "Count",
    )
    count_dim = routing.GetDimensionOrDie("Count")
    for v in range(num_vehicles):
        end_idx = routing.End(v)
        count_dim.SetCumulVarSoftLowerBound(end_idx, max(0, target_min), max(1, balance_penalty))
        count_dim.SetCumulVarSoftUpperBound(end_idx, max(1, target_max), max(1, balance_penalty))

    search_params = pywrapcp.DefaultRoutingSearchParameters()
    search_params.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    )
    search_params.local_search_metaheuristic = (
        routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    )
    search_params.time_limit.FromSeconds(time_limit_s)

    # Build seeded initial routes from Phase2 seedAssignment (taskId -> driverId).
    task_id_to_node = {int(task_ids[i]): i + 1 for i in range(len(task_ids))}
    driver_id_to_vehicle_idx = {}
    if isinstance(driver_ids, list) and len(driver_ids) == num_vehicles:
        driver_id_to_vehicle_idx = {int(driver_ids[i]): i for i in range(num_vehicles)}

    initial_routes = [[] for _ in range(num_vehicles)]
    if isinstance(seed_assignment, dict) and driver_id_to_vehicle_idx:
        for task_id_str, driver_id in seed_assignment.items():
            try:
                task_id = int(task_id_str)
                did = int(driver_id)
            except Exception:
                continue
            node = task_id_to_node.get(task_id)
            v_idx = driver_id_to_vehicle_idx.get(did)
            if node is None or v_idx is None:
                continue
            initial_routes[v_idx].append(node)

        # Deterministic order by time-window start, then node id
        for v in range(num_vehicles):
            initial_routes[v].sort(key=lambda node: (int(time_windows[node][0]), node))

    sol = None
    try:
        if any(len(r) > 0 for r in initial_routes):
            initial_assignment = routing.ReadAssignmentFromRoutes(initial_routes, True)
            if initial_assignment is not None:
                sol = routing.SolveFromAssignmentWithParameters(initial_assignment, search_params)
    except Exception:
        sol = None

    if sol is None:
        sol = routing.SolveWithParameters(search_params)
    if sol is None:
        print(json.dumps({"status": "infeasible", "message": "No solution"}), flush=True)
        return

    routes_out = []
    for v in range(num_vehicles):
        tids = []
        idx = routing.Start(v)
        while not routing.IsEnd(idx):
            node = manager.IndexToNode(idx)
            if node != 0:
                ti = node - 1
                if 0 <= ti < len(task_ids):
                    tids.append(int(task_ids[ti]))
            idx = sol.Value(routing.NextVar(idx))
        routes_out.append({"vehicleIndex": v, "taskIds": tids})

    arrivals = {}
    for v in range(num_vehicles):
        idx = routing.Start(v)
        while not routing.IsEnd(idx):
            node = manager.IndexToNode(idx)
            if node != 0:
                cumul = sol.Min(time_dim.CumulVar(idx))
                ti = node - 1
                if 0 <= ti < len(task_ids):
                    arrivals[str(task_ids[ti])] = int(cumul)
            idx = sol.Value(routing.NextVar(idx))

    print(
        json.dumps({"status": "ok", "routes": routes_out, "arrivalsMinByTaskId": arrivals}),
        flush=True,
    )


if __name__ == "__main__":
    main()
