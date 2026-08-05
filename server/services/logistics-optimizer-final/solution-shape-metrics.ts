import type { RoutingProblemInput, TaskId } from "./input-contract";
import type { RoutingSolution } from "./solution-contract";
import { buildSubZoneLookup, type SubZoneAssignment } from "./route-polishing";

/**
 * Slack below this many minutes makes a route practically unrunnable: any small travel
 * deviation breaks a hard window. Used to stop the comparator from trading robustness
 * for a couple of travel minutes.
 */
export const MIN_ROBUST_SLACK_MIN = 3;

export interface RouteShapeMetrics {
  driverId: number;
  taskCount: number;
  compressedBucketSequence: string[];
  compressedBucketCount: number;
  subZoneRevisitCount: number;
  crossTerritoryTransitionCount: number;
  directionReversalCount: number;
  territoryViolationCount: number;
  totalTravelMin: number;
  totalWaitMin: number;
  worstSlackMin: number;
  endMin: number;
}

export interface SolutionShapeMetrics {
  requiredDroppedCount: number;
  droppedTaskCount: number;
  territoryViolationCount: number;
  crossTerritoryTransitionCount: number;
  subZoneRevisitCount: number;
  directionReversalCount: number;
  totalTravelMin: number;
  totalWaitMin: number;
  worstSlackMin: number;
  routes: RouteShapeMetrics[];
}

function requiredDriverByTaskId(input: RoutingProblemInput): Map<TaskId, number> {
  const required = new Map<TaskId, number>();
  for (const constraint of input.hardConstraints) {
    if (constraint.type === "REQUIRED_DRIVER_TASK") {
      required.set(constraint.taskId, constraint.driverId);
    }
  }
  return required;
}

function preferredDriverByTaskId(input: RoutingProblemInput): Map<TaskId, number> {
  const assignment = input.metadata.dailyTerritoryAssignment;
  if (!assignment) return new Map();
  return new Map(assignment.taskPreferredDriverId.map((entry) => [entry.taskId, entry.driverId]));
}

function compressBuckets(
  taskIds: TaskId[],
  subZoneByTaskId: Map<TaskId, SubZoneAssignment>
): SubZoneAssignment[] {
  const compressed: SubZoneAssignment[] = [];
  for (const taskId of taskIds) {
    const subZone = subZoneByTaskId.get(taskId);
    if (!subZone) continue;
    const previous = compressed[compressed.length - 1];
    if (
      !previous ||
      previous.territoryIndex !== subZone.territoryIndex ||
      previous.bucketLabel !== subZone.bucketLabel
    ) {
      compressed.push(subZone);
    }
  }
  return compressed;
}

function countDirectionReversals(compressed: SubZoneAssignment[]): number {
  const bucketIndexesByTerritory = new Map<number, number[]>();
  for (const subZone of compressed) {
    const bucketIndexes = bucketIndexesByTerritory.get(subZone.territoryIndex) ?? [];
    bucketIndexes.push(subZone.bucketIndex);
    bucketIndexesByTerritory.set(subZone.territoryIndex, bucketIndexes);
  }

  let reversals = 0;
  for (const bucketIndexes of bucketIndexesByTerritory.values()) {
    let previousStepSign = 0;
    for (let index = 1; index < bucketIndexes.length; index += 1) {
      const delta = bucketIndexes[index] - bucketIndexes[index - 1];
      if (delta === 0) continue;
      const stepSign = delta > 0 ? 1 : -1;
      if (previousStepSign !== 0 && stepSign !== previousStepSign) reversals += 1;
      previousStepSign = stepSign;
    }
  }
  return reversals;
}

