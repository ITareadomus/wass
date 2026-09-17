import type {
  DriverId,
  DriverNode,
  RoutingProblemInput,
  TaskId,
  TaskNode,
} from "./input-contract";
import {
  ORTOOLS_SOLVER_ID,
  ROUTING_SOLUTION_SCHEMA_VERSION,
  type RoutingDroppedTask,
  type RoutingRouteSolution,
  type RoutingSolution,
} from "./solution-contract";
import { calculateCentroid, haversineMeters } from "./groups/geo-utils";
import { matchTerritoriesToDrivers } from "./groups/territory-driver-matching";
import { effectiveTravelMin } from "./groups/travel-matrix-utils";
import { solveRouting, type RoutingSolverId } from "./solver/solve-routing";

const ZONE_COLORS = ["#d73027", "#1a9850", "#4575b4", "#fdae61", "#984ea3", "#00a6d6"];

export interface ExclusiveWorkZoneSpec {
  zoneIndex: number;
  zoneId: string;
  label: string;
  driverId: DriverId;
  taskIds: TaskId[];
  centroid: { lat: number; lng: number };
  color: string;
}

export interface ExclusiveWorkZonePartition {
  zones: ExclusiveWorkZoneSpec[];
  taskZoneIndex: Array<{ taskId: TaskId; zoneIndex: number }>;
}

function hasFiniteCoordinates(task: TaskNode): boolean {
  return Number.isFinite(task.location.lat) && Number.isFinite(task.location.lng);
}

function taskDistance(left: TaskNode, right: TaskNode, travelMatrixMin: number[][]): number {
  return (
    effectiveTravelMin(travelMatrixMin, left.nodeIndex, right.nodeIndex) ??
    haversineMeters(left.location.lat, left.location.lng, right.location.lat, right.location.lng)
  );
}

function chooseSeeds(
  tasks: TaskNode[],
  zoneCount: number,
  travelMatrixMin: number[][]
): TaskNode[] {
  const sorted = [...tasks].sort((left, right) => left.taskId - right.taskId);
  if (sorted.length === 0) return [];

  const central = sorted.reduce((best, candidate) => {
    const candidateSum = sorted.reduce(
      (sum, other) =>
        sum + (candidate.taskId === other.taskId ? 0 : taskDistance(candidate, other, travelMatrixMin)),
      0
    );
    const bestSum = sorted.reduce(
      (sum, other) =>
        sum + (best.taskId === other.taskId ? 0 : taskDistance(best, other, travelMatrixMin)),
      0
    );
    if (candidateSum < bestSum) return candidate;
    if (candidateSum === bestSum && candidate.taskId < best.taskId) return candidate;
    return best;
  }, sorted[0]);

  const seeds = [central];
  while (seeds.length < zoneCount) {
    const nextSeed = sorted
      .filter((task) => !seeds.some((seed) => seed.taskId === task.taskId))
      .reduce((best: TaskNode | null, candidate) => {
        const candidateMin = Math.min(
          ...seeds.map((seed) => taskDistance(candidate, seed, travelMatrixMin))
        );
        if (!best) return candidate;
        const bestMin = Math.min(...seeds.map((seed) => taskDistance(best, seed, travelMatrixMin)));
        if (candidateMin > bestMin) return candidate;
        if (candidateMin === bestMin && candidate.taskId < best.taskId) return candidate;
        return best;
      }, null);
    if (!nextSeed) break;
    seeds.push(nextSeed);
  }
  return seeds;
}

