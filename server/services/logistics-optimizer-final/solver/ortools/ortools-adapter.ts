import type { DriverNode, RoutingProblemInput, TaskNode } from "../../input-contract";
import {
  ORTOOLS_SOLVER_ID,
  ROUTING_SOLUTION_SCHEMA_VERSION,
  type RoutingDroppedTask,
  type RoutingRouteSolution,
  type RoutingSolution,
} from "../../solution-contract";

const DEPOT_NODE_INDEX = 0;

export const DROP_PENALTY_BY_PRIORITY = {
  EO: 100_000,
  HP: 50_000,
  LP: 25_000,
  default: 10_000,
} as const;

export interface OrToolsSoftTimeWindow {
  taskId: number;
  nodeIndex: number;
  preferredEndMin: number;
  penaltyPerMinLate: number;
}

export interface OrToolsSoftGroupEntry {
  groupId: string;
  taskIds: number[];
  weight: number;
}

export interface OrToolsCleanerSequenceGroup {
  groupId: string;
  orderedTaskIds: number[];
  weight: number;
}

export interface OrToolsRoutingPayload {
  schemaVersion: "logistics-ortools-payload/v2";
  workDate: string;
  travelMatrixMin: number[][];
  costMatrixMin: number[][];
  nodes: Array<{ nodeIndex: number; kind: "DEPOT" | "TASK"; taskId?: number }>;
  vehicles: Array<{
    vehicleIndex: number;
    driverId: number;
    startMin: number;
    endMin: number;
  }>;
  tasks: Array<{
    taskId: number;
    nodeIndex: number;
    serviceDurationMin: number;
    priority: "EO" | "HP" | "LP" | null;
    earliestStartMin: number;
    latestStartMin: number;
    latestEndMin: number;
    requiredDriverId?: number;
    requiredVehicleIndex?: number;
    dropPenalty: number;
  }>;
  softGroups: {
    sameBuildingGroups: OrToolsSoftGroupEntry[];
    nearbyClusterGroups: Array<OrToolsSoftGroupEntry & { maxTravelMin: number }>;
    sameCleanerGroups: OrToolsSoftGroupEntry[];
    priorityCompatibleGroups: OrToolsSoftGroupEntry[];
    cleanerSequenceGroups: OrToolsCleanerSequenceGroup[];
  };
  softTimeWindows: OrToolsSoftTimeWindow[];
  balanceDriverLoadWeight: number;
  options: { timeLimitSec: number };
}

export interface OrToolsRawRoute {
  vehicleIndex: number;
  nodeIndices: number[];
  timeCumuls: number[];
}

export interface OrToolsRawSolution {
  status: "ok" | "infeasible" | "error";
  message?: string;
  ortoolsStatus?: string;
  routes?: OrToolsRawRoute[];
  droppedTaskIds?: number[];
  objectiveValue?: number;
  solveDurationMs?: number;
}

export interface OrToolsAdapterMaps {
  taskIdToNodeIndex: Map<number, number>;
  nodeIndexToTaskId: Map<number, number>;
  driverIdToVehicleIndex: Map<number, number>;
  vehicleIndexToDriverId: Map<number, number>;
  requiredDriverByTaskId: Map<number, number>;
}

function sortDrivers(drivers: DriverNode[]): DriverNode[] {
  return [...drivers].sort((left, right) => left.id - right.id);
}

function getDropPenalty(priority: TaskNode["priority"]): number {
  if (priority === "EO") return DROP_PENALTY_BY_PRIORITY.EO;
  if (priority === "HP") return DROP_PENALTY_BY_PRIORITY.HP;
  if (priority === "LP") return DROP_PENALTY_BY_PRIORITY.LP;
  return DROP_PENALTY_BY_PRIORITY.default;
}

interface ExtractedSoftConstraints {
  softGroups: OrToolsRoutingPayload["softGroups"];
  softTimeWindows: OrToolsSoftTimeWindow[];
  balanceDriverLoadWeight: number;
}

