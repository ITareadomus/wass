import {
  LOGISTICS_HYPOTHESIS_IDS,
  logisticsHypothesisProfileById,
  type LogisticsHypothesisId,
  type LogisticsHypothesisSummary,
  type LogisticsHypothesisTimelinePreview,
} from "../../../shared/logistics-routing-hypotheses";
import type { DriverNode, RoutingProblemInput, TaskId, TaskNode } from "./input-contract";
import {
  ORTOOLS_SOLVER_ID,
  ROUTING_SOLUTION_SCHEMA_VERSION,
  type RoutingDroppedTask,
  type RoutingRouteSolution,
  type RoutingSolution,
} from "./solution-contract";
import {
  partitionExclusiveWorkZones,
  type ExclusiveWorkZoneSpec,
} from "./exclusive-work-zones";
import { findBestFeasibleSequence } from "./route-sequencer";
import { simulateRouteTiming, simulateRouteTimingAllowingViolations } from "./route-timing";
import { classifyTaskNodeUrgency } from "./task-urgency";

const DEPOT_NODE_INDEX = 0;

export interface LogisticsRoutingHypothesis {
  summary: LogisticsHypothesisSummary;
  solution: RoutingSolution;
  preview?: LogisticsHypothesisTimelinePreview;
}

function travelBetween(
  input: RoutingProblemInput,
  fromNodeIndex: number,
  toNodeIndex: number
): number | null {
  const travel = input.travelMatrixMin[fromNodeIndex]?.[toNodeIndex];
  return Number.isFinite(travel) ? travel : null;
}

function projectedStartMin(args: {
  input: RoutingProblemInput;
  fromNodeIndex: number;
  fromEndMin: number;
  task: TaskNode;
}): number {
  const travel = travelBetween(args.input, args.fromNodeIndex, args.task.nodeIndex);
  const arrivalMin = args.fromEndMin + (travel ?? 0);
  return Math.max(arrivalMin, args.task.hardWindow.earliestStartMin);
}

function wouldStrandUrgentTask(args: {
  input: RoutingProblemInput;
  candidate: TaskNode;
  remaining: TaskNode[];
  fromNodeIndex: number;
  fromEndMin: number;
}): boolean {
  const candidateStart = projectedStartMin({
    input: args.input,
    fromNodeIndex: args.fromNodeIndex,
    fromEndMin: args.fromEndMin,
    task: args.candidate,
  });
  const candidateEnd = candidateStart + args.candidate.serviceDurationMin;

  return args.remaining.some((other) => {
    if (other.taskId === args.candidate.taskId) return false;
    if (classifyTaskNodeUrgency(other) !== "urgent") return false;
    const startIfNow = projectedStartMin({
      input: args.input,
      fromNodeIndex: args.fromNodeIndex,
      fromEndMin: args.fromEndMin,
      task: other,
    });
    if (startIfNow > other.hardWindow.latestStartMin) return false;
    const startAfterCandidate = projectedStartMin({
      input: args.input,
      fromNodeIndex: args.candidate.nodeIndex,
      fromEndMin: candidateEnd,
      task: other,
    });
    return startAfterCandidate > other.hardWindow.latestStartMin;
  });
}

function pickNextStop(args: {
  input: RoutingProblemInput;
  remaining: TaskNode[];
  fromNodeIndex: number;
  fromEndMin: number;
  preferUrgent: boolean;
}): TaskNode | null {
  if (args.remaining.length === 0) return null;

  const nonStealing = args.remaining.filter(
    (candidate) =>
      !wouldStrandUrgentTask({
        input: args.input,
        candidate,
        remaining: args.remaining,
        fromNodeIndex: args.fromNodeIndex,
        fromEndMin: args.fromEndMin,
      })
  );
  const pool = nonStealing.length > 0 ? nonStealing : args.remaining;
  const urgent = pool.filter((task) => classifyTaskNodeUrgency(task) === "urgent");
  const ranked = args.preferUrgent && urgent.length > 0 ? urgent : pool;

  return ranked.reduce((best, candidate) => {
    const candidateTravel =
      travelBetween(args.input, args.fromNodeIndex, candidate.nodeIndex) ?? Number.POSITIVE_INFINITY;
    const bestTravel =
      travelBetween(args.input, args.fromNodeIndex, best.nodeIndex) ?? Number.POSITIVE_INFINITY;
    if (candidateTravel < bestTravel) return candidate;
    if (candidateTravel === bestTravel) {
      if (candidate.hardWindow.latestStartMin !== best.hardWindow.latestStartMin) {
        return candidate.hardWindow.latestStartMin < best.hardWindow.latestStartMin
          ? candidate
          : best;
      }
      return candidate.taskId < best.taskId ? candidate : best;
    }
    return best;
  });
}