function assignToSeeds(
  tasks: TaskNode[],
  seeds: TaskNode[],
  travelMatrixMin: number[][]
): TaskNode[][] {
  const buckets = seeds.map(() => [] as TaskNode[]);
  const ranked = [...tasks]
    .map((task) => {
      const distances = seeds.map((seed, index) => ({
        index,
        distance: taskDistance(task, seed, travelMatrixMin),
      }));
      distances.sort((left, right) => left.distance - right.distance || left.index - right.index);
      const best = distances[0];
      const second = distances[1] ?? best;
      return { task, distances, margin: second.distance - best.distance };
    })
    .sort((left, right) => right.margin - left.margin || left.task.taskId - right.task.taskId);

  const maxPerZone = Math.max(1, Math.ceil(tasks.length / Math.max(1, seeds.length)) + 2);
  for (const entry of ranked) {
    const preferred = entry.distances.find(
      (candidate) => buckets[candidate.index].length < maxPerZone
    );
    const index = preferred?.index ?? entry.distances[0].index;
    buckets[index].push(entry.task);
  }
  return buckets;
}

function findHub(tasks: TaskNode[], centroid: { lat: number; lng: number }): TaskNode {
  return tasks.reduce((best, candidate) => {
    const candidateDistance = haversineMeters(
      candidate.location.lat,
      candidate.location.lng,
      centroid.lat,
      centroid.lng
    );
    const bestDistance = haversineMeters(
      best.location.lat,
      best.location.lng,
      centroid.lat,
      centroid.lng
    );
    if (candidateDistance < bestDistance) return candidate;
    if (candidateDistance === bestDistance && candidate.taskId < best.taskId) return candidate;
    return best;
  }, tasks[0]);
}

export function resolveExclusiveZoneCount(taskCount: number, driverCount: number): number {
  if (driverCount <= 0 || taskCount <= 0) return 0;
  return Math.min(driverCount, taskCount);
}

function clusterExclusiveZones(args: {
  tasks: TaskNode[];
  drivers: DriverNode[];
  travelMatrixMin: number[][];
}): ExclusiveWorkZoneSpec[] {
  const { tasks, drivers, travelMatrixMin } = args;
  const zoneCount = resolveExclusiveZoneCount(tasks.length, drivers.length);
  if (zoneCount === 0) return [];

  let seeds = chooseSeeds(tasks, zoneCount, travelMatrixMin);
  let buckets: TaskNode[][] = [];
  let previous = "";

  for (let iteration = 0; iteration < 20; iteration += 1) {
    buckets = assignToSeeds(tasks, seeds, travelMatrixMin);
    const signature = buckets
      .map((zoneTasks) =>
        zoneTasks
          .map((task) => task.taskId)
          .sort((left, right) => left - right)
          .join(",")
      )
      .join("|");
    if (signature === previous) break;
    previous = signature;
    seeds = buckets.map((zoneTasks, index) => {
      if (zoneTasks.length === 0) return seeds[index];
      return findHub(zoneTasks, calculateCentroid(zoneTasks.map((task) => task.location)));
    });
  }

  const nonEmpty = buckets
    .map((zoneTasks, index) => ({ zoneTasks, seed: seeds[index], index }))
    .filter((entry) => entry.zoneTasks.length > 0);

  const driverAssignments = matchTerritoriesToDrivers({
    territories: nonEmpty.map((entry, zoneIndex) => ({
      territoryIndex: zoneIndex,
      taskIds: entry.zoneTasks.map((task) => task.taskId),
      hubNodeIndex: entry.seed.nodeIndex,
    })),
    drivers,
    travelMatrixMin,
    requiredDriverByTaskId: new Map(),
  });
  const driverByZone = new Map(
    driverAssignments.map((assignment) => [assignment.territoryIndex, assignment.assignedDriverId])
  );

  return nonEmpty.map((entry, zoneIndex) => {
    const centroid = calculateCentroid(entry.zoneTasks.map((task) => task.location));
    return {
      zoneIndex,
      zoneId: `exclusive-zone:${zoneIndex}`,
      label: `Zona ${zoneIndex + 1}`,
      driverId: driverByZone.get(zoneIndex) ?? drivers[zoneIndex % drivers.length].id,
      taskIds: entry.zoneTasks.map((task) => task.taskId).sort((left, right) => left - right),
      centroid,
      color: ZONE_COLORS[zoneIndex % ZONE_COLORS.length],
    };
  });
}

