import { describe, expect, it } from "vitest";
import { LOGISTICS_SERVICE_DURATION_MIN } from "./logistics-scheduling-constraints";
import type {
  DriverNode,
  RoutingProblemInput,
  TaskNode,
} from "../server/services/logistics-optimizer-final/input-contract";
import {
  ROUTING_SOLUTION_SCHEMA_VERSION,
  type RoutingRouteSolution,
  type RoutingSolution,
} from "../server/services/logistics-optimizer-final/solution-contract";
import { THREE_DRIVER_TERRITORY_PROFILES } from "../server/services/logistics-optimizer-final/groups/historical-territory-profiles";
import {
  buildSubZoneLookup,
  canonicalBucketOrders,
} from "../server/services/logistics-optimizer-final/route-polishing";
import { findBestFeasibleSequence } from "../server/services/logistics-optimizer-final/route-sequencer";
import { simulateRouteTiming } from "../server/services/logistics-optimizer-final/route-timing";
import {
  compareSolutionShape,
  computeSolutionShapeMetrics,
  degradesRobustness,
} from "../server/services/logistics-optimizer-final/solution-shape-metrics";
import { repairTerritoryAssignments } from "../server/services/logistics-optimizer-final/territory-repair";
import { buildSequenceRefinementPayload } from "../server/services/logistics-optimizer-final/solver/ortools/ortools-adapter";

const NORTH_CENTROID = THREE_DRIVER_TERRITORY_PROFILES[0].centroid;
/** Sub-zone thresholds are +-0.012 of longitude around the territory centroid. */
const NORTH_WEST_LNG = NORTH_CENTROID.lng - 0.02;
const NORTH_CENTRAL_LNG = NORTH_CENTROID.lng;
const NORTH_EAST_LNG = NORTH_CENTROID.lng + 0.02;

interface TaskSpec {
  taskId: number;
  lng: number;
  earliestStartMin?: number;
  latestStartMin: number;
  territoryIndex?: number;
  preferredDriverId?: number;
}

function buildTask(spec: TaskSpec): TaskNode {
  const earliestStartMin = spec.earliestStartMin ?? 0;
  return {
    taskId: spec.taskId,
    logisticCode: spec.taskId,
    nodeIndex: spec.taskId,
    location: { lat: NORTH_CENTROID.lat, lng: spec.lng },
    priority: "HP",
    premium: false,
    straordinaria: false,
    logisticsTaskKind: "pick-up",
    serviceDurationMin: LOGISTICS_SERVICE_DURATION_MIN,
    rawTimes: {
      checkoutDate: null,
      checkoutTime: null,
      checkinDate: null,
      checkinTime: null,
      cleanerStartTime: null,
      cleanerTaskStartTime: null,
    },
    hardWindow: {
      earliestStartMin,
      latestStartMin: spec.latestStartMin,
      latestEndMin: spec.latestStartMin + LOGISTICS_SERVICE_DURATION_MIN,
      reasons: [],
    },
    softWindows: [],
    debug: {
      ruleTrace: [],
      sourceTimes: {
        customerCheckoutMin: null,
        cleanerTaskStartMin: null,
        customerCheckinMin: null,
      },
    },
    groupingHints: {
      cleanerId: null,
      cleanerSequence: null,
      addressGroupId: null,
      sameLogisticCodeGroup: null,
    },
    eligibility: { schedulable: true, exclusionReasons: [] },
  };
}

function buildDriver(id: number, startMin = 600): DriverNode {
  return {
    id,
    startLocationNodeId: "depot",
    workWindow: { startMin, endMin: 1200, startSource: "default", endSource: "default" },
    selected: true,
  };
}

function buildMatrix(size: number, entries: Array<[number, number, number]>): number[][] {
  const matrix = Array.from({ length: size }, () => Array(size).fill(10));
  for (let index = 0; index < size; index += 1) matrix[index][index] = 0;
  for (const [from, to, travel] of entries) {
    matrix[from][to] = travel;
    matrix[to][from] = travel;
  }
  return matrix;
}