function isFeasibleNow(args: {
  input: RoutingProblemInput;
  driver: DriverNode;
  fromNodeIndex: number;
  fromEndMin: number;
  task: TaskNode;
}): boolean {
  const travel = travelBetween(args.input, args.fromNodeIndex, args.task.nodeIndex);
  if (travel == null) return false;
  const startMin = Math.max(args.fromEndMin + travel, args.task.hardWindow.earliestStartMin);
  const endMin = startMin + args.task.serviceDurationMin;
  return (
    startMin <= args.task.hardWindow.latestStartMin &&
    endMin <= args.task.hardWindow.latestEndMin &&
    endMin <= args.driver.workWindow.endMin
  );
}

function urgencyRank(task: TaskNode): number {
  const urgency = classifyTaskNodeUrgency(task);
  if (urgency === "urgent" || task.priority === "HP" || task.premium || task.straordinaria) return 0;
  if (task.priority === "EO") return 1;
  if (urgency === "loose") return 3;
  return 2;
}

function pickConstraintStop(args: {
  input: RoutingProblemInput;
  driver: DriverNode;
  remaining: TaskNode[];
  fromNodeIndex: number;
  fromEndMin: number;
}): TaskNode | null {
  if (args.remaining.length === 0) return null;

  return [...args.remaining].sort((left, right) => {
    const leftFeasible = isFeasibleNow({ ...args, task: left }) ? 0 : 1;
    const rightFeasible = isFeasibleNow({ ...args, task: right }) ? 0 : 1;
    if (leftFeasible !== rightFeasible) return leftFeasible - rightFeasible;

    const leftSteal = wouldStrandUrgentTask({
      input: args.input,
      candidate: left,
      remaining: args.remaining,
      fromNodeIndex: args.fromNodeIndex,
      fromEndMin: args.fromEndMin,
    })
      ? 1
      : 0;
    const rightSteal = wouldStrandUrgentTask({
      input: args.input,
      candidate: right,
      remaining: args.remaining,
      fromNodeIndex: args.fromNodeIndex,
      fromEndMin: args.fromEndMin,
    })
      ? 1
      : 0;
    if (leftSteal !== rightSteal) return leftSteal - rightSteal;

    const leftUrgent = urgencyRank(left);
    const rightUrgent = urgencyRank(right);
    if (leftUrgent !== rightUrgent) return leftUrgent - rightUrgent;

    if (left.hardWindow.latestStartMin !== right.hardWindow.latestStartMin) {
      return left.hardWindow.latestStartMin - right.hardWindow.latestStartMin;
    }

    const leftStart = projectedStartMin({
      input: args.input,
      fromNodeIndex: args.fromNodeIndex,
      fromEndMin: args.fromEndMin,
      task: left,
    });
    const rightStart = projectedStartMin({
      input: args.input,
      fromNodeIndex: args.fromNodeIndex,
      fromEndMin: args.fromEndMin,
      task: right,
    });
    const leftSlack = left.hardWindow.latestStartMin - leftStart;
    const rightSlack = right.hardWindow.latestStartMin - rightStart;
    if (leftSlack !== rightSlack) return leftSlack - rightSlack;

    const leftTravel =
      travelBetween(args.input, args.fromNodeIndex, left.nodeIndex) ?? Number.POSITIVE_INFINITY;
    const rightTravel =
      travelBetween(args.input, args.fromNodeIndex, right.nodeIndex) ?? Number.POSITIVE_INFINITY;
    if (leftTravel !== rightTravel) return leftTravel - rightTravel;
    return left.taskId - right.taskId;
  })[0];
}