function extractSoftConstraints(input: RoutingProblemInput): ExtractedSoftConstraints {
  const softGroups: OrToolsRoutingPayload["softGroups"] = {
    sameBuildingGroups: [],
    nearbyClusterGroups: [],
    sameCleanerGroups: [],
    priorityCompatibleGroups: [],
    cleanerSequenceGroups: [],
  };
  const softTimeWindows: OrToolsSoftTimeWindow[] = [];
  let balanceDriverLoadWeight = 0;

  const groupById = new Map(input.businessGroups.map((group) => [group.groupId, group]));
  const taskIdToNodeIndex = new Map(input.tasks.map((task) => [task.taskId, task.nodeIndex]));

  for (const constraint of input.softConstraints) {
    if (constraint.type === "MINIMIZE_TOTAL_TRAVEL") continue;

    if (constraint.type === "BALANCE_DRIVER_LOAD") {
      balanceDriverLoadWeight = Math.max(balanceDriverLoadWeight, constraint.weight);
      continue;
    }

    if (constraint.type === "PREFERRED_PRIORITY_WINDOW") {
      const nodeIndex = taskIdToNodeIndex.get(constraint.taskId);
      const preferredEndMin = constraint.endMin ?? constraint.startMin;
      if (nodeIndex !== undefined && Number.isFinite(preferredEndMin)) {
        softTimeWindows.push({
          taskId: constraint.taskId,
          nodeIndex,
          preferredEndMin,
          penaltyPerMinLate: constraint.penaltyPerMinOutside,
        });
      }
      continue;
    }

    if (constraint.type === "KEEP_SAME_COORDINATES_BUILDING_TOGETHER") {
      const group = groupById.get(constraint.groupId);
      if (group && group.type === "SAME_COORDINATES_BUILDING") {
        softGroups.sameBuildingGroups.push({
          groupId: constraint.groupId,
          taskIds: [...group.taskIds],
          weight: constraint.weight,
        });
      }
      continue;
    }

    if (constraint.type === "KEEP_NEARBY_CLUSTER_TOGETHER") {
      const group = groupById.get(constraint.groupId);
      if (group && group.type === "NEARBY_CLUSTER") {
        softGroups.nearbyClusterGroups.push({
          groupId: constraint.groupId,
          taskIds: [...group.taskIds],
          weight: constraint.weight,
          maxTravelMin: constraint.maxTravelMin,
        });
      }
      continue;
    }

    if (constraint.type === "KEEP_SAME_CLEANER_TASKS_TOGETHER") {
      const group = groupById.get(constraint.groupId);
      if (group && group.type === "SAME_CLEANER") {
        softGroups.sameCleanerGroups.push({
          groupId: constraint.groupId,
          taskIds: [...group.taskIds],
          weight: constraint.weight,
        });
      }
      continue;
    }

    if (constraint.type === "KEEP_PRIORITY_COMPATIBLE_TASKS_TOGETHER") {
      const group = groupById.get(constraint.groupId);
      if (group && group.type === "PRIORITY_COMPATIBLE") {
        softGroups.priorityCompatibleGroups.push({
          groupId: constraint.groupId,
          taskIds: [...group.taskIds],
          weight: constraint.weight,
        });
      }
      continue;
    }

    if (constraint.type === "KEEP_CLEANER_SEQUENCE") {
      const group = groupById.get(constraint.groupId);
      if (group && group.type === "CLEANER_SEQUENCE") {
        softGroups.cleanerSequenceGroups.push({
          groupId: constraint.groupId,
          orderedTaskIds: [...group.orderedTaskIds],
          weight: constraint.weight,
        });
      }
    }
  }

  return { softGroups, softTimeWindows, balanceDriverLoadWeight };
}

function applyIntraGroupCostBonus(
  cost: number[][],
  travelMatrixMin: number[][],
  nodeIndices: number[],
  weight: number,
  maxBonus: number,
  maxTravelMin?: number
): void {
  const bonus = Math.max(1, Math.min(maxBonus, Math.floor(weight / 5)));

  for (const from of nodeIndices) {
    for (const to of nodeIndices) {
      if (from === to) continue;
      if (maxTravelMin !== undefined) {
        const travel = travelMatrixMin[from]?.[to];
        if (!Number.isFinite(travel) || travel > maxTravelMin) continue;
      }
      cost[from][to] = Math.max(0, cost[from][to] - bonus);
    }
  }
}