function buildInput(args: {
  specs: TaskSpec[];
  drivers: DriverNode[];
  travelMatrixMin: number[][];
}): RoutingProblemInput {
  const tasks = args.specs.map(buildTask);
  const territories = THREE_DRIVER_TERRITORY_PROFILES.map((profile, index) => ({
    territoryId: `daily-territory:${profile.territoryKey}`,
    territoryIndex: profile.territoryIndex,
    territoryKey: profile.territoryKey,
    label: profile.label,
    taskIds: args.specs
      .filter((spec) => (spec.territoryIndex ?? 0) === profile.territoryIndex)
      .map((spec) => spec.taskId),
    centroid: profile.centroid,
    radiusMeters: profile.visualRadiusMeters,
    penaltyRadiusMeters: profile.penaltyRadiusMeters,
    assignedDriverId: args.drivers[Math.min(index, args.drivers.length - 1)].id,
    suggestedColor: profile.suggestedColor,
  }));

  return {
    schemaVersion: "logistics-routing-input/v1",
    workDate: "2026-07-01",
    windowConfig: {
      source: "app_settings",
      workDate: "2026-07-01",
      priorityWindows: null,
      fallbackUsed: false,
    },
    depot: { nodeId: "depot", nodeIndex: 0, kind: "DEPOT", lat: NORTH_CENTROID.lat, lng: NORTH_CENTROID.lng },
    drivers: args.drivers,
    tasks,
    travelMatrixMin: args.travelMatrixMin,
    serviceDurationMin: LOGISTICS_SERVICE_DURATION_MIN,
    hardConstraints: [],
    softConstraints: [],
    businessGroups: [],
    metadata: {
      generatedAt: "2026-07-01T00:00:00.000Z",
      totalLogisticsTasks: tasks.length,
      lockedTasksExcluded: 0,
      tasksExcludedNoCoordinatesCount: 0,
      tasksExcludedNoCoordinatesIds: [],
      noSelectedDrivers: false,
      excludedTasks: [],
      timelineAssignmentHints: [],
      timelineAssignmentHintsCount: 0,
      preAssignedRequiredCount: 0,
      skippedTimelineAssignmentHintsCount: 0,
      autoConvokedDriverIds: [],
      autoConvokedDriversCount: 0,
      autoConvokeMissingInDbDriverIds: [],
      autoConvokeMissingInDbDriversCount: 0,
      sameBuildingDriverLockCount: 0,
      skippedSameBuildingGroupsCount: 0,
      dailyTerritoryAssignment: {
        debugTerritoriesEnabled: true,
        routingPenaltiesEnabled: true,
        territoryMode: "historical_template_3_drivers" as const,
        territories,
        taskTerritoryIndex: args.specs.map((spec) => ({
          taskId: spec.taskId,
          territoryIndex: spec.territoryIndex ?? 0,
        })),
        taskPreferredDriverId: args.specs.map((spec) => ({
          taskId: spec.taskId,
          driverId: spec.preferredDriverId ?? args.drivers[0].id,
        })),
      },
      lockedAssignmentsSolverIntegration: "integrated_v4b",
      validation: { valid: true, errors: [], warnings: [] },
    },
  };
}

function buildSolution(
  input: RoutingProblemInput,
  routeOrders: Array<{ driverId: number; order: number[] }>,
  droppedTaskIds: number[] = []
): RoutingSolution {
  const taskById = new Map(input.tasks.map((task) => [task.taskId, task]));
  const routes: RoutingRouteSolution[] = [];

  for (const routeOrder of routeOrders) {
    const driver = input.drivers.find((candidate) => candidate.id === routeOrder.driverId)!;
    const simulated = simulateRouteTiming({
      input,
      driver,
      orderedTaskIds: routeOrder.order,
      taskById,
    });
    if (!simulated) throw new Error(`infeasible fixture route for driver ${routeOrder.driverId}`);
    routes.push(simulated);
  }

  return {
    schemaVersion: ROUTING_SOLUTION_SCHEMA_VERSION,
    solverId: "ortools-v1",
    workDate: "2026-07-01",
    status: droppedTaskIds.length > 0 ? "PARTIAL" : "FEASIBLE",
    generatedAt: "2026-07-01T00:00:00.000Z",
    routes,
    droppedTasks: droppedTaskIds.map((taskId) => ({
      taskId,
      reason: "NO_FEASIBLE_DRIVER" as const,
    })),
    objectiveBreakdown: {
      assignedTasks: routes.reduce((sum, route) => sum + route.stops.length, 0),
      droppedTasks: droppedTaskIds.length,
      totalTravelMin: routes.reduce((sum, route) => sum + route.totalTravelMin, 0),
      totalWaitMin: routes.reduce((sum, route) => sum + route.totalWaitMin, 0),
    },
    diagnostics: { warnings: [] },
  };
}