export function computeSolutionShapeMetrics(
  input: RoutingProblemInput,
  solution: RoutingSolution
): SolutionShapeMetrics {
  const subZoneByTaskId = buildSubZoneLookup(input);
  const taskById = new Map(input.tasks.map((task) => [task.taskId, task]));
  const required = requiredDriverByTaskId(input);
  const preferred = preferredDriverByTaskId(input);

  const routes: RouteShapeMetrics[] = [];
  let worstSlackMin = Number.POSITIVE_INFINITY;

  for (const route of solution.routes) {
    const taskIds = route.stops.map((stop) => stop.taskId);
    const compressed = compressBuckets(taskIds, subZoneByTaskId);

    const blockCountByBucket = new Map<string, number>();
    let subZoneRevisitCount = 0;
    for (const subZone of compressed) {
      const key = `${subZone.territoryIndex}:${subZone.bucketLabel}`;
      const previousBlocks = blockCountByBucket.get(key) ?? 0;
      if (previousBlocks > 0) subZoneRevisitCount += 1;
      blockCountByBucket.set(key, previousBlocks + 1);
    }

    let crossTerritoryTransitionCount = 0;
    for (let index = 1; index < compressed.length; index += 1) {
      if (compressed[index].territoryIndex !== compressed[index - 1].territoryIndex) {
        crossTerritoryTransitionCount += 1;
      }
    }

    let territoryViolationCount = 0;
    let routeWorstSlackMin = Number.POSITIVE_INFINITY;
    for (const stop of route.stops) {
      const preferredDriverId = required.get(stop.taskId) ?? preferred.get(stop.taskId);
      if (preferredDriverId !== undefined && preferredDriverId !== route.driverId) {
        territoryViolationCount += 1;
      }

      const task = taskById.get(stop.taskId);
      if (task) {
        routeWorstSlackMin = Math.min(
          routeWorstSlackMin,
          task.hardWindow.latestStartMin - stop.startMin
        );
      }
    }

    if (Number.isFinite(routeWorstSlackMin)) {
      worstSlackMin = Math.min(worstSlackMin, routeWorstSlackMin);
    }

    routes.push({
      driverId: route.driverId,
      taskCount: route.stops.length,
      compressedBucketSequence: compressed.map(
        (subZone) => `${subZone.territoryKey}:${subZone.bucketLabel}`
      ),
      compressedBucketCount: compressed.length,
      subZoneRevisitCount,
      crossTerritoryTransitionCount,
      directionReversalCount: countDirectionReversals(compressed),
      territoryViolationCount,
      totalTravelMin: route.totalTravelMin,
      totalWaitMin: route.totalWaitMin,
      worstSlackMin: Number.isFinite(routeWorstSlackMin) ? routeWorstSlackMin : 0,
      endMin: route.endMin,
    });
  }

  const requiredDroppedCount = solution.droppedTasks.filter((dropped) =>
    required.has(dropped.taskId)
  ).length;

  const sumBy = (selector: (route: RouteShapeMetrics) => number): number =>
    routes.reduce((sum, route) => sum + selector(route), 0);

  return {
    requiredDroppedCount,
    droppedTaskCount: solution.droppedTasks.length,
    territoryViolationCount: sumBy((route) => route.territoryViolationCount),
    crossTerritoryTransitionCount: sumBy((route) => route.crossTerritoryTransitionCount),
    subZoneRevisitCount: sumBy((route) => route.subZoneRevisitCount),
    directionReversalCount: sumBy((route) => route.directionReversalCount),
    totalTravelMin: sumBy((route) => route.totalTravelMin),
    totalWaitMin: sumBy((route) => route.totalWaitMin),
    worstSlackMin: Number.isFinite(worstSlackMin) ? worstSlackMin : 0,
    routes,
  };
}

/**
 * Two plans whose driving times differ by no more than this are treated as equally
 * cheap, and the tidier sequence wins. Beyond it, fuel decides.
 */
export const TRAVEL_EQUIVALENCE_BAND_MIN = 3;

/**
 * Coverage and territory rules come first because they are commitments, not
 * preferences. After that the objective is fuel: driving time outranks the shape
 * counters, which are only proxies for a route that wastes kilometres. They still
 * decide whenever two plans drive practically the same distance, which is what makes
 * the result sequential without paying for it.
 */
export function compareSolutionShape(
  left: SolutionShapeMetrics,
  right: SolutionShapeMetrics
): number {
  const commitments: Array<[number, number]> = [
    [left.requiredDroppedCount, right.requiredDroppedCount],
    [left.droppedTaskCount, right.droppedTaskCount],
    [left.territoryViolationCount, right.territoryViolationCount],
    [left.crossTerritoryTransitionCount, right.crossTerritoryTransitionCount],
  ];

  for (const [leftValue, rightValue] of commitments) {
    if (leftValue !== rightValue) return leftValue - rightValue;
  }

  const travelGap = left.totalTravelMin - right.totalTravelMin;
  if (Math.abs(travelGap) > TRAVEL_EQUIVALENCE_BAND_MIN) return travelGap;

  const shapeTerms: Array<[number, number]> = [
    [left.subZoneRevisitCount, right.subZoneRevisitCount],
    [left.directionReversalCount, right.directionReversalCount],
  ];

  for (const [leftValue, rightValue] of shapeTerms) {
    if (leftValue !== rightValue) return leftValue - rightValue;
  }

  if (travelGap !== 0) return travelGap;
  return right.worstSlackMin - left.worstSlackMin;
}

/**
 * A candidate must not turn an executable plan into a knife-edge one. Only blocks the
 * candidate when the incumbent still had usable slack.
 */
export function degradesRobustness(
  incumbent: SolutionShapeMetrics,
  candidate: SolutionShapeMetrics
): boolean {
  return (
    incumbent.worstSlackMin >= MIN_ROBUST_SLACK_MIN &&
    candidate.worstSlackMin < MIN_ROBUST_SLACK_MIN
  );
}