function pickFirstStop(args: {
  input: RoutingProblemInput;
  driver: DriverNode;
  tasks: TaskNode[];
  ranked: TaskNode[];
}): TaskId {
  const preferred = args.ranked.find(
    (candidate) =>
      !wouldStrandUrgentTask({
        input: args.input,
        candidate,
        remaining: args.tasks,
        fromNodeIndex: DEPOT_NODE_INDEX,
        fromEndMin: args.driver.workWindow.startMin,
      })
  );
  return (preferred ?? args.ranked[0] ?? args.tasks[0]).taskId;
}

function pickDistinctFirstStops(args: {
  tasks: TaskNode[];
  input: RoutingProblemInput;
  driver: DriverNode;
}): Partial<Record<LogisticsHypothesisId, TaskId>> {
  const { tasks, input, driver } = args;
  if (tasks.length === 0) return {};

  const byFarthest = [...tasks].sort((left, right) => {
    const leftTravel = travelBetween(input, DEPOT_NODE_INDEX, left.nodeIndex) ?? 0;
    const rightTravel = travelBetween(input, DEPOT_NODE_INDEX, right.nodeIndex) ?? 0;
    if (leftTravel !== rightTravel) return rightTravel - leftTravel;
    return left.taskId - right.taskId;
  });

  const byNearest = [...tasks].sort((left, right) => {
    const leftTravel = travelBetween(input, DEPOT_NODE_INDEX, left.nodeIndex) ?? Number.POSITIVE_INFINITY;
    const rightTravel = travelBetween(input, DEPOT_NODE_INDEX, right.nodeIndex) ?? Number.POSITIVE_INFINITY;
    if (leftTravel !== rightTravel) return leftTravel - rightTravel;
    return left.taskId - right.taskId;
  });

  const byWest = [...tasks].sort((left, right) => {
    if (left.location.lng !== right.location.lng) return left.location.lng - right.location.lng;
    return left.taskId - right.taskId;
  });

  const used = new Set<TaskId>();
  const take = (ranked: TaskNode[]): TaskId => {
    const unusedRanked = ranked.filter((task) => !used.has(task.taskId));
    const chosen = pickFirstStop({
      input,
      driver,
      tasks,
      ranked: unusedRanked.length > 0 ? unusedRanked : ranked,
    });
    used.add(chosen);
    return chosen;
  };

  return {
    "priority-strict": take(byNearest),
    "proximity-strict": take(byFarthest),
    "balanced-geo-start": take(byWest),
  };
}

function isPriorityApartment(task: TaskNode): boolean {
  if (task.priority === "EO" || task.priority === "HP") return true;
  if (task.premium === true || task.straordinaria === true) return true;
  return classifyTaskNodeUrgency(task) === "urgent";
}

function tourTravelMin(args: {
  input: RoutingProblemInput;
  order: TaskId[];
  taskById: Map<TaskId, TaskNode>;
}): number {
  let total = 0;
  for (let index = 1; index < args.order.length; index += 1) {
    const from = args.taskById.get(args.order[index - 1]);
    const to = args.taskById.get(args.order[index]);
    if (!from || !to) return Number.POSITIVE_INFINITY;
    total += travelBetween(args.input, from.nodeIndex, to.nodeIndex) ?? Number.POSITIVE_INFINITY;
  }
  return total;
}

function nearestNeighborFrom(args: {
  input: RoutingProblemInput;
  tasks: TaskNode[];
  start: TaskNode;
}): TaskId[] {
  const remaining = new Map(args.tasks.map((task) => [task.taskId, task]));
  remaining.delete(args.start.taskId);
  const order: TaskId[] = [args.start.taskId];
  let last = args.start;

  while (remaining.size > 0) {
    let best: TaskNode | null = null;
    let bestTravel = Number.POSITIVE_INFINITY;
    for (const candidate of remaining.values()) {
      const travel =
        travelBetween(args.input, last.nodeIndex, candidate.nodeIndex) ?? Number.POSITIVE_INFINITY;
      if (
        travel < bestTravel ||
        (travel === bestTravel && candidate.taskId < (best?.taskId ?? Number.POSITIVE_INFINITY))
      ) {
        best = candidate;
        bestTravel = travel;
      }
    }
    if (!best) break;
    remaining.delete(best.taskId);
    order.push(best.taskId);
    last = best;
  }

  return order;
}