export function computeExclusiveWorkZones(args: {
  tasks: TaskNode[];
  drivers: DriverNode[];
  travelMatrixMin: number[][];
  territoryAssignment?: RoutingProblemInput["metadata"]["dailyTerritoryAssignment"];
}): ExclusiveWorkZonePartition | null {
  const eligible = args.tasks.filter(hasFiniteCoordinates);
  if (eligible.length === 0 || args.drivers.length === 0) return null;

  const fromTerritories = args.territoryAssignment?.territories ?? [];
  const desiredCount = resolveExclusiveZoneCount(eligible.length, args.drivers.length);
  const territoryCoversAll =
    fromTerritories.length === desiredCount &&
    fromTerritories.length > 0 &&
    new Set(fromTerritories.flatMap((territory) => territory.taskIds)).size === eligible.length;

  const zones: ExclusiveWorkZoneSpec[] = territoryCoversAll
    ? fromTerritories.map((territory, zoneIndex) => ({
        zoneIndex,
        zoneId: territory.territoryId,
        label: territory.label ?? `Zona ${zoneIndex + 1}`,
        driverId: territory.assignedDriverId,
        taskIds: [...territory.taskIds].sort((left, right) => left - right),
        centroid: territory.centroid,
        color: territory.suggestedColor || ZONE_COLORS[zoneIndex % ZONE_COLORS.length],
      }))
    : clusterExclusiveZones({
        tasks: eligible,
        drivers: args.drivers,
        travelMatrixMin: args.travelMatrixMin,
      });

  if (zones.length === 0) return null;

  return {
    zones,
    taskZoneIndex: zones.flatMap((zone) =>
      zone.taskIds.map((taskId) => ({ taskId, zoneIndex: zone.zoneIndex }))
    ),
  };
}

export function partitionExclusiveWorkZones(input: RoutingProblemInput): ExclusiveWorkZoneSpec[] {
  return (
    computeExclusiveWorkZones({
      tasks: input.tasks,
      drivers: input.drivers,
      travelMatrixMin: input.travelMatrixMin,
      territoryAssignment: input.metadata.dailyTerritoryAssignment,
    })?.zones ?? []
  );
}

export function shouldSolveAsExclusiveWorkZones(input: RoutingProblemInput): boolean {
  return input.drivers.length >= 2 && input.tasks.length >= 2;
}

export function sliceRoutingInputToZone(
  input: RoutingProblemInput,
  zone: ExclusiveWorkZoneSpec
): RoutingProblemInput {
  const taskIds = new Set(zone.taskIds);
  const tasks = input.tasks.filter((task) => taskIds.has(task.taskId));
  const drivers = input.drivers.filter((driver) => driver.id === zone.driverId);
  const driverIds = new Set(drivers.map((driver) => driver.id));

  return {
    ...input,
    drivers,
    tasks,
    hardConstraints: input.hardConstraints.filter((constraint) => {
      if ("taskId" in constraint && constraint.taskId !== undefined) {
        return taskIds.has(constraint.taskId);
      }
      if (constraint.type === "DRIVER_WORK_WINDOW") {
        return driverIds.has(constraint.driverId);
      }
      return true;
    }),
    softConstraints: input.softConstraints.filter((constraint) => {
      if ("taskId" in constraint && constraint.taskId !== undefined) {
        return taskIds.has(constraint.taskId);
      }
      if ("groupId" in constraint) {
        const group = input.businessGroups.find((entry) => entry.groupId === constraint.groupId);
        return group ? group.taskIds.every((taskId) => taskIds.has(taskId)) : false;
      }
      return true;
    }),
    businessGroups: input.businessGroups.filter((group) =>
      group.taskIds.every((taskId) => taskIds.has(taskId))
    ),
  };
}