describe("time-window-aware route sequencer", () => {
  /**
   * east -> central -> west -> east is the only shape that fits: the second east task
   * cannot start before 800 while the west task must start by 760. A monotone sweep can
   * never produce it, which is exactly the gap the beam search closes.
   */
  const nonMonotoneSpecs: TaskSpec[] = [
    { taskId: 1, lng: NORTH_EAST_LNG, latestStartMin: 640 },
    { taskId: 2, lng: NORTH_CENTRAL_LNG, latestStartMin: 700 },
    { taskId: 3, lng: NORTH_WEST_LNG, latestStartMin: 760 },
    { taskId: 4, lng: NORTH_EAST_LNG, earliestStartMin: 800, latestStartMin: 900 },
  ];
  const nonMonotoneMatrix = buildMatrix(5, [
    [0, 1, 10],
    [0, 2, 10],
    [0, 3, 10],
    [0, 4, 10],
    [1, 2, 10],
    [2, 3, 10],
    [1, 4, 5],
    [3, 4, 30],
    [1, 3, 30],
    [2, 4, 10],
  ]);

  it("finds a feasible order that revisits a sub-zone when no sweep fits the deadlines", () => {
    const driver = buildDriver(701);
    const input = buildInput({
      specs: nonMonotoneSpecs,
      drivers: [driver],
      travelMatrixMin: nonMonotoneMatrix,
    });
    const taskById = new Map(input.tasks.map((task) => [task.taskId, task]));
    const subZoneByTaskId = buildSubZoneLookup(input);

    const sequenced = findBestFeasibleSequence({
      input,
      driver,
      taskIds: [1, 2, 3, 4],
      taskById,
      subZoneByTaskId,
    });

    expect(sequenced).not.toBeNull();
    expect(
      simulateRouteTiming({ input, driver, orderedTaskIds: sequenced!.order, taskById })
    ).not.toBeNull();
    expect(sequenced!.revisitCount).toBe(1);
  });

  it("reaches an order that monotone sub-zone sweeps cannot produce", () => {
    const driver = buildDriver(701);
    const input = buildInput({
      specs: nonMonotoneSpecs,
      drivers: [driver],
      travelMatrixMin: nonMonotoneMatrix,
    });
    const taskById = new Map(input.tasks.map((task) => [task.taskId, task]));
    const subZoneByTaskId = buildSubZoneLookup(input);

    const sweeps = canonicalBucketOrders(input, taskById, [1, 2, 3, 4], subZoneByTaskId);
    expect(sweeps.length).toBeGreaterThan(0);
    const feasibleSweeps = sweeps.filter((order) =>
      simulateRouteTiming({ input, driver, orderedTaskIds: order, taskById })
    );

    expect(feasibleSweeps).toHaveLength(0);
    expect(
      findBestFeasibleSequence({ input, driver, taskIds: [1, 2, 3, 4], taskById, subZoneByTaskId })
    ).not.toBeNull();
  });

  it("returns null when no order can satisfy the windows", () => {
    const driver = buildDriver(701);
    const input = buildInput({
      specs: [
        { taskId: 1, lng: NORTH_EAST_LNG, latestStartMin: 615 },
        { taskId: 2, lng: NORTH_WEST_LNG, latestStartMin: 615 },
      ],
      drivers: [driver],
      travelMatrixMin: buildMatrix(3, [
        [0, 1, 10],
        [0, 2, 10],
        [1, 2, 60],
      ]),
    });

    expect(
      findBestFeasibleSequence({
        input,
        driver,
        taskIds: [1, 2],
        taskById: new Map(input.tasks.map((task) => [task.taskId, task])),
        subZoneByTaskId: buildSubZoneLookup(input),
      })
    ).toBeNull();
  });
});

describe("canonical bucket orders across territories", () => {
  it("still generates sweep candidates when a route mixes two territories", () => {
    const driver = buildDriver(701);
    const input = buildInput({
      specs: [
        { taskId: 1, lng: NORTH_WEST_LNG, latestStartMin: 900, territoryIndex: 0 },
        { taskId: 2, lng: NORTH_EAST_LNG, latestStartMin: 900, territoryIndex: 0 },
        { taskId: 3, lng: NORTH_CENTRAL_LNG, latestStartMin: 900, territoryIndex: 1 },
      ],
      drivers: [driver],
      travelMatrixMin: buildMatrix(4, []),
    });
    const taskById = new Map(input.tasks.map((task) => [task.taskId, task]));
    const subZoneByTaskId = buildSubZoneLookup(input);

    const candidates = canonicalBucketOrders(input, taskById, [1, 3, 2], subZoneByTaskId);

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect([...candidate].sort()).toEqual([1, 2, 3]);
      const territoryOfPosition = candidate.map(
        (taskId) => subZoneByTaskId.get(taskId)!.territoryIndex
      );
      const blocks = territoryOfPosition.filter(
        (territoryIndex, index) => index === 0 || territoryIndex !== territoryOfPosition[index - 1]
      );
      expect(blocks).toHaveLength(new Set(territoryOfPosition).size);
    }
  });
});