function twoOptKeepStart(args: {
  input: RoutingProblemInput;
  order: TaskId[];
  taskById: Map<TaskId, TaskNode>;
}): TaskId[] {
  const next = [...args.order];
  const n = next.length;
  if (n < 4) return next;

  const nodeOf = (index: number): number | null => {
    if (index < 0 || index >= n) return null;
    return args.taskById.get(next[index])?.nodeIndex ?? null;
  };
  const leg = (fromIndex: number, toIndex: number): number => {
    const from = nodeOf(fromIndex);
    const to = nodeOf(toIndex);
    if (from == null || to == null) return Number.POSITIVE_INFINITY;
    return travelBetween(args.input, from, to) ?? Number.POSITIVE_INFINITY;
  };

  let improved = true;
  let guard = 0;
  while (improved && guard < 40) {
    improved = false;
    guard += 1;
    for (let i = 1; i < n - 1; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const current = leg(i - 1, i) + (j + 1 < n ? leg(j, j + 1) : 0);
        const swapped = leg(i - 1, j) + (j + 1 < n ? leg(i, j + 1) : 0);
        if (swapped + 0.01 >= current) continue;
        const reversed = next.slice(i, j + 1).reverse();
        next.splice(i, j - i + 1, ...reversed);
        improved = true;
      }
    }
  }
  return next;
}

function buildProximityTour(args: {
  input: RoutingProblemInput;
  tasks: TaskNode[];
  startTaskId?: TaskId;
}): TaskId[] {
  const { input, tasks } = args;
  if (tasks.length === 0) return [];
  if (tasks.length === 1) return [tasks[0].taskId];

  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const forcedStart =
    args.startTaskId != null ? tasks.find((task) => task.taskId === args.startTaskId) : undefined;
  const priorityStarts = tasks.filter(isPriorityApartment);
  const starts = forcedStart ? [forcedStart] : priorityStarts.length > 0 ? priorityStarts : tasks;

  let bestOrder: TaskId[] | null = null;
  let bestTravel = Number.POSITIVE_INFINITY;
  for (const start of starts) {
    const neighborOrder = nearestNeighborFrom({ input, tasks, start });
    const order = twoOptKeepStart({ input, order: neighborOrder, taskById });
    const travel = tourTravelMin({ input, order, taskById });
    if (
      travel < bestTravel ||
      (travel === bestTravel &&
        (bestOrder == null ||
          order[0] < bestOrder[0] ||
          (order[0] === bestOrder[0] && order.join(",") < bestOrder.join(","))))
    ) {
      bestOrder = order;
      bestTravel = travel;
    }
  }

  const assigned = new Set(bestOrder ?? []);
  const leftover = tasks.filter((task) => !assigned.has(task.taskId)).map((task) => task.taskId);
  return [...(bestOrder ?? []), ...leftover];
}