export function buildCostMatrixMin(
  travelMatrixMin: number[][],
  softGroups: OrToolsRoutingPayload["softGroups"],
  taskIdToNodeIndex: Map<number, number>
): number[][] {
  const size = travelMatrixMin.length;
  const cost = travelMatrixMin.map((row) => [...row]);

  for (const group of softGroups.sameBuildingGroups) {
    const nodeIndices = group.taskIds
      .map((taskId) => taskIdToNodeIndex.get(taskId))
      .filter((nodeIndex): nodeIndex is number => nodeIndex !== undefined);
    applyIntraGroupCostBonus(cost, travelMatrixMin, nodeIndices, group.weight, 20);
  }

  for (const group of softGroups.nearbyClusterGroups) {
    const nodeIndices = group.taskIds
      .map((taskId) => taskIdToNodeIndex.get(taskId))
      .filter((nodeIndex): nodeIndex is number => nodeIndex !== undefined);
    applyIntraGroupCostBonus(
      cost,
      travelMatrixMin,
      nodeIndices,
      group.weight,
      10,
      group.maxTravelMin
    );
  }

  for (const group of softGroups.sameCleanerGroups) {
    const nodeIndices = group.taskIds
      .map((taskId) => taskIdToNodeIndex.get(taskId))
      .filter((nodeIndex): nodeIndex is number => nodeIndex !== undefined);
    applyIntraGroupCostBonus(cost, travelMatrixMin, nodeIndices, group.weight, 15);
  }

  for (const group of softGroups.priorityCompatibleGroups) {
    const nodeIndices = group.taskIds
      .map((taskId) => taskIdToNodeIndex.get(taskId))
      .filter((nodeIndex): nodeIndex is number => nodeIndex !== undefined);
    applyIntraGroupCostBonus(cost, travelMatrixMin, nodeIndices, group.weight, 12);
  }

  for (const group of softGroups.cleanerSequenceGroups) {
    const bonus = Math.max(1, Math.min(15, Math.floor(group.weight / 3)));
    const reversePenalty = Math.max(1, Math.floor(bonus / 2));

    for (let index = 0; index < group.orderedTaskIds.length - 1; index += 1) {
      const fromNode = taskIdToNodeIndex.get(group.orderedTaskIds[index]);
      const toNode = taskIdToNodeIndex.get(group.orderedTaskIds[index + 1]);
      if (fromNode === undefined || toNode === undefined) continue;

      cost[fromNode][toNode] = Math.max(0, cost[fromNode][toNode] - bonus);
      if (fromNode !== toNode) {
        cost[toNode][fromNode] = cost[toNode][fromNode] + reversePenalty;
      }
    }
  }

  return cost;
}

export function buildOrToolsMaps(input: RoutingProblemInput): OrToolsAdapterMaps {
  const sortedDrivers = sortDrivers(input.drivers);
  const taskIdToNodeIndex = new Map<number, number>();
  const nodeIndexToTaskId = new Map<number, number>();
  const driverIdToVehicleIndex = new Map<number, number>();
  const vehicleIndexToDriverId = new Map<number, number>();
  const requiredDriverByTaskId = new Map<number, number>();

  for (const task of input.tasks) {
    taskIdToNodeIndex.set(task.taskId, task.nodeIndex);
    nodeIndexToTaskId.set(task.nodeIndex, task.taskId);
  }

  sortedDrivers.forEach((driver, vehicleIndex) => {
    driverIdToVehicleIndex.set(driver.id, vehicleIndex);
    vehicleIndexToDriverId.set(vehicleIndex, driver.id);
  });

  for (const constraint of input.hardConstraints) {
    if (constraint.type === "REQUIRED_DRIVER_TASK") {
      requiredDriverByTaskId.set(constraint.taskId, constraint.driverId);
    }
  }

  return {
    taskIdToNodeIndex,
    nodeIndexToTaskId,
    driverIdToVehicleIndex,
    vehicleIndexToDriverId,
    requiredDriverByTaskId,
  };
}

