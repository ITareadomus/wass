import type {
  DriverId,
  DriverNode,
  RoutingProblemInput,
  TaskId,
  TaskNode,
} from "./input-contract";
import type { RoutingRouteSolution, RoutingSolution } from "./solution-contract";
import {
  buildSubZoneLookup,
  canonicalBucketOrders,
  polishRoutingSolutionWithDiagnostics,
  type SubZoneAssignment,
} from "./route-polishing";
import { findBestFeasibleSequence } from "./route-sequencer";
import { simulateRouteTiming } from "./route-timing";
import {
  compareSolutionShape,
  computeSolutionShapeMetrics,
  degradesRobustness,
  type SolutionShapeMetrics,
} from "./solution-shape-metrics";

const MAX_REPAIR_MOVES = 8;

export interface TerritoryRepairMove {
  taskId: TaskId;
  fromDriverId: DriverId;
  toDriverId: DriverId;
  insertedAtSequence: number;
  deltaTravelMin: number;
}

export interface TerritoryRepairDiagnostics {
  candidateTaskIds: TaskId[];
  appliedMoves: TerritoryRepairMove[];
  rejectedMoves: Array<{ taskId: TaskId; toDriverId: DriverId; reason: string }>;
  before: SolutionShapeMetrics;
  after: SolutionShapeMetrics;
}

function requiredDriverByTaskId(input: RoutingProblemInput): Map<TaskId, DriverId> {
  const required = new Map<TaskId, DriverId>();
  for (const constraint of input.hardConstraints) {
    if (constraint.type === "REQUIRED_DRIVER_TASK") {
      required.set(constraint.taskId, constraint.driverId);
    }
  }
  return required;
}

function preferredDriverByTaskId(input: RoutingProblemInput): Map<TaskId, DriverId> {
  const assignment = input.metadata.dailyTerritoryAssignment;
  if (!assignment) return new Map();
  return new Map(assignment.taskPreferredDriverId.map((entry) => [entry.taskId, entry.driverId]));
}

function findOutOfTerritoryTasks(
  input: RoutingProblemInput,
  solution: RoutingSolution
): Array<{ taskId: TaskId; fromDriverId: DriverId; toDriverId: DriverId }> {
  const required = requiredDriverByTaskId(input);
  const preferred = preferredDriverByTaskId(input);
  const driverIds = new Set(solution.routes.map((route) => route.driverId));
  const candidates: Array<{ taskId: TaskId; fromDriverId: DriverId; toDriverId: DriverId }> = [];

  for (const route of solution.routes) {
    for (const stop of route.stops) {
      if (required.has(stop.taskId)) continue;
      const preferredDriverId = preferred.get(stop.taskId);
      if (preferredDriverId === undefined) continue;
      if (preferredDriverId === route.driverId) continue;
      if (!driverIds.has(preferredDriverId)) continue;
      candidates.push({
        taskId: stop.taskId,
        fromDriverId: route.driverId,
        toDriverId: preferredDriverId,
      });
    }
  }

  return candidates;
}

function replaceRoutes(
  solution: RoutingSolution,
  replacements: Map<DriverId, RoutingRouteSolution | null>
): RoutingSolution {
  const routes: RoutingRouteSolution[] = [];
  for (const route of solution.routes) {
    if (!replacements.has(route.driverId)) {
      routes.push(route);
      continue;
    }
    const replacement = replacements.get(route.driverId);
    if (replacement) routes.push(replacement);
  }

  return {
    ...solution,
    routes,
    objectiveBreakdown: solution.objectiveBreakdown
      ? {
          ...solution.objectiveBreakdown,
          assignedTasks: routes.reduce((sum, route) => sum + route.stops.length, 0),
          totalTravelMin: routes.reduce((sum, route) => sum + route.totalTravelMin, 0),
          totalWaitMin: routes.reduce((sum, route) => sum + route.totalWaitMin, 0),
        }
      : solution.objectiveBreakdown,
  };
}

/**
 * Orders to try when adding a task to a route. Plain insertions keep the existing
 * sequence intact; the canonical sweeps re-sequence the whole route, which is often the
 * only way the extra stop fits between two tight deadlines.
 */
function targetOrderCandidates(args: {
  input: RoutingProblemInput;
  driver: DriverNode;
  taskById: Map<TaskId, TaskNode>;
  currentOrder: TaskId[];
  insertedTaskId: TaskId;
  subZoneByTaskId: Map<TaskId, SubZoneAssignment>;
}): TaskId[][] {
  const { currentOrder, insertedTaskId } = args;
  const orders: TaskId[][] = [];
  const seen = new Set<string>();

  const push = (order: TaskId[]): void => {
    const key = order.join(",");
    if (seen.has(key)) return;
    seen.add(key);
    orders.push(order);
  };

  for (let position = 0; position <= currentOrder.length; position += 1) {
    push([
      ...currentOrder.slice(0, position),
      insertedTaskId,
      ...currentOrder.slice(position),
    ]);
  }

  const augmented = [...currentOrder, insertedTaskId];
  for (const canonical of canonicalBucketOrders(
    args.input,
    args.taskById,
    augmented,
    args.subZoneByTaskId
  )) {
    push(canonical);
  }

  for (const ranking of ["travel-first", "shape-first"] as const) {
    const sequenced = findBestFeasibleSequence({
      input: args.input,
      driver: args.driver,
      taskIds: augmented,
      taskById: args.taskById,
      subZoneByTaskId: args.subZoneByTaskId,
      ranking,
    });
    if (sequenced) push(sequenced.order);
  }

  return orders;
}