function buildVisitOrder(args: {
  input: RoutingProblemInput;
  driver: DriverNode;
  tasks: TaskNode[];
  firstTaskId: TaskId;
  preferUrgent: boolean;
  lockFirst?: boolean;
}): TaskId[] {
  if (args.tasks.length === 0) return [];
  const remaining = new Map(args.tasks.map((task) => [task.taskId, task]));
  const forcedFirst = remaining.get(args.firstTaskId);
  const firstSteals =
    !args.lockFirst &&
    forcedFirst != null &&
    wouldStrandUrgentTask({
      input: args.input,
      candidate: forcedFirst,
      remaining: args.tasks,
      fromNodeIndex: DEPOT_NODE_INDEX,
      fromEndMin: args.driver.workWindow.startMin,
    });
  const first =
    forcedFirst && !firstSteals
      ? forcedFirst
      : pickNextStop({
          input: args.input,
          remaining: args.tasks,
          fromNodeIndex: DEPOT_NODE_INDEX,
          fromEndMin: args.driver.workWindow.startMin,
          preferUrgent: args.preferUrgent,
        });
  if (!first) return [];

  remaining.delete(first.taskId);
  const order: TaskId[] = [first.taskId];
  let last = first;
  let endMin =
    projectedStartMin({
      input: args.input,
      fromNodeIndex: DEPOT_NODE_INDEX,
      fromEndMin: args.driver.workWindow.startMin,
      task: first,
    }) + first.serviceDurationMin;

  while (remaining.size > 0) {
    const next = pickNextStop({
      input: args.input,
      remaining: [...remaining.values()],
      fromNodeIndex: last.nodeIndex,
      fromEndMin: endMin,
      preferUrgent: args.preferUrgent,
    });
    if (!next) break;
    remaining.delete(next.taskId);
    order.push(next.taskId);
    endMin =
      projectedStartMin({
        input: args.input,
        fromNodeIndex: last.nodeIndex,
        fromEndMin: endMin,
        task: next,
      }) + next.serviceDurationMin;
    last = next;
  }

  const assigned = new Set(order);
  for (const task of args.tasks) {
    if (!assigned.has(task.taskId)) order.push(task.taskId);
  }
  return order;
}

function constraintGreedyOrder(args: {
  input: RoutingProblemInput;
  driver: DriverNode;
  tasks: TaskNode[];
  firstTask?: TaskNode;
}): TaskId[] {
  if (args.tasks.length === 0) return [];
  const remaining = new Map(args.tasks.map((task) => [task.taskId, task]));
  const first =
    args.firstTask && remaining.has(args.firstTask.taskId)
      ? args.firstTask
      : pickConstraintStop({
          input: args.input,
          driver: args.driver,
          remaining: args.tasks,
          fromNodeIndex: DEPOT_NODE_INDEX,
          fromEndMin: args.driver.workWindow.startMin,
        });
  if (!first) return args.tasks.map((task) => task.taskId);

  remaining.delete(first.taskId);
  const order: TaskId[] = [first.taskId];
  let last = first;
  let endMin =
    projectedStartMin({
      input: args.input,
      fromNodeIndex: DEPOT_NODE_INDEX,
      fromEndMin: args.driver.workWindow.startMin,
      task: first,
    }) + first.serviceDurationMin;

  while (remaining.size > 0) {
    const next = pickConstraintStop({
      input: args.input,
      driver: args.driver,
      remaining: [...remaining.values()],
      fromNodeIndex: last.nodeIndex,
      fromEndMin: endMin,
    });
    if (!next) break;
    remaining.delete(next.taskId);
    order.push(next.taskId);
    endMin =
      projectedStartMin({
        input: args.input,
        fromNodeIndex: last.nodeIndex,
        fromEndMin: endMin,
        task: next,
      }) + next.serviceDurationMin;
    last = next;
  }

  for (const task of args.tasks) {
    if (!order.includes(task.taskId)) order.push(task.taskId);
  }
  return order;
}

function scoreConstraintViolations(args: {
  input: RoutingProblemInput;
  driver: DriverNode;
  order: TaskId[];
  taskById: Map<TaskId, TaskNode>;
}): number {
  const route = simulateRouteTimingAllowingViolations({
    input: args.input,
    driver: args.driver,
    orderedTaskIds: args.order,
    taskById: args.taskById,
  });
  if (!route) return Number.POSITIVE_INFINITY;

  let score = 0;
  for (const stop of route.stops) {
    const task = args.taskById.get(stop.taskId);
    if (!task) {
      score += 1000;
      continue;
    }
    const startOver = Math.max(0, stop.startMin - task.hardWindow.latestStartMin);
    const endOver = Math.max(0, stop.endMin - task.hardWindow.latestEndMin);
    const shiftOver = Math.max(0, stop.endMin - args.driver.workWindow.endMin);
    const weight = urgencyRank(task) === 0 ? 8 : urgencyRank(task) === 3 ? 1 : 3;
    score += (startOver + endOver + shiftOver) * weight;
  }
  return score;
}