export function buildOrToolsPayload(
  input: RoutingProblemInput,
  options?: { timeLimitSec?: number }
): { payload: OrToolsRoutingPayload; maps: OrToolsAdapterMaps } {
  const maps = buildOrToolsMaps(input);
  const sortedDrivers = sortDrivers(input.drivers);
  const { softGroups, softTimeWindows, balanceDriverLoadWeight } = extractSoftConstraints(input);
  const travelMatrixMin = input.travelMatrixMin;
  const costMatrixMin = buildCostMatrixMin(travelMatrixMin, softGroups, maps.taskIdToNodeIndex);

  const nodes = [
    { nodeIndex: DEPOT_NODE_INDEX, kind: "DEPOT" as const },
    ...input.tasks.map((task) => ({
      nodeIndex: task.nodeIndex,
      kind: "TASK" as const,
      taskId: task.taskId,
    })),
  ];

  const vehicles = sortedDrivers.map((driver, vehicleIndex) => ({
    vehicleIndex,
    driverId: driver.id,
    startMin: driver.workWindow.startMin,
    endMin: driver.workWindow.endMin,
  }));

  const tasks = input.tasks.map((task) => {
    const requiredDriverId = maps.requiredDriverByTaskId.get(task.taskId);
    const requiredVehicleIndex =
      requiredDriverId !== undefined
        ? maps.driverIdToVehicleIndex.get(requiredDriverId)
        : undefined;

    return {
      taskId: task.taskId,
      nodeIndex: task.nodeIndex,
      serviceDurationMin: task.serviceDurationMin,
      priority: task.priority,
      earliestStartMin: task.hardWindow.earliestStartMin,
      latestStartMin: task.hardWindow.latestStartMin,
      latestEndMin: task.hardWindow.latestEndMin,
      ...(requiredDriverId !== undefined && requiredVehicleIndex !== undefined
        ? { requiredDriverId, requiredVehicleIndex }
        : {}),
      dropPenalty: getDropPenalty(task.priority),
    };
  });

  return {
    maps,
    payload: {
      schemaVersion: "logistics-ortools-payload/v2",
      workDate: input.workDate,
      travelMatrixMin,
      costMatrixMin,
      nodes,
      vehicles,
      tasks,
      softGroups,
      softTimeWindows,
      balanceDriverLoadWeight,
      options: { timeLimitSec: options?.timeLimitSec ?? 30 },
    },
  };
}

function getTravelMin(matrix: number[][], fromNodeIndex: number, toNodeIndex: number): number | null {
  if (
    fromNodeIndex < 0 ||
    fromNodeIndex >= matrix.length ||
    toNodeIndex < 0 ||
    toNodeIndex >= (matrix[fromNodeIndex]?.length ?? 0)
  ) {
    return null;
  }
  const travel = matrix[fromNodeIndex][toNodeIndex];
  return Number.isFinite(travel) ? travel : null;
}

function resolveSolutionStatus(
  assignedCount: number,
  droppedTasks: RoutingDroppedTask[],
  requiredDriverByTaskId: Map<number, number>
): RoutingSolution["status"] {
  const hasRequiredDropped = droppedTasks.some(
    (dropped) =>
      requiredDriverByTaskId.has(dropped.taskId) && dropped.reason === "REQUIRED_DRIVER_INFEASIBLE"
  );
  if (hasRequiredDropped) return "INVALID";
  if (assignedCount === 0) return "INFEASIBLE";
  if (droppedTasks.length > 0) return "PARTIAL";
  return "FEASIBLE";
}