/**
 * Moves tasks that sit outside their territory back to the preferred driver, one at a
 * time, keeping a move only when the whole plan improves lexicographically. Task count
 * is invariant: a move is either feasible on both routes or discarded.
 */
export function repairTerritoryAssignments(
  input: RoutingProblemInput,
  solution: RoutingSolution
): { solution: RoutingSolution; diagnostics: TerritoryRepairDiagnostics | null } {
  const initialCandidates = findOutOfTerritoryTasks(input, solution);
  const before = computeSolutionShapeMetrics(input, solution);

  if (initialCandidates.length === 0) return { solution, diagnostics: null };

  const taskById = new Map<TaskId, TaskNode>(input.tasks.map((task) => [task.taskId, task]));
  const driverById = new Map(input.drivers.map((driver) => [driver.id, driver]));
  const subZoneByTaskId = buildSubZoneLookup(input);
  const appliedMoves: TerritoryRepairMove[] = [];
  const rejectedMoves: TerritoryRepairDiagnostics["rejectedMoves"] = [];

  let current = solution;
  let currentMetrics = before;

  for (let attempt = 0; attempt < MAX_REPAIR_MOVES; attempt += 1) {
    const candidates = findOutOfTerritoryTasks(input, current);
    if (candidates.length === 0) break;

    let bestMove: {
      move: TerritoryRepairMove;
      solution: RoutingSolution;
      metrics: SolutionShapeMetrics;
    } | null = null;

    for (const candidate of candidates) {
      const sourceRoute = current.routes.find((route) => route.driverId === candidate.fromDriverId);
      const targetRoute = current.routes.find((route) => route.driverId === candidate.toDriverId);
      const sourceDriver = driverById.get(candidate.fromDriverId);
      const targetDriver = driverById.get(candidate.toDriverId);
      if (!sourceRoute || !targetRoute || !sourceDriver || !targetDriver) continue;

      const sourceOrder = sourceRoute.stops
        .map((stop) => stop.taskId)
        .filter((taskId) => taskId !== candidate.taskId);
      const targetOrder = targetRoute.stops.map((stop) => stop.taskId);

      const simulatedSource =
        sourceOrder.length === 0
          ? null
          : simulateRouteTiming({
              input,
              driver: sourceDriver,
              orderedTaskIds: sourceOrder,
              taskById,
            });
      if (sourceOrder.length > 0 && !simulatedSource) {
        rejectedMoves.push({
          taskId: candidate.taskId,
          toDriverId: candidate.toDriverId,
          reason: "source_route_infeasible_without_task",
        });
        continue;
      }

      let insertionFound = false;
      const orderCandidates = targetOrderCandidates({
        input,
        driver: targetDriver,
        taskById,
        currentOrder: targetOrder,
        insertedTaskId: candidate.taskId,
        subZoneByTaskId,
      });

      for (const insertedOrder of orderCandidates) {
        const simulatedTarget = simulateRouteTiming({
          input,
          driver: targetDriver,
          orderedTaskIds: insertedOrder,
          taskById,
        });
        if (!simulatedTarget) continue;
        insertionFound = true;

        const replacements = new Map<DriverId, RoutingRouteSolution | null>([
          [candidate.fromDriverId, simulatedSource],
          [candidate.toDriverId, simulatedTarget],
        ]);
        const movedSolution = polishRoutingSolutionWithDiagnostics(
          input,
          replaceRoutes(current, replacements)
        ).solution;
        const metrics = computeSolutionShapeMetrics(input, movedSolution);

        if (degradesRobustness(currentMetrics, metrics)) continue;
        if (compareSolutionShape(metrics, currentMetrics) >= 0) continue;
        if (bestMove && compareSolutionShape(metrics, bestMove.metrics) >= 0) continue;

        bestMove = {
          move: {
            taskId: candidate.taskId,
            fromDriverId: candidate.fromDriverId,
            toDriverId: candidate.toDriverId,
            insertedAtSequence: insertedOrder.indexOf(candidate.taskId) + 1,
            deltaTravelMin: metrics.totalTravelMin - currentMetrics.totalTravelMin,
          },
          solution: movedSolution,
          metrics,
        };
      }

      if (!insertionFound) {
        rejectedMoves.push({
          taskId: candidate.taskId,
          toDriverId: candidate.toDriverId,
          reason: "no_feasible_insertion_on_preferred_driver",
        });
      }
    }

    if (!bestMove) break;

    appliedMoves.push(bestMove.move);
    current = bestMove.solution;
    currentMetrics = bestMove.metrics;
  }

  const diagnostics: TerritoryRepairDiagnostics = {
    candidateTaskIds: initialCandidates.map((candidate) => candidate.taskId),
    appliedMoves,
    rejectedMoves,
    before,
    after: currentMetrics,
  };

  if (appliedMoves.length === 0) return { solution, diagnostics };

  const notes = [
    ...(current.diagnostics?.notes ?? []),
    ...appliedMoves.map(
      (move) => `territory-repair task=${move.taskId} ${move.fromDriverId}->${move.toDriverId}`
    ),
  ];

  return {
    diagnostics,
    solution: {
      ...current,
      diagnostics: {
        warnings: current.diagnostics?.warnings ?? [],
        notes,
        solveDurationMs: current.diagnostics?.solveDurationMs,
      },
    },
  };
}
