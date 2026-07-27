#!/usr/bin/env python3
"""
Logistics routing VRP with OR-Tools Routing library.
Reads JSON stdin (OrToolsRoutingPayload), writes OrToolsRawSolution JSON stdout.
"""

import json
import sys
import time

try:
    from ortools.constraint_solver import routing_enums_pb2
    from ortools.constraint_solver import pywrapcp
except ImportError:
    print(
        json.dumps({"status": "error", "message": "ortools not installed (pip install ortools)"}),
        flush=True,
    )
    sys.exit(1)


def solve_payload(payload):
    started = time.time()
    travel = payload["travelMatrixMin"]
    cost = payload["costMatrixMin"]
    n = len(travel)
    vehicles = payload.get("vehicles", [])
    tasks = payload.get("tasks", [])
    num_vehicles = len(vehicles)

    if num_vehicles == 0:
        return {
            "status": "infeasible",
            "message": "No vehicles available",
            "solveDurationMs": int((time.time() - started) * 1000),
        }

    if len(tasks) == 0:
        return {
            "status": "ok",
            "ortoolsStatus": "EMPTY",
            "routes": [],
            "droppedTaskIds": [],
            "objectiveValue": 0,
            "solveDurationMs": int((time.time() - started) * 1000),
        }

    service_durations = [0] * n
    tasks_by_node = {}
    for task in tasks:
        node_index = int(task["nodeIndex"])
        service_durations[node_index] = int(task["serviceDurationMin"])
        tasks_by_node[node_index] = task

    manager = pywrapcp.RoutingIndexManager(n, num_vehicles, 0)
    routing = pywrapcp.RoutingModel(manager)

    vehicle_task_penalties = payload.get("vehicleTaskPenalties")
    vehicle_arc_penalties = payload.get("vehicleArcPenalties")

    if vehicle_task_penalties or vehicle_arc_penalties:
        for vehicle_id in range(num_vehicles):
            def make_cost_callback(vid):
                def vehicle_cost_callback(from_index, to_index):
                    if routing.IsEnd(to_index):
                        return 0

                    from_node = manager.IndexToNode(from_index)
                    to_node = manager.IndexToNode(to_index)
                    territory_penalty = 0
                    if vehicle_task_penalties:
                        territory_penalty = int(vehicle_task_penalties[vid][to_node])
                    arc_penalty = 0
                    if vehicle_arc_penalties:
                        arc_penalty = int(vehicle_arc_penalties[vid][from_node][to_node])
                    return int(cost[from_node][to_node]) + territory_penalty + arc_penalty

                return vehicle_cost_callback

            callback_index = routing.RegisterTransitCallback(make_cost_callback(vehicle_id))
            routing.SetArcCostEvaluatorOfVehicle(callback_index, vehicle_id)
    else:
        def cost_callback(from_index, to_index):
            if routing.IsEnd(to_index):
                return 0

            from_node = manager.IndexToNode(from_index)
            to_node = manager.IndexToNode(to_index)
            return int(cost[from_node][to_node])

        cost_callback_index = routing.RegisterTransitCallback(cost_callback)
        routing.SetArcCostEvaluatorOfAllVehicles(cost_callback_index)

    def time_callback(from_index, to_index):
        from_node = manager.IndexToNode(from_index)

        if routing.IsEnd(to_index):
            return int(service_durations[from_node])

        to_node = manager.IndexToNode(to_index)
        return int(service_durations[from_node] + travel[from_node][to_node])

    time_callback_index = routing.RegisterTransitCallback(time_callback)
    max_vehicle_end = max(int(v["endMin"]) for v in vehicles)
    max_task_end = max(int(t["latestEndMin"]) for t in tasks)
    horizon = max(max_vehicle_end, max_task_end) + max(service_durations) + 60

    routing.AddDimension(
        time_callback_index,
        24 * 60,
        horizon,
        False,
        "Time",
    )
    time_dimension = routing.GetDimensionOrDie("Time")

    for vehicle in vehicles:
        vid = int(vehicle["vehicleIndex"])
        start_index = routing.Start(vid)
        end_index = routing.End(vid)
        start_min = int(vehicle["startMin"])
        end_min = int(vehicle["endMin"])
        time_dimension.CumulVar(start_index).SetRange(start_min, start_min)
        time_dimension.CumulVar(end_index).SetRange(0, end_min)

    for task in tasks:
        node_index = int(task["nodeIndex"])
        index = manager.NodeToIndex(node_index)
        earliest = int(task["earliestStartMin"])
        latest_start = int(task["latestStartMin"])
        service_duration = int(task["serviceDurationMin"])
        latest_end = int(task["latestEndMin"])
        # CumulVar = startMin; endMin = cumul + service must be <= latestEndMin.
        max_start_by_end = latest_end - service_duration
        max_start = min(latest_start, max_start_by_end)
        time_dimension.CumulVar(index).SetRange(earliest, max_start)

        required_vehicle_index = task.get("requiredVehicleIndex")
        penalty = int(task.get("dropPenalty", 10000))
        if required_vehicle_index is not None:
            # Required tasks must participate in the disjunction framework like optional
            # nodes: VehicleVar-only (no AddDisjunction / no -1) makes the whole model
            # infeasible as soon as any other node is optional.
            routing.VehicleVar(index).SetValues([int(required_vehicle_index), -1])
            routing.AddDisjunction([index], penalty)
        else:
            routing.AddDisjunction([index], penalty)

    for entry in payload.get("softTimeWindows", []):
        node_index = int(entry["nodeIndex"])
        task_index = manager.NodeToIndex(node_index)
        preferred_end = int(entry["preferredEndMin"])
        penalty = int(entry.get("penaltyPerMinLate", 1))
        time_dimension.SetCumulVarSoftUpperBound(task_index, preferred_end, penalty)

    balance_weight = int(payload.get("balanceDriverLoadWeight", 0))
    if balance_weight > 0:
        time_dimension.SetGlobalSpanCostCoefficient(balance_weight)

    options = payload.get("options", {})
    search_params = pywrapcp.DefaultRoutingSearchParameters()
    # PARALLEL_CHEAPEST_INSERTION finds TW-feasible first solutions much more reliably
    # than PATH_CHEAPEST_ARC on logistics instances with tight windows.
    strategy_name = options.get("firstSolutionStrategy") or "PARALLEL_CHEAPEST_INSERTION"
    search_params.first_solution_strategy = getattr(
        routing_enums_pb2.FirstSolutionStrategy,
        strategy_name,
        routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION,
    )
    search_params.local_search_metaheuristic = (
        routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    )
    search_params.time_limit.seconds = int(options.get("timeLimitSec", 30))

    # Sequence refinement re-solves an existing plan: starting from it guarantees the
    # refined result is never worse than what we already had.
    initial_routes = payload.get("initialRoutes")
    solution = None
    initial_assignment_used = False
    if initial_routes:
        try:
            initial_assignment = routing.ReadAssignmentFromRoutes(initial_routes, True)
        except Exception:
            initial_assignment = None
        if initial_assignment is not None:
            solution = routing.SolveFromAssignmentWithParameters(
                initial_assignment, search_params
            )
            initial_assignment_used = solution is not None

    if solution is None:
        solution = routing.SolveWithParameters(search_params)

    solve_duration_ms = int((time.time() - started) * 1000)

    if solution is None:
        return {
            "status": "infeasible",
            "message": "OR-Tools returned no solution",
            "solveDurationMs": solve_duration_ms,
        }

    visited_task_nodes = set()
    routes = []

    for vid in range(num_vehicles):
        index = routing.Start(vid)
        node_indices = []
        time_cumuls = []

        while not routing.IsEnd(index):
            node = manager.IndexToNode(index)
            node_indices.append(node)
            time_cumuls.append(int(solution.Value(time_dimension.CumulVar(index))))
            index = solution.Value(routing.NextVar(index))

        end_node = manager.IndexToNode(index)
        node_indices.append(end_node)
        time_cumuls.append(int(solution.Value(time_dimension.CumulVar(index))))

        task_nodes = [node for node in node_indices if node in tasks_by_node]
        if len(task_nodes) > 0:
            routes.append(
                {
                    "vehicleIndex": vid,
                    "nodeIndices": node_indices,
                    "timeCumuls": time_cumuls,
                }
            )
            for node in task_nodes:
                visited_task_nodes.add(node)

    dropped_task_ids = [
        int(task["taskId"])
        for task in tasks
        if int(task["nodeIndex"]) not in visited_task_nodes
    ]

    return {
        "status": "ok",
        "ortoolsStatus": "ROUTING_SUCCESS",
        "routes": routes,
        "droppedTaskIds": dropped_task_ids,
        "objectiveValue": int(solution.ObjectiveValue()),
        "solveDurationMs": solve_duration_ms,
        "initialAssignmentUsed": initial_assignment_used,
    }


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
        result = solve_payload(payload)
        print(json.dumps(result), flush=True)
        if result.get("status") == "error":
            sys.exit(1)
    except Exception as exc:
        print(json.dumps({"status": "error", "message": str(exc)}), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