export function decodeOrToolsSolution(args: {
  input: RoutingProblemInput;
  payload: OrToolsRoutingPayload;
  raw: OrToolsRawSolution;
  maps: OrToolsAdapterMaps;
  generatedAt?: string;
}): RoutingSolution {
  const { input, payload, raw, maps, generatedAt } = args;
  const taskById = new Map(input.tasks.map((task) => [task.taskId, task]));
  const driverById = new Map(input.drivers.map((driver) => [driver.id, driver]));
  const diagnosticsWarnings: string[] = [];
  const droppedTasks: RoutingDroppedTask[] = [];
  const routes: RoutingRouteSolution[] = [];
  const assignedTaskIds = new Set<number>();

  const droppedFromRaw = new Set(raw.droppedTaskIds ?? []);
  for (const taskId of droppedFromRaw) {
    const isRequired = maps.requiredDriverByTaskId.has(taskId);
    droppedTasks.push({
      taskId,
      reason: isRequired ? "REQUIRED_DRIVER_INFEASIBLE" : "NO_FEASIBLE_DRIVER",
    });
  }

  for (const rawRoute of raw.routes ?? []) {
    const driverId = maps.vehicleIndexToDriverId.get(rawRoute.vehicleIndex);
    if (driverId === undefined) continue;
    const driver = driverById.get(driverId);
    if (!driver) continue;

    const stops: RoutingRouteSolution["stops"] = [];
    let previousEndMin = driver.workWindow.startMin;
    let previousTaskId: number | null = null;
    let previousNodeIndex = DEPOT_NODE_INDEX;
    let taskStopSequence = 0;

    for (let index = 0; index < rawRoute.nodeIndices.length; index += 1) {
      const nodeIndex = rawRoute.nodeIndices[index];
      const taskId = maps.nodeIndexToTaskId.get(nodeIndex);
      if (taskId === undefined) {
        if (nodeIndex === DEPOT_NODE_INDEX) {
          previousNodeIndex = DEPOT_NODE_INDEX;
          const depotCumul = rawRoute.timeCumuls[index];
          if (Number.isFinite(depotCumul)) {
            previousEndMin = depotCumul;
          }
        }
        continue;
      }

      const task = taskById.get(taskId);
      if (!task) continue;

      const startMin = rawRoute.timeCumuls[index] ?? task.hardWindow.earliestStartMin;
      const travel = getTravelMin(input.travelMatrixMin, previousNodeIndex, nodeIndex);
      if (travel === null) {
        diagnosticsWarnings.push(`Missing travel matrix for task ${taskId}`);
        continue;
      }

      let arrivalMin = previousEndMin + travel;
      let waitMin = startMin - arrivalMin;

      if (waitMin < 0) {
        diagnosticsWarnings.push(
          `Negative waitMin for task ${taskId}; aligning arrivalMin to startMin for validation`
        );
        arrivalMin = startMin;
        waitMin = 0;
      }

      const endMin = startMin + task.serviceDurationMin;

      if (startMin < task.hardWindow.earliestStartMin || startMin > task.hardWindow.latestStartMin) {
        diagnosticsWarnings.push(`startMin outside hard window for task ${taskId}`);
      }
      if (endMin > task.hardWindow.latestEndMin) {
        diagnosticsWarnings.push(`endMin after latestEndMin for task ${taskId}`);
      }

      taskStopSequence += 1;
      stops.push({
        sequence: taskStopSequence,
        taskId,
        arrivalMin,
        startMin,
        endMin,
        serviceDurationMin: task.serviceDurationMin,
        travelFromPreviousMin: travel,
        waitMin,
        previousTaskId,
      });

      assignedTaskIds.add(taskId);
      previousEndMin = endMin;
      previousTaskId = taskId;
      previousNodeIndex = nodeIndex;
    }

    if (stops.length === 0) continue;

    const totalTravelMin = stops.reduce((sum, stop) => sum + stop.travelFromPreviousMin, 0);
    const totalWaitMin = stops.reduce((sum, stop) => sum + stop.waitMin, 0);
    const totalServiceMin = stops.reduce((sum, stop) => sum + stop.serviceDurationMin, 0);

    routes.push({
      driverId,
      startMin: driver.workWindow.startMin,
      endMin: stops[stops.length - 1].endMin,
      totalServiceMin,
      totalTravelMin,
      totalWaitMin,
      stops,
    });
  }

  for (const task of input.tasks) {
    if (!assignedTaskIds.has(task.taskId) && !droppedFromRaw.has(task.taskId)) {
      const isRequired = maps.requiredDriverByTaskId.has(task.taskId);
      droppedTasks.push({
        taskId: task.taskId,
        reason: isRequired ? "REQUIRED_DRIVER_INFEASIBLE" : "NO_FEASIBLE_DRIVER",
      });
    }
  }

  const assignedCount = routes.reduce((sum, route) => sum + route.stops.length, 0);
  const totalTravelMin = routes.reduce((sum, route) => sum + route.totalTravelMin, 0);
  const totalWaitMin = routes.reduce((sum, route) => sum + route.totalWaitMin, 0);

  return {
    schemaVersion: ROUTING_SOLUTION_SCHEMA_VERSION,
    solverId: ORTOOLS_SOLVER_ID,
    workDate: input.workDate,
    status: resolveSolutionStatus(assignedCount, droppedTasks, maps.requiredDriverByTaskId),
    generatedAt: generatedAt ?? new Date().toISOString(),
    routes,
    droppedTasks,
    objectiveBreakdown: {
      assignedTasks: assignedCount,
      droppedTasks: droppedTasks.length,
      totalTravelMin,
      totalWaitMin,
      penalties: raw.objectiveValue !== undefined ? { ortoolsObjective: raw.objectiveValue } : undefined,
    },
    diagnostics: {
      warnings: diagnosticsWarnings,
      notes: raw.ortoolsStatus ? [`ortoolsStatus=${raw.ortoolsStatus}`] : undefined,
      solveDurationMs: raw.solveDurationMs,
    },
  };
}
