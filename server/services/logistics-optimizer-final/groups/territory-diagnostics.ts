import type { DriverId, RoutingProblemInput, TaskId, TaskNode } from "../input-contract";
import type { RoutingSolution } from "../solution-contract";
import { haversineMeters } from "./geo-utils";

export interface TerritoryDiagnostics {
  territoryMode: "historical_template_3_drivers" | "dynamic_clustering" | null;
  profiles: Array<{
    territoryKey: string;
    label?: string;
    assignedDriverId: DriverId;
    taskCount: number;
    coreTasks: number;
    borderTasks: number;
  }> | null;
  routeTerritoryPurity: Array<{
    driverId: DriverId;
    dominantTerritory: number | null;
    purity: number;
    tasksInDominant: number;
    tasksOutside: number;
  }>;
  territorySplits: Array<{
    territoryId: string;
    territoryIndex: number;
    assignedDriverId: DriverId;
    primaryDriverTaskCount: number;
    otherDriverTaskCount: number;
    splitRatio: number;
  }>;
  crossTerritoryTransitions: Array<{ driverId: DriverId; count: number }>;
  crossDriverOverlapPairsWithin1Km: {
    count: number;
    pairs: Array<{
      taskIdA: TaskId;
      taskIdB: TaskId;
      driverIdA: DriverId;
      driverIdB: DriverId;
      distanceMeters: number;
    }>;
  };
  requiredDriverTerritoryConflicts: Array<{
    taskId: TaskId;
    territoryAssignedDriverId: DriverId;
    requiredDriverId: DriverId;
    territoryIndex: number;
  }>;
  solverTerritoryViolations: Array<{
    taskId: TaskId;
    territoryIndex: number;
    preferredDriverId: DriverId;
    actualDriverId: DriverId;
  }>;
}

function buildRequiredDriverByTaskId(input: RoutingProblemInput): Map<TaskId, DriverId> {
  const requiredDriverByTaskId = new Map<TaskId, DriverId>();
  for (const constraint of input.hardConstraints) {
    if (constraint.type === "REQUIRED_DRIVER_TASK") {
      requiredDriverByTaskId.set(constraint.taskId, constraint.driverId);
    }
  }
  return requiredDriverByTaskId;
}

function taskTerritoryMaps(input: RoutingProblemInput): {
  territoryByTaskId: Map<TaskId, number>;
  preferredDriverByTaskId: Map<TaskId, DriverId>;
} {
  const assignment = input.metadata.dailyTerritoryAssignment;
  return {
    territoryByTaskId: new Map(
      assignment?.taskTerritoryIndex.map((entry) => [entry.taskId, entry.territoryIndex]) ?? []
    ),
    preferredDriverByTaskId: new Map(
      assignment?.taskPreferredDriverId.map((entry) => [entry.taskId, entry.driverId]) ?? []
    ),
  };
}

function assignedDriverByTaskId(solution: RoutingSolution | undefined): Map<TaskId, DriverId> {
  const assignments = new Map<TaskId, DriverId>();
  for (const route of solution?.routes ?? []) {
    for (const stop of route.stops) {
      assignments.set(stop.taskId, route.driverId);
    }
  }
  return assignments;
}

function routePurity(
  solution: RoutingSolution | undefined,
  territoryByTaskId: Map<TaskId, number>
): TerritoryDiagnostics["routeTerritoryPurity"] {
  if (!solution) return [];

  return solution.routes.map((route) => {
    const counts = new Map<number, number>();
    for (const stop of route.stops) {
      const territoryIndex = territoryByTaskId.get(stop.taskId);
      if (territoryIndex === undefined) continue;
      counts.set(territoryIndex, (counts.get(territoryIndex) ?? 0) + 1);
    }

    let dominantTerritory: number | null = null;
    let tasksInDominant = 0;
    for (const [territoryIndex, count] of counts.entries()) {
      if (count > tasksInDominant) {
        dominantTerritory = territoryIndex;
        tasksInDominant = count;
      }
    }

    const totalStops = route.stops.length;
    return {
      driverId: route.driverId,
      dominantTerritory,
      purity: totalStops > 0 ? tasksInDominant / totalStops : 0,
      tasksInDominant,
      tasksOutside: Math.max(0, totalStops - tasksInDominant),
    };
  });
}

function territorySplits(
  input: RoutingProblemInput,
  solution: RoutingSolution | undefined,
  assignedDriverByTask: Map<TaskId, DriverId>
): TerritoryDiagnostics["territorySplits"] {
  const assignment = input.metadata.dailyTerritoryAssignment;
  if (!assignment) return [];

  return assignment.territories.map((territory) => {
    let primaryDriverTaskCount = 0;
    let otherDriverTaskCount = 0;
    for (const taskId of territory.taskIds) {
      const assignedDriverId = assignedDriverByTask.get(taskId);
      if (assignedDriverId === undefined && solution) continue;
      if ((assignedDriverId ?? territory.assignedDriverId) === territory.assignedDriverId) {
        primaryDriverTaskCount += 1;
      } else {
        otherDriverTaskCount += 1;
      }
    }
    const total = primaryDriverTaskCount + otherDriverTaskCount;
    return {
      territoryId: territory.territoryId,
      territoryIndex: territory.territoryIndex,
      assignedDriverId: territory.assignedDriverId,
      primaryDriverTaskCount,
      otherDriverTaskCount,
      splitRatio: total > 0 ? otherDriverTaskCount / total : 0,
    };
  });
}