describe("solution shape comparison", () => {
  const base = {
    requiredDroppedCount: 0,
    droppedTaskCount: 2,
    territoryViolationCount: 1,
    crossTerritoryTransitionCount: 2,
    subZoneRevisitCount: 3,
    directionReversalCount: 4,
    totalTravelMin: 300,
    totalWaitMin: 0,
    worstSlackMin: 10,
    routes: [],
  };

  it("prefers more assigned tasks over any shape or travel gain", () => {
    const fewerDropped = { ...base, droppedTaskCount: 1, totalTravelMin: 900, subZoneRevisitCount: 20 };
    expect(compareSolutionShape(fewerDropped, base)).toBeLessThan(0);
  });

  it("prefers fewer territory violations when coverage is equal", () => {
    const cleanerTerritory = { ...base, territoryViolationCount: 0, totalTravelMin: 320 };
    expect(compareSolutionShape(cleanerTerritory, base)).toBeLessThan(0);
  });

  it("uses slack as the final tiebreak so equal plans prefer the runnable one", () => {
    const fragile = { ...base, worstSlackMin: 0 };
    expect(compareSolutionShape(base, fragile)).toBeLessThan(0);
  });

  it("flags a candidate that turns a usable plan into a knife-edge one", () => {
    expect(degradesRobustness(base, { ...base, worstSlackMin: 0 })).toBe(true);
    expect(degradesRobustness({ ...base, worstSlackMin: 1 }, { ...base, worstSlackMin: 0 })).toBe(
      false
    );
  });
});

describe("territory repair", () => {
  it("moves an out-of-territory task back to its preferred driver", () => {
    const north = buildDriver(701);
    const west = buildDriver(702);
    const input = buildInput({
      specs: [
        { taskId: 1, lng: NORTH_WEST_LNG, latestStartMin: 900, territoryIndex: 0, preferredDriverId: 701 },
        { taskId: 2, lng: NORTH_CENTRAL_LNG, latestStartMin: 900, territoryIndex: 0, preferredDriverId: 701 },
        { taskId: 3, lng: NORTH_EAST_LNG, latestStartMin: 900, territoryIndex: 0, preferredDriverId: 701 },
        { taskId: 4, lng: NORTH_CENTRAL_LNG, latestStartMin: 900, territoryIndex: 1, preferredDriverId: 702 },
        { taskId: 5, lng: NORTH_CENTRAL_LNG, latestStartMin: 900, territoryIndex: 1, preferredDriverId: 702 },
      ],
      drivers: [north, west],
      travelMatrixMin: buildMatrix(6, []),
    });

    const solution = buildSolution(input, [
      { driverId: 701, order: [1, 2] },
      { driverId: 702, order: [4, 5, 3] },
    ]);

    expect(computeSolutionShapeMetrics(input, solution).territoryViolationCount).toBe(1);

    const repaired = repairTerritoryAssignments(input, solution);

    expect(repaired.diagnostics?.candidateTaskIds).toEqual([3]);
    expect(repaired.diagnostics?.appliedMoves).toEqual([
      expect.objectContaining({ taskId: 3, fromDriverId: 702, toDriverId: 701 }),
    ]);

    const after = computeSolutionShapeMetrics(input, repaired.solution);
    expect(after.territoryViolationCount).toBe(0);
    expect(after.routes.reduce((sum, route) => sum + route.taskCount, 0)).toBe(5);
  });

  it("leaves the plan untouched when the preferred driver cannot fit the task", () => {
    const north = buildDriver(701);
    const west = buildDriver(702);
    const input = buildInput({
      specs: [
        { taskId: 1, lng: NORTH_WEST_LNG, latestStartMin: 615, territoryIndex: 0, preferredDriverId: 701 },
        { taskId: 2, lng: NORTH_CENTRAL_LNG, latestStartMin: 900, territoryIndex: 1, preferredDriverId: 702 },
        { taskId: 3, lng: NORTH_EAST_LNG, latestStartMin: 900, territoryIndex: 0, preferredDriverId: 701 },
      ],
      drivers: [north, west],
      // Task 3 is reachable from the depot and from task 2, but pairing it with task 1
      // on either side blows past the shift, so driver 701 can never absorb it.
      travelMatrixMin: buildMatrix(4, [
        [0, 1, 10],
        [0, 2, 10],
        [0, 3, 10],
        [1, 2, 10],
        [2, 3, 10],
        [1, 3, 600],
      ]),
    });

    const solution = buildSolution(input, [
      { driverId: 701, order: [1] },
      { driverId: 702, order: [2, 3] },
    ]);

    const repaired = repairTerritoryAssignments(input, solution);

    expect(repaired.diagnostics?.appliedMoves).toEqual([]);
    expect(repaired.diagnostics?.rejectedMoves).toEqual([
      expect.objectContaining({
        taskId: 3,
        toDriverId: 701,
        reason: "no_feasible_insertion_on_preferred_driver",
      }),
    ]);
    expect(repaired.solution).toBe(solution);
  });
});