function relocateToReduceViolations(args: {
  input: RoutingProblemInput;
  driver: DriverNode;
  order: TaskId[];
  taskById: Map<TaskId, TaskNode>;
  freezeFirst?: boolean;
}): TaskId[] {
  let best = [...args.order];
  let bestScore = scoreConstraintViolations({ ...args, order: best });
  if (bestScore === 0 || best.length < 2) return best;
  const minIndex = args.freezeFirst ? 1 : 0;

  for (let pass = 0; pass < 8 && bestScore > 0; pass += 1) {
    let improved = false;
    for (let from = minIndex; from < best.length; from += 1) {
      for (let to = minIndex; to < best.length; to += 1) {
        if (from === to) continue;
        const next = [...best];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        const score = scoreConstraintViolations({ ...args, order: next });
        if (score + 0.01 < bestScore) {
          best = next;
          bestScore = score;
          improved = true;
          if (bestScore === 0) return best;
        }
      }
    }
    if (!improved) break;
  }
  return best;
}

function buildPriorityCompleteOrder(args: {
  input: RoutingProblemInput;
  driver: DriverNode;
  tasks: TaskNode[];
  taskById: Map<TaskId, TaskNode>;
  firstTaskId?: TaskId;
}): TaskId[] {
  const firstTask =
    args.firstTaskId != null
      ? args.tasks.find((task) => task.taskId === args.firstTaskId)
      : undefined;
  let order = constraintGreedyOrder({
    input: args.input,
    driver: args.driver,
    tasks: args.tasks,
    firstTask,
  });
  let score = scoreConstraintViolations({ ...args, order });
  if (score === 0) return order;

  if (!firstTask) {
    const beam = findBestFeasibleSequence({
      input: args.input,
      driver: args.driver,
      taskIds: args.tasks.map((task) => task.taskId),
      taskById: args.taskById,
      subZoneByTaskId: new Map(),
      ranking: "schedule-first",
    });
    if (beam && beam.order.length === args.tasks.length) {
      const beamScore = scoreConstraintViolations({ ...args, order: beam.order });
      if (beamScore < score) {
        order = beam.order;
        score = beamScore;
      }
    } else if (beam && beam.order.length > 0) {
      const mixed = [
        ...beam.order,
        ...order.filter((taskId) => !beam.order.includes(taskId)),
      ];
      const mixedScore = scoreConstraintViolations({ ...args, order: mixed });
      if (mixedScore < score) {
        order = mixed;
        score = mixedScore;
      }
    }
  }

  if (score === 0) return order;
  return relocateToReduceViolations({ ...args, order, freezeFirst: firstTask != null });
}

function sequenceZone(args: {
  input: RoutingProblemInput;
  driver: DriverNode;
  zone: ExclusiveWorkZoneSpec;
  profileId: LogisticsHypothesisId;
  firstTaskId: TaskId | undefined;
  lockFirstStop?: boolean;
  taskById: Map<TaskId, TaskNode>;
}): { route: RoutingRouteSolution | null; dropped: TaskId[] } {
  const tasks = args.zone.taskIds
    .map((taskId) => args.taskById.get(taskId))
    .filter((task): task is TaskNode => task !== undefined);
  if (tasks.length === 0) return { route: null, dropped: [] };

  const lockedStart =
    args.lockFirstStop === true &&
    args.firstTaskId != null &&
    tasks.some((task) => task.taskId === args.firstTaskId)
      ? args.firstTaskId
      : undefined;

  const order =
    args.profileId === "proximity-strict"
      ? buildProximityTour({ input: args.input, tasks, startTaskId: lockedStart })
      : args.profileId === "priority-strict"
        ? buildPriorityCompleteOrder({
            input: args.input,
            driver: args.driver,
            tasks,
            taskById: args.taskById,
            firstTaskId: lockedStart,
          })
        : buildVisitOrder({
            input: args.input,
            driver: args.driver,
            tasks,
            firstTaskId: lockedStart ?? args.firstTaskId ?? tasks[0].taskId,
            preferUrgent: false,
            lockFirst: lockedStart != null,
          });

  const strictRoute =
    args.profileId === "priority-strict"
      ? simulateRouteTiming({
          input: args.input,
          driver: args.driver,
          orderedTaskIds: order,
          taskById: args.taskById,
        })
      : null;
  const route =
    strictRoute ??
    simulateRouteTimingAllowingViolations({
      input: args.input,
      driver: args.driver,
      orderedTaskIds: order,
      taskById: args.taskById,
    });
  return { route, dropped: route ? [] : order };
}