export function mergeExclusiveZoneSolutions(args: {
  input: RoutingProblemInput;
  zoneSolutions: Array<{ zone: ExclusiveWorkZoneSpec; solution: RoutingSolution }>;
  solverId?: string;
  generatedAt?: string;
}): RoutingSolution {
  const assigned = new Set<TaskId>();
  const routes: RoutingRouteSolution[] = [];
  const droppedTasks: RoutingDroppedTask[] = [];
  const warnings: string[] = [];
  const notes: string[] = [
    `exclusive-work-zones:${args.zoneSolutions.length}`,
  ];
  let solveDurationMs = 0;

  for (const { zone, solution } of args.zoneSolutions) {
    notes.push(`exclusive-work-zone:${zone.zoneIndex}:${zone.label}:driver=${zone.driverId}`);
    for (const route of solution.routes) {
      routes.push(route);
      for (const stop of route.stops) assigned.add(stop.taskId);
    }
    droppedTasks.push(...solution.droppedTasks);
    warnings.push(...(solution.diagnostics?.warnings ?? []));
    solveDurationMs += solution.diagnostics?.solveDurationMs ?? 0;
  }

  const droppedIds = new Set(droppedTasks.map((dropped) => dropped.taskId));
  for (const task of args.input.tasks) {
    if (!assigned.has(task.taskId) && !droppedIds.has(task.taskId)) {
      droppedTasks.push({ taskId: task.taskId, reason: "NO_FEASIBLE_DRIVER" });
      droppedIds.add(task.taskId);
    }
  }

  const assignedTaskCount = routes.reduce((sum, route) => sum + route.stops.length, 0);
  const totalTravelMin = routes.reduce((sum, route) => sum + route.totalTravelMin, 0);
  const totalWaitMin = routes.reduce((sum, route) => sum + route.totalWaitMin, 0);
  const status =
    assignedTaskCount === 0
      ? "INFEASIBLE"
      : droppedTasks.length > 0
        ? "PARTIAL"
        : "FEASIBLE";

  return {
    schemaVersion: ROUTING_SOLUTION_SCHEMA_VERSION,
    solverId: args.solverId ?? ORTOOLS_SOLVER_ID,
    workDate: args.input.workDate,
    status,
    generatedAt: args.generatedAt ?? new Date().toISOString(),
    routes: routes.sort((left, right) => left.driverId - right.driverId),
    droppedTasks,
    objectiveBreakdown: {
      assignedTasks: assignedTaskCount,
      droppedTasks: droppedTasks.length,
      totalTravelMin,
      totalWaitMin,
    },
    diagnostics: {
      warnings,
      notes,
      solveDurationMs,
    },
  };
}

export async function solveExclusiveWorkZoneRouting(
  input: RoutingProblemInput,
  options: { solverId?: RoutingSolverId } = {}
): Promise<RoutingSolution> {
  const zones = partitionExclusiveWorkZones(input);
  if (zones.length === 0) {
    return solveRouting(input, { solverId: options.solverId });
  }

  const zoneSolutions = await Promise.all(
    zones.map(async (zone) => {
      const sliced = sliceRoutingInputToZone(input, zone);
      if (sliced.tasks.length === 0 || sliced.drivers.length === 0) {
        return {
          zone,
          solution: {
            schemaVersion: ROUTING_SOLUTION_SCHEMA_VERSION,
            solverId: options.solverId ?? ORTOOLS_SOLVER_ID,
            workDate: input.workDate,
            status: "FEASIBLE" as const,
            generatedAt: new Date().toISOString(),
            routes: [],
            droppedTasks: sliced.tasks.map((task) => ({
              taskId: task.taskId,
              reason: "NO_FEASIBLE_DRIVER" as const,
            })),
          },
        };
      }
      const solution = await solveRouting(sliced, { solverId: options.solverId });
      return { zone, solution };
    })
  );

  return mergeExclusiveZoneSolutions({
    input,
    zoneSolutions,
    solverId: options.solverId,
  });
}