describe("sequence refinement payload", () => {
  it("freezes assigned tasks on their driver and lets only dropped ones go", () => {
    const north = buildDriver(701);
    const west = buildDriver(702);
    const input = buildInput({
      specs: [
        { taskId: 1, lng: NORTH_WEST_LNG, latestStartMin: 900, territoryIndex: 0, preferredDriverId: 701 },
        { taskId: 2, lng: NORTH_EAST_LNG, latestStartMin: 900, territoryIndex: 0, preferredDriverId: 701 },
        { taskId: 3, lng: NORTH_CENTRAL_LNG, latestStartMin: 900, territoryIndex: 1, preferredDriverId: 702 },
      ],
      drivers: [north, west],
      travelMatrixMin: buildMatrix(4, []),
    });

    const built = buildSequenceRefinementPayload({
      input,
      routes: [
        { driverId: 702, orderedTaskIds: [3] },
        { driverId: 701, orderedTaskIds: [2, 1] },
      ],
      vehicleArcPenalties: [
        [[0, 0, 0, 0], [0, 0, 7, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
        [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
      ],
      timeLimitSec: 5,
    });

    expect(built).not.toBeNull();
    const { payload, maps } = built!;

    expect(payload.vehicleArcPenalties).toBeDefined();
    expect(payload.options.timeLimitSec).toBe(5);

    const vehicle701 = maps.driverIdToVehicleIndex.get(701)!;
    const vehicle702 = maps.driverIdToVehicleIndex.get(702)!;

    // Warm start must reproduce the incumbent order, not the task declaration order.
    expect(payload.initialRoutes?.[vehicle701]).toEqual([2, 1]);
    expect(payload.initialRoutes?.[vehicle702]).toEqual([3]);

    for (const task of payload.tasks) {
      expect(task.requiredVehicleIndex).toBe(task.taskId === 3 ? vehicle702 : vehicle701);
      expect(task.dropPenalty).toBeGreaterThan(1_000_000);
    }
  });

  it("keeps tasks the previous phase dropped droppable but worth recovering", () => {
    const north = buildDriver(701);
    const input = buildInput({
      specs: [
        { taskId: 1, lng: NORTH_WEST_LNG, latestStartMin: 900 },
        { taskId: 2, lng: NORTH_EAST_LNG, latestStartMin: 900 },
      ],
      drivers: [north],
      travelMatrixMin: buildMatrix(3, []),
    });

    const built = buildSequenceRefinementPayload({
      input,
      routes: [{ driverId: 701, orderedTaskIds: [1] }],
      timeLimitSec: 5,
    });

    const droppedTask = built!.payload.tasks.find((task) => task.taskId === 2)!;
    // Worth inserting when the freed-up slack allows it, yet still cheap enough to drop
    // that it can never displace a task the previous phase already placed.
    expect(droppedTask.dropPenalty).toBeGreaterThan(0);
    expect(droppedTask.dropPenalty).toBeLessThan(1_000_000);
    expect(droppedTask.requiredVehicleIndex).toBeUndefined();
    expect(built!.payload.initialRoutes?.[0]).toEqual([1]);
  });

  it("returns null when there is nothing to freeze", () => {
    const north = buildDriver(701);
    const input = buildInput({
      specs: [{ taskId: 1, lng: NORTH_WEST_LNG, latestStartMin: 900 }],
      drivers: [north],
      travelMatrixMin: buildMatrix(2, []),
    });

    expect(
      buildSequenceRefinementPayload({ input, routes: [], timeLimitSec: 5 })
    ).toBeNull();
  });
});