function countWindowViolations(
  input: RoutingProblemInput,
  solution: RoutingSolution
): number {
  const taskById = new Map(input.tasks.map((task) => [task.taskId, task]));
  let count = 0;
  for (const route of solution.routes) {
    for (const stop of route.stops) {
      const task = taskById.get(stop.taskId);
      if (!task) continue;
      if (stop.startMin > task.hardWindow.latestStartMin) count += 1;
      else if (stop.endMin > task.hardWindow.latestEndMin) count += 1;
    }
  }
  return count;
}

function buildSolutionFromRoutes(args: {
  input: RoutingProblemInput;
  routes: RoutingRouteSolution[];
  dropped: RoutingDroppedTask[];
  profileId: LogisticsHypothesisId;
}): RoutingSolution {
  const assigned = new Set(args.routes.flatMap((route) => route.stops.map((stop) => stop.taskId)));
  const droppedTasks = [...args.dropped];
  const droppedIds = new Set(droppedTasks.map((dropped) => dropped.taskId));
  for (const task of args.input.tasks) {
    if (!assigned.has(task.taskId) && !droppedIds.has(task.taskId)) {
      droppedTasks.push({ taskId: task.taskId, reason: "NO_FEASIBLE_DRIVER" });
    }
  }

  const assignedTaskCount = args.routes.reduce((sum, route) => sum + route.stops.length, 0);
  const totalTravelMin = args.routes.reduce((sum, route) => sum + route.totalTravelMin, 0);
  const totalWaitMin = args.routes.reduce((sum, route) => sum + route.totalWaitMin, 0);

  return {
    schemaVersion: ROUTING_SOLUTION_SCHEMA_VERSION,
    solverId: ORTOOLS_SOLVER_ID,
    workDate: args.input.workDate,
    status:
      assignedTaskCount === 0 ? "INFEASIBLE" : droppedTasks.length > 0 ? "PARTIAL" : "FEASIBLE",
    generatedAt: new Date().toISOString(),
    routes: args.routes.sort((left, right) => left.driverId - right.driverId),
    droppedTasks,
    objectiveBreakdown: {
      assignedTasks: assignedTaskCount,
      droppedTasks: droppedTasks.length,
      totalTravelMin,
      totalWaitMin,
    },
    diagnostics: {
      warnings: [],
      notes: [`routing-hypothesis:${args.profileId}`],
    },
  };
}

function buildSummary(args: {
  profileId: LogisticsHypothesisId;
  input: RoutingProblemInput;
  solution: RoutingSolution;
  zones: ExclusiveWorkZoneSpec[];
}): LogisticsHypothesisSummary {
  const meta = logisticsHypothesisProfileById(args.profileId);
  const zoneByDriver = new Map(args.zones.map((zone) => [zone.driverId, zone]));
  const taskById = new Map(args.input.tasks.map((task) => [task.taskId, task]));

  return {
    id: args.profileId,
    title: meta.title,
    description: meta.description,
    assignedTaskCount: args.solution.objectiveBreakdown?.assignedTasks ?? 0,
    droppedTaskCount: args.solution.droppedTasks.length,
    totalTravelMin: args.solution.objectiveBreakdown?.totalTravelMin ?? 0,
    totalWaitMin: args.solution.objectiveBreakdown?.totalWaitMin ?? 0,
    windowViolationCount: countWindowViolations(args.input, args.solution),
    zoneCount: args.zones.length,
    routes: args.solution.routes.map((route) => {
      const codes = route.stops.map((stop) => taskById.get(stop.taskId)?.logisticCode ?? stop.taskId);
      return {
        driverId: route.driverId,
        zoneLabel: zoneByDriver.get(route.driverId)?.label ?? `Driver ${route.driverId}`,
        logisticCodes: codes,
        travelMin: route.totalTravelMin,
        startMin: route.startMin,
        endMin: route.endMin,
        firstLogisticCode: codes[0] ?? null,
      };
    }),
  };
}