function crossTerritoryTransitions(
  solution: RoutingSolution | undefined,
  territoryByTaskId: Map<TaskId, number>
): TerritoryDiagnostics["crossTerritoryTransitions"] {
  if (!solution) return [];

  return solution.routes.map((route) => {
    let count = 0;
    let previousTerritory: number | undefined;
    for (const stop of route.stops) {
      const territoryIndex = territoryByTaskId.get(stop.taskId);
      if (territoryIndex !== undefined && previousTerritory !== undefined && territoryIndex !== previousTerritory) {
        count += 1;
      }
      if (territoryIndex !== undefined) previousTerritory = territoryIndex;
    }
    return { driverId: route.driverId, count };
  });
}

function crossDriverOverlapPairsWithin1Km(
  input: RoutingProblemInput,
  assignedDriverByTask: Map<TaskId, DriverId>
): TerritoryDiagnostics["crossDriverOverlapPairsWithin1Km"] {
  const taskById = new Map(input.tasks.map((task) => [task.taskId, task]));
  const assignedEntries = [...assignedDriverByTask.entries()].sort((left, right) => left[0] - right[0]);
  const pairs: TerritoryDiagnostics["crossDriverOverlapPairsWithin1Km"]["pairs"] = [];

  for (let leftIndex = 0; leftIndex < assignedEntries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < assignedEntries.length; rightIndex += 1) {
      const [taskIdA, driverIdA] = assignedEntries[leftIndex];
      const [taskIdB, driverIdB] = assignedEntries[rightIndex];
      if (driverIdA === driverIdB) continue;
      const taskA = taskById.get(taskIdA);
      const taskB = taskById.get(taskIdB);
      if (!taskA || !taskB) continue;
      const distanceMeters = distanceBetweenTasks(taskA, taskB);
      if (distanceMeters <= 1000) {
        pairs.push({ taskIdA, taskIdB, driverIdA, driverIdB, distanceMeters });
      }
    }
  }

  return { count: pairs.length, pairs };
}

function distanceBetweenTasks(taskA: TaskNode, taskB: TaskNode): number {
  return haversineMeters(
    taskA.location.lat,
    taskA.location.lng,
    taskB.location.lat,
    taskB.location.lng
  );
}

function requiredDriverTerritoryConflicts(
  input: RoutingProblemInput,
  preferredDriverByTaskId: Map<TaskId, DriverId>,
  territoryByTaskId: Map<TaskId, number>
): TerritoryDiagnostics["requiredDriverTerritoryConflicts"] {
  const requiredDriverByTaskId = buildRequiredDriverByTaskId(input);
  const conflicts: TerritoryDiagnostics["requiredDriverTerritoryConflicts"] = [];

  for (const [taskId, requiredDriverId] of requiredDriverByTaskId.entries()) {
    const territoryAssignedDriverId = preferredDriverByTaskId.get(taskId);
    const territoryIndex = territoryByTaskId.get(taskId);
    if (
      territoryAssignedDriverId !== undefined &&
      territoryIndex !== undefined &&
      territoryAssignedDriverId !== requiredDriverId
    ) {
      conflicts.push({ taskId, territoryAssignedDriverId, requiredDriverId, territoryIndex });
    }
  }

  return conflicts;
}

function solverTerritoryViolations(
  solution: RoutingSolution | undefined,
  preferredDriverByTaskId: Map<TaskId, DriverId>,
  territoryByTaskId: Map<TaskId, number>
): TerritoryDiagnostics["solverTerritoryViolations"] {
  if (!solution) return [];

  const violations: TerritoryDiagnostics["solverTerritoryViolations"] = [];
  for (const route of solution.routes) {
    for (const stop of route.stops) {
      const preferredDriverId = preferredDriverByTaskId.get(stop.taskId);
      const territoryIndex = territoryByTaskId.get(stop.taskId);
      if (
        preferredDriverId !== undefined &&
        territoryIndex !== undefined &&
        route.driverId !== preferredDriverId
      ) {
        violations.push({
          taskId: stop.taskId,
          territoryIndex,
          preferredDriverId,
          actualDriverId: route.driverId,
        });
      }
    }
  }
  return violations.sort((left, right) => left.taskId - right.taskId);
}

export function computeTerritoryDiagnostics(
  input: RoutingProblemInput,
  solution?: RoutingSolution
): TerritoryDiagnostics | null {
  if (!input.metadata.dailyTerritoryAssignment) {
    return null;
  }

  const { territoryByTaskId, preferredDriverByTaskId } = taskTerritoryMaps(input);
  const assignedDriverByTask = assignedDriverByTaskId(solution);
  const assignment = input.metadata.dailyTerritoryAssignment;

  return {
    territoryMode: assignment?.territoryMode ?? null,
    profiles: assignment?.profiles ?? null,
    routeTerritoryPurity: routePurity(solution, territoryByTaskId),
    territorySplits: territorySplits(input, solution, assignedDriverByTask),
    crossTerritoryTransitions: crossTerritoryTransitions(solution, territoryByTaskId),
    crossDriverOverlapPairsWithin1Km: crossDriverOverlapPairsWithin1Km(input, assignedDriverByTask),
    requiredDriverTerritoryConflicts: requiredDriverTerritoryConflicts(
      input,
      preferredDriverByTaskId,
      territoryByTaskId
    ),
    solverTerritoryViolations: solverTerritoryViolations(
      solution,
      preferredDriverByTaskId,
      territoryByTaskId
    ),
  };
}