function fallbackSingleZone(input: RoutingProblemInput): ExclusiveWorkZoneSpec[] {
  if (input.drivers.length === 0) return [];
  return [
    {
      zoneIndex: 0,
      zoneId: "exclusive-zone:0",
      label: "Zona 1",
      driverId: input.drivers[0].id,
      taskIds: input.tasks.map((task) => task.taskId),
      centroid: { lat: 0, lng: 0 },
      color: "#4575b4",
    },
  ];
}

function applyDriverIdByZoneIndex(args: {
  zones: ExclusiveWorkZoneSpec[];
  driverIdByZoneIndex?: ReadonlyMap<number, number>;
  validDriverIds: Set<number>;
}): ExclusiveWorkZoneSpec[] {
  const override = args.driverIdByZoneIndex;
  if (!override || override.size === 0) return args.zones;
  const next = args.zones.map((zone) => {
    const driverId = override.get(zone.zoneIndex);
    if (driverId == null || !args.validDriverIds.has(driverId)) return zone;
    return { ...zone, driverId };
  });
  const assigned = next.map((zone) => zone.driverId);
  if (new Set(assigned).size !== assigned.length) return args.zones;
  return next;
}

export function generateLogisticsRoutingHypotheses(
  input: RoutingProblemInput,
  options?: {
    preferredStartByDriverId?: ReadonlyMap<number, number>;
    driverIdByZoneIndex?: ReadonlyMap<number, number>;
  }
): LogisticsRoutingHypothesis[] {
  const partitioned = partitionExclusiveWorkZones(input);
  const baseZones = partitioned.length > 0 ? partitioned : fallbackSingleZone(input);
  const taskById = new Map(input.tasks.map((task) => [task.taskId, task]));
  const driverById = new Map(input.drivers.map((driver) => [driver.id, driver]));
  const zones = applyDriverIdByZoneIndex({
    zones: baseZones,
    driverIdByZoneIndex: options?.driverIdByZoneIndex,
    validDriverIds: new Set(input.drivers.map((driver) => driver.id)),
  });

  const firstStopsByZone = new Map<number, Partial<Record<LogisticsHypothesisId, TaskId>>>();
  for (const zone of zones) {
    const zoneTasks = zone.taskIds
      .map((taskId) => taskById.get(taskId))
      .filter((task): task is TaskNode => task !== undefined);
    const zoneDriver = driverById.get(zone.driverId);
    if (!zoneDriver) continue;
    firstStopsByZone.set(
      zone.zoneIndex,
      pickDistinctFirstStops({ tasks: zoneTasks, input, driver: zoneDriver })
    );
  }

  return LOGISTICS_HYPOTHESIS_IDS.map((profileId) => {
    const routes: RoutingRouteSolution[] = [];
    const dropped: RoutingDroppedTask[] = [];

    for (const zone of zones) {
      const driver = driverById.get(zone.driverId);
      if (!driver) {
        for (const taskId of zone.taskIds) {
          dropped.push({ taskId, reason: "NO_FEASIBLE_DRIVER" });
        }
        continue;
      }
      const preferredStart = options?.preferredStartByDriverId?.get(zone.driverId);
      const lockFirstStop =
        preferredStart != null && zone.taskIds.includes(preferredStart);
      const sequenced = sequenceZone({
        input,
        driver,
        zone,
        profileId,
        firstTaskId: lockFirstStop
          ? preferredStart
          : firstStopsByZone.get(zone.zoneIndex)?.[profileId],
        lockFirstStop,
        taskById,
      });
      if (sequenced.route) routes.push(sequenced.route);
      for (const taskId of sequenced.dropped) {
        dropped.push({ taskId, reason: "OUTSIDE_TIME_WINDOWS" });
      }
    }

    const solution = buildSolutionFromRoutes({
      input,
      routes,
      dropped,
      profileId,
    });
    return {
      summary: buildSummary({ profileId, input, solution, zones }),
      solution,
    };
  });
}
