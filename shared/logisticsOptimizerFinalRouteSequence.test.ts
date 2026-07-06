import { describe, expect, it } from "vitest";
import { LOGISTICS_SERVICE_DURATION_MIN } from "./logistics-scheduling-constraints";
import {
  hasTightCheckinDeadline,
  resolveEoEarlyDecision,
} from "../server/services/logistics-optimizer-final/priority-route-compatibility";
import { buildVehicleArcPenalties } from "../server/services/logistics-optimizer-final/groups/route-sequence-penalties";
import {
  polishRoutingSolution,
  polishRoutingSolutionWithDiagnostics,
} from "../server/services/logistics-optimizer-final/route-polishing";
import type {
  DriverNode,
  RoutingProblemInput,
  TaskNode,
} from "../server/services/logistics-optimizer-final/input-contract";
import { buildLocationNodes, buildTravelMatrixMin } from "../server/services/logistics-optimizer-final/travel-matrix";
import { THREE_DRIVER_TERRITORY_PROFILES } from "../server/services/logistics-optimizer-final/groups/historical-territory-profiles";
import { buildOrToolsPayload } from "../server/services/logistics-optimizer-final/solver/ortools/ortools-adapter";
import {
  ROUTING_SOLUTION_SCHEMA_VERSION,
  type RoutingSolution,
} from "../server/services/logistics-optimizer-final/solution-contract";

function buildTask(taskId: number, lat: number, lng: number, latestStartMin: number): TaskNode {
  return {
    taskId,
    logisticCode: taskId,
    nodeIndex: taskId,
    location: { lat, lng },
    priority: "EO",
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
      earliestStartMin: 0,
      latestStartMin,
      latestEndMin: latestStartMin + LOGISTICS_SERVICE_DURATION_MIN,
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
    eligibility: {
      schedulable: true,
      exclusionReasons: [],
    },
  };
}

function buildDriver(startMin = 600): DriverNode {
  return {
    id: 701,
    startLocationNodeId: "depot",
    workWindow: {
      startMin,
      endMin: 1200,
      startSource: "default",
      endSource: "default",
    },
    selected: true,
  };
}

function buildManualTravelMatrix(size: number, entries: Array<[number, number, number]>): number[][] {
  const matrix = Array.from({ length: size }, () => Array(size).fill(100));
  for (let index = 0; index < size; index += 1) {
    matrix[index][index] = 0;
  }
  for (const [from, to, travel] of entries) {
    matrix[from][to] = travel;
  }
  return matrix;
}

function buildPolishingInput(args: {
  tasks: TaskNode[];
  driver: DriverNode;
  travelMatrixMin: number[][];
  territoryIndex?: number | null;
}): RoutingProblemInput {
  const territoryIndex = args.territoryIndex ?? 0;
  const territories = THREE_DRIVER_TERRITORY_PROFILES.map((profile, index) => ({
    territoryId: `daily-territory:${profile.territoryKey}`,
    territoryIndex: profile.territoryIndex,
    territoryKey: profile.territoryKey,
    label: profile.label,
    taskIds: index === territoryIndex ? args.tasks.map((task) => task.taskId) : [],
    centroid: profile.centroid,
    radiusMeters: profile.visualRadiusMeters,
    penaltyRadiusMeters: profile.penaltyRadiusMeters,
    assignedDriverId: args.driver.id,
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
    depot: {
      nodeId: "depot",
      nodeIndex: 0,
      kind: "DEPOT",
      lat: 45.4642,
      lng: 9.19,
    },
    drivers: [args.driver],
    tasks: args.tasks,
    travelMatrixMin: args.travelMatrixMin,
    serviceDurationMin: LOGISTICS_SERVICE_DURATION_MIN,
    hardConstraints: [],
    softConstraints: [],
    businessGroups: [],
    metadata: {
      generatedAt: "2026-07-01T00:00:00.000Z",
      totalLogisticsTasks: args.tasks.length,
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
      ...(args.territoryIndex === null
        ? {}
        : {
            dailyTerritoryAssignment: {
              debugTerritoriesEnabled: true,
              routingPenaltiesEnabled: true,
              territoryMode: "historical_template_3_drivers" as const,
              territories,
              taskTerritoryIndex: args.tasks.map((task) => ({
                taskId: task.taskId,
                territoryIndex,
              })),
              taskPreferredDriverId: args.tasks.map((task) => ({
                taskId: task.taskId,
                driverId: args.driver.id,
              })),
            },
          }),
      lockedAssignmentsSolverIntegration: "integrated_v4b",
      validation: { valid: true, errors: [], warnings: [] },
    },
  };
}

function buildPolishingSolution(driver: DriverNode, order: number[]): RoutingSolution {
  return {
    schemaVersion: ROUTING_SOLUTION_SCHEMA_VERSION,
    solverId: "ortools-v1",
    workDate: "2026-07-01",
    status: "FEASIBLE",
    generatedAt: "2026-07-01T00:00:00.000Z",
    routes: [
      {
        driverId: driver.id,
        startMin: driver.workWindow.startMin,
        endMin: driver.workWindow.startMin + order.length * LOGISTICS_SERVICE_DURATION_MIN,
        totalServiceMin: order.length * LOGISTICS_SERVICE_DURATION_MIN,
        totalTravelMin: 0,
        totalWaitMin: 0,
        stops: order.map((taskId, index) => ({
          sequence: index + 1,
          taskId,
          arrivalMin: driver.workWindow.startMin + index * LOGISTICS_SERVICE_DURATION_MIN,
          startMin: driver.workWindow.startMin + index * LOGISTICS_SERVICE_DURATION_MIN,
          endMin: driver.workWindow.startMin + (index + 1) * LOGISTICS_SERVICE_DURATION_MIN,
          serviceDurationMin: LOGISTICS_SERVICE_DURATION_MIN,
          travelFromPreviousMin: 0,
          waitMin: 0,
          previousTaskId: index === 0 ? null : order[index - 1],
        })),
      },
    ],
    droppedTasks: [],
    objectiveBreakdown: {
      assignedTasks: order.length,
      droppedTasks: 0,
      totalTravelMin: 0,
      totalWaitMin: 0,
    },
    diagnostics: { warnings: [] },
  };
}

describe("EO early compatibility", () => {
  it("treats late-evening check-in as non-urgent", () => {
    const checkinMin = 22 * 60 + 45;
    const latestStartMin = checkinMin - LOGISTICS_SERVICE_DURATION_MIN;

    expect(
      hasTightCheckinDeadline({
        customerCheckinMin: checkinMin,
        latestStartMin,
      })
    ).toBe(false);

    const decision = resolveEoEarlyDecision({
      priority: "EO",
      logisticsTaskKind: "pick-up",
      customerCheckinMin: checkinMin,
      cleanerTaskStartMin: null,
      latestStartMin,
    });

    expect(decision?.mode).toBe("flexible");
    expect(decision?.penaltyPerMin).toBe(0);
    expect(decision?.reasons).toContain("EO_PICKUP_NO_TIGHT_CHECKIN");
  });

  it("treats midday check-in as urgent", () => {
    const checkinMin = 13 * 60;
    const latestStartMin = checkinMin - LOGISTICS_SERVICE_DURATION_MIN;

    expect(
      hasTightCheckinDeadline({
        customerCheckinMin: checkinMin,
        latestStartMin,
      })
    ).toBe(true);

    const decision = resolveEoEarlyDecision({
      priority: "EO",
      logisticsTaskKind: "pick-up",
      customerCheckinMin: checkinMin,
      cleanerTaskStartMin: null,
      latestStartMin,
    });

    expect(decision?.mode).toBe("urgent");
    expect(decision?.penaltyPerMin).toBe(1);
    expect(decision?.reasons).toContain("EO_HAS_TIGHT_CHECKIN_DEADLINE");
  });
});

describe("route sequence penalties", () => {
  it("penalizes reverse sweep and first-stop mismatch in north territory", () => {
    const northFrontier = buildTask(1, 45.495, 9.17, 900);
    const northWest = buildTask(2, 45.49, 9.16, 900);
    const center = buildTask(3, 45.465, 9.185, 900);
    const northEast = buildTask(4, 45.488, 9.21, 900);
    const tasks = [northFrontier, northWest, center, northEast];
    const travelMatrixMin = buildTravelMatrixMin(buildLocationNodes(tasks));
    const drivers: DriverNode[] = [
      {
        id: 701,
        startLocationNodeId: "depot",
        workWindow: {
          startMin: 570,
          endMin: 1200,
          startSource: "default",
          endSource: "default",
        },
        selected: true,
      },
    ];

    const input: RoutingProblemInput = {
      schemaVersion: "logistics-routing-input/v1",
      workDate: "2026-07-01",
      windowConfig: {
        source: "app_settings",
        workDate: "2026-07-01",
        priorityWindows: null,
        fallbackUsed: false,
      },
      depot: {
        nodeId: "depot",
        nodeIndex: 0,
        kind: "DEPOT",
        lat: 45.4642,
        lng: 9.19,
      },
      drivers,
      tasks,
      travelMatrixMin,
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
          territoryMode: "historical_template_3_drivers",
          territories: THREE_DRIVER_TERRITORY_PROFILES.map((profile, index) => ({
            territoryId: `daily-territory:${profile.territoryKey}`,
            territoryIndex: profile.territoryIndex,
            territoryKey: profile.territoryKey,
            label: profile.label,
            taskIds: index === 0 ? tasks.map((task) => task.taskId) : [],
            centroid: profile.centroid,
            radiusMeters: profile.visualRadiusMeters,
            penaltyRadiusMeters: profile.penaltyRadiusMeters,
            assignedDriverId: 701,
            suggestedColor: profile.suggestedColor,
          })),
          taskTerritoryIndex: tasks.map((task) => ({ taskId: task.taskId, territoryIndex: 0 })),
          taskPreferredDriverId: tasks.map((task) => ({ taskId: task.taskId, driverId: 701 })),
        },
        lockedAssignmentsSolverIntegration: "integrated_v4b",
        validation: { valid: true, errors: [], warnings: [] },
      },
    };

    const build = buildVehicleArcPenalties({ input });
    expect(build).toBeDefined();

    const reverseSweep = build?.details.find(
      (detail) => detail.fromTaskId === 3 && detail.toTaskId === 4 && detail.reason === "REVERSE_SWEEP"
    );
    expect(reverseSweep?.penalty).toBeGreaterThan(0);

    const firstStopMismatch = build?.details.find(
      (detail) => detail.fromTaskId === null && detail.toTaskId === 3
    );
    expect(firstStopMismatch?.reason).toBe("FIRST_STOP_MISMATCH");
  });

  it("keeps route-sequence penalties out of the main OR-Tools payload", () => {
    const tasks = [
      buildTask(1, 45.495, 9.17, 900),
      buildTask(2, 45.49, 9.16, 900),
      buildTask(3, 45.465, 9.185, 900),
    ];
    const travelMatrixMin = buildTravelMatrixMin(buildLocationNodes(tasks));
    const driver: DriverNode = {
      id: 701,
      startLocationNodeId: "depot",
      workWindow: {
        startMin: 570,
        endMin: 1200,
        startSource: "default",
        endSource: "default",
      },
      selected: true,
    };
    const input: RoutingProblemInput = {
      schemaVersion: "logistics-routing-input/v1",
      workDate: "2026-07-01",
      windowConfig: {
        source: "app_settings",
        workDate: "2026-07-01",
        priorityWindows: null,
        fallbackUsed: false,
      },
      depot: {
        nodeId: "depot",
        nodeIndex: 0,
        kind: "DEPOT",
        lat: 45.4642,
        lng: 9.19,
      },
      drivers: [driver],
      tasks,
      travelMatrixMin,
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
        lockedAssignmentsSolverIntegration: "integrated_v4b",
        validation: { valid: true, errors: [], warnings: [] },
      },
    };

    expect(buildOrToolsPayload(input).payload.vehicleArcPenalties).toBeUndefined();
  });

  it("keeps the assigned driver while polishing route order", () => {
    const northwest = buildTask(1, 45.49, 9.16, 900);
    const center = buildTask(2, 45.465, 9.185, 900);
    const northeast = buildTask(3, 45.488, 9.21, 900);
    const tasks = [northwest, center, northeast];
    const travelMatrixMin = buildTravelMatrixMin(buildLocationNodes(tasks));
    const driver: DriverNode = {
      id: 701,
      startLocationNodeId: "depot",
      workWindow: {
        startMin: 570,
        endMin: 1200,
        startSource: "default",
        endSource: "default",
      },
      selected: true,
    };
    const input: RoutingProblemInput = {
      schemaVersion: "logistics-routing-input/v1",
      workDate: "2026-07-01",
      windowConfig: {
        source: "app_settings",
        workDate: "2026-07-01",
        priorityWindows: null,
        fallbackUsed: false,
      },
      depot: {
        nodeId: "depot",
        nodeIndex: 0,
        kind: "DEPOT",
        lat: 45.4642,
        lng: 9.19,
      },
      drivers: [driver],
      tasks,
      travelMatrixMin,
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
          territoryMode: "historical_template_3_drivers",
          territories: THREE_DRIVER_TERRITORY_PROFILES.map((profile, index) => ({
            territoryId: `daily-territory:${profile.territoryKey}`,
            territoryIndex: profile.territoryIndex,
            territoryKey: profile.territoryKey,
            label: profile.label,
            taskIds: index === 0 ? tasks.map((task) => task.taskId) : [],
            centroid: profile.centroid,
            radiusMeters: profile.visualRadiusMeters,
            penaltyRadiusMeters: profile.penaltyRadiusMeters,
            assignedDriverId: driver.id,
            suggestedColor: profile.suggestedColor,
          })),
          taskTerritoryIndex: tasks.map((task) => ({ taskId: task.taskId, territoryIndex: 0 })),
          taskPreferredDriverId: tasks.map((task) => ({ taskId: task.taskId, driverId: driver.id })),
        },
        lockedAssignmentsSolverIntegration: "integrated_v4b",
        validation: { valid: true, errors: [], warnings: [] },
      },
    };

    const badSolution = {
      schemaVersion: ROUTING_SOLUTION_SCHEMA_VERSION,
      solverId: "ortools-v1",
      workDate: "2026-07-01",
      status: "FEASIBLE" as const,
      generatedAt: "2026-07-01T00:00:00.000Z",
      routes: [
        {
          driverId: driver.id,
          startMin: driver.workWindow.startMin,
          endMin: 615,
          totalServiceMin: 45,
          totalTravelMin: 0,
          totalWaitMin: 0,
          stops: [
            { sequence: 1, taskId: 2, arrivalMin: 570, startMin: 570, endMin: 585, serviceDurationMin: 15, travelFromPreviousMin: 0, waitMin: 0, previousTaskId: null },
            { sequence: 2, taskId: 1, arrivalMin: 585, startMin: 585, endMin: 600, serviceDurationMin: 15, travelFromPreviousMin: 0, waitMin: 0, previousTaskId: 2 },
            { sequence: 3, taskId: 3, arrivalMin: 600, startMin: 600, endMin: 615, serviceDurationMin: 15, travelFromPreviousMin: 0, waitMin: 0, previousTaskId: 1 },
          ],
        },
      ],
      droppedTasks: [],
      objectiveBreakdown: {
        assignedTasks: 3,
        droppedTasks: 0,
        totalTravelMin: 0,
        totalWaitMin: 0,
      },
      diagnostics: { warnings: [] },
    };

    const polished = polishRoutingSolution(input, badSolution);
    expect(polished.routes[0].driverId).toBe(driver.id);
    expect(polished.routes[0].stops).toHaveLength(3);
  });

  it("does not let initial depot wait dominate the polishing objective", () => {
    const delayedUsefulFirst = buildTask(1, 45.49, 9.16, 900);
    delayedUsefulFirst.hardWindow.earliestStartMin = 660;
    const filler = buildTask(2, 45.491, 9.161, 900);
    const last = buildTask(3, 45.492, 9.162, 900);
    const tasks = [delayedUsefulFirst, filler, last];
    const driver = buildDriver(600);
    const input = buildPolishingInput({
      tasks,
      driver,
      territoryIndex: null,
      travelMatrixMin: buildManualTravelMatrix(4, [
        [0, 1, 10],
        [0, 2, 1],
        [0, 3, 20],
        [1, 2, 1],
        [1, 3, 11],
        [2, 1, 1],
        [2, 3, 1],
        [3, 1, 100],
        [3, 2, 100],
      ]),
    });

    const { solution, diagnostics } = polishRoutingSolutionWithDiagnostics(
      input,
      buildPolishingSolution(driver, [1, 2, 3])
    );

    expect(solution.routes[0].stops.map((stop) => stop.taskId)).toEqual([1, 2, 3]);
    expect(diagnostics?.routes[0].before.initialDepotWaitMin).toBe(50);
    expect(diagnostics?.routes[0].before.inRouteWaitMin).toBe(0);
  });

  it("still penalizes wait after the route has started", () => {
    const delayedMiddle = buildTask(1, 45.49, 9.16, 900);
    delayedMiddle.hardWindow.earliestStartMin = 660;
    const filler = buildTask(2, 45.491, 9.161, 900);
    const last = buildTask(3, 45.492, 9.162, 900);
    const tasks = [delayedMiddle, filler, last];
    const driver = buildDriver(600);
    const input = buildPolishingInput({
      tasks,
      driver,
      territoryIndex: null,
      travelMatrixMin: buildManualTravelMatrix(4, [
        [0, 1, 10],
        [0, 2, 1],
        [0, 3, 20],
        [1, 2, 1],
        [1, 3, 11],
        [2, 1, 1],
        [2, 3, 1],
        [3, 1, 100],
        [3, 2, 100],
      ]),
    });

    const { solution, diagnostics } = polishRoutingSolutionWithDiagnostics(
      input,
      buildPolishingSolution(driver, [2, 1, 3])
    );

    expect(solution.routes[0].stops.map((stop) => stop.taskId)).toEqual([1, 2, 3]);
    expect(diagnostics?.routes[0].before.inRouteWaitMin).toBe(43);
    expect(diagnostics?.routes[0].after.inRouteWaitMin).toBe(0);
  });

  it("uses best-improvement instead of accepting the first better candidate", () => {
    const northwest = buildTask(1, 45.49, 9.16, 900);
    const center = buildTask(2, 45.49, 9.188, 900);
    const northeast = buildTask(3, 45.49, 9.215, 900);
    const tasks = [northwest, center, northeast];
    const driver = buildDriver(600);
    const input = buildPolishingInput({
      tasks,
      driver,
      territoryIndex: null,
      travelMatrixMin: buildManualTravelMatrix(4, [
        [0, 1, 1],
        [0, 2, 7],
        [0, 3, 10],
        [1, 2, 1],
        [1, 3, 100],
        [2, 1, 10],
        [2, 3, 1],
        [3, 1, 8],
        [3, 2, 10],
      ]),
    });

    const { solution, diagnostics } = polishRoutingSolutionWithDiagnostics(
      input,
      buildPolishingSolution(driver, [3, 2, 1])
    );

    expect(solution.routes[0].stops.map((stop) => stop.taskId)).toEqual([1, 2, 3]);
    expect(diagnostics?.routes[0].acceptedMoves[0].orderAfter).toEqual([1, 2, 3]);
    expect(diagnostics?.routes[0].acceptedMoves[0].moveType).toBe("reverse-segment");
  });

  it("keeps structured polishing diagnostics with bucket and move details", () => {
    const west = buildTask(1, 45.49, 9.16, 900);
    const central = buildTask(2, 45.49, 9.188, 900);
    const east = buildTask(3, 45.49, 9.215, 900);
    const tasks = [west, central, east];
    const driver = buildDriver(600);
    const input = buildPolishingInput({
      tasks,
      driver,
      travelMatrixMin: buildManualTravelMatrix(4, [
        [0, 1, 1],
        [0, 2, 7],
        [0, 3, 10],
        [1, 2, 1],
        [1, 3, 100],
        [2, 1, 10],
        [2, 3, 1],
        [3, 1, 8],
        [3, 2, 10],
      ]),
    });

    const { diagnostics } = polishRoutingSolutionWithDiagnostics(
      input,
      buildPolishingSolution(driver, [3, 2, 1])
    );

    expect(diagnostics?.routes[0].bucketSequenceBefore).toEqual([
      "north:north_east",
      "north:north_central",
      "north:north_west",
    ]);
    expect(diagnostics?.routes[0].bucketSequenceAfter).toEqual([
      "north:north_west",
      "north:north_central",
      "north:north_east",
    ]);
    expect(diagnostics?.routes[0].acceptedMoves[0].deltaTravelMin).toBeLessThan(0);
  });

  it("lets travel-only improve travel when only scalar route penalty gets worse", () => {
    const northHigh = buildTask(1, 45.49, 9.188, 900);
    const northMid = buildTask(2, 45.485, 9.188, 900);
    const northLow = buildTask(3, 45.48, 9.188, 900);
    const tasks = [northHigh, northMid, northLow];
    const driver = buildDriver(600);
    const input = buildPolishingInput({
      tasks,
      driver,
      travelMatrixMin: buildManualTravelMatrix(4, [
        [0, 1, 1],
        [0, 2, 100],
        [0, 3, 100],
        [1, 2, 10],
        [2, 3, 10],
        [1, 3, 5],
        [3, 2, 13],
      ]),
    });

    const { solution, diagnostics } = polishRoutingSolutionWithDiagnostics(
      input,
      buildPolishingSolution(driver, [1, 2, 3])
    );

    expect(solution.routes[0].stops.map((stop) => stop.taskId)).toEqual([1, 3, 2]);
    const travelOnlyMove = diagnostics?.routes[0].acceptedMoves.find(
      (move) => move.pass === "travel-only"
    );
    expect(travelOnlyMove?.deltaTravelMin).toBeLessThan(0);
    expect(travelOnlyMove?.deltaRoutePenaltyMin).toBeGreaterThan(0);
    expect(travelOnlyMove?.deltaSubZonePenaltyMin).toBe(0);
  });

  it("rejects travel-only candidates that worsen sub-zone shape", () => {
    const west = buildTask(1, 45.49, 9.16, 900);
    const central = buildTask(2, 45.49, 9.188, 900);
    const east = buildTask(3, 45.49, 9.215, 900);
    const tasks = [west, central, east];
    const driver = buildDriver(600);
    const input = buildPolishingInput({
      tasks,
      driver,
      travelMatrixMin: buildManualTravelMatrix(4, [
        [0, 1, 1],
        [0, 2, 100],
        [0, 3, 100],
        [1, 2, 10],
        [2, 3, 10],
        [1, 3, 5],
        [3, 2, 13],
      ]),
    });

    const { solution, diagnostics } = polishRoutingSolutionWithDiagnostics(
      input,
      buildPolishingSolution(driver, [1, 2, 3])
    );

    expect(solution.routes[0].stops.map((stop) => stop.taskId)).toEqual([1, 2, 3]);
    expect(diagnostics?.routes[0].bestRejectedTravelOnlyCandidates[0]).toMatchObject({
      orderAfter: [1, 3, 2],
      rejectedBecause: "subZonePenalty_would_increase",
      deltaTravelMin: -2,
    });
  });

  it("reports weighted route penalty separately from sub-zone penalty", () => {
    const northHigh = buildTask(1, 45.49, 9.188, 900);
    const northMid = buildTask(2, 45.485, 9.188, 900);
    const northLow = buildTask(3, 45.48, 9.188, 900);
    const tasks = [northHigh, northMid, northLow];
    const driver = buildDriver(600);
    const input = buildPolishingInput({
      tasks,
      driver,
      travelMatrixMin: buildManualTravelMatrix(4, [
        [0, 1, 1],
        [0, 2, 100],
        [0, 3, 100],
        [1, 2, 10],
        [2, 3, 10],
        [1, 3, 5],
        [3, 2, 13],
      ]),
    });

    const { diagnostics } = polishRoutingSolutionWithDiagnostics(
      input,
      buildPolishingSolution(driver, [1, 2, 3])
    );

    const after = diagnostics?.routes[0].after;
    expect(diagnostics?.config.routePenaltyWeight).toBe(0.4);
    expect(diagnostics?.config.subZonePenaltyWeight).toBe(1);
    expect(after?.weightedRoutePenaltyMin).toBeCloseTo((after?.routePenaltyMin ?? 0) * 0.4);
    expect(after?.sequenceScoreMin).toBeCloseTo(
      (after?.weightedRoutePenaltyMin ?? 0) + (after?.subZonePenaltyMin ?? 0)
    );
  });

  it("adds a soft north start-bucket penalty when feasible north-west work exists", () => {
    const northwest = buildTask(1, 45.49, 9.16, 900);
    const central = buildTask(2, 45.49, 9.188, 900);
    const northeast = buildTask(3, 45.49, 9.215, 900);
    const tasks = [northwest, central, northeast];
    const driver = buildDriver(600);
    const input = buildPolishingInput({
      tasks,
      driver,
      travelMatrixMin: buildManualTravelMatrix(4, [
        [0, 1, 10],
        [0, 2, 1],
        [0, 3, 20],
        [2, 1, 1],
        [1, 3, 1],
        [1, 2, 1],
        [2, 3, 1],
      ]),
    });

    const { diagnostics } = polishRoutingSolutionWithDiagnostics(
      input,
      buildPolishingSolution(driver, [2, 1, 3])
    );

    expect(diagnostics?.routes[0].before.subZonePenaltyMin).toBeGreaterThanOrEqual(28);
  });

  it("keeps north start-bucket penalty when an urgent central task remains feasible after west", () => {
    const northwest = buildTask(1, 45.49, 9.16, 900);
    const urgentCentral = buildTask(2, 45.49, 9.188, 765);
    const northeast = buildTask(3, 45.49, 9.215, 900);
    const tasks = [northwest, urgentCentral, northeast];
    const driver = buildDriver(600);
    const input = buildPolishingInput({
      tasks,
      driver,
      travelMatrixMin: buildManualTravelMatrix(4, [
        [0, 1, 4],
        [0, 2, 1],
        [0, 3, 20],
        [1, 2, 1],
        [1, 3, 1],
        [2, 1, 1],
        [2, 3, 1],
      ]),
    });

    const { diagnostics } = polishRoutingSolutionWithDiagnostics(
      input,
      buildPolishingSolution(driver, [2, 1, 3])
    );

    expect(diagnostics?.routes[0].before.startBucketPenaltyMin).toBe(16);
    expect(diagnostics?.routes[0].before.bucketOrderPenaltyMin).toBe(82);
    expect(diagnostics?.routes[0].before.sequentialShapePenaltyMin).toBe(82);
  });

  it("prefers north west-central-east order over a slightly shorter central-west-east route", () => {
    const northwest = buildTask(1, 45.49, 9.16, 900);
    const urgentCentral = buildTask(2, 45.49, 9.188, 765);
    const northeast = buildTask(3, 45.49, 9.215, 900);
    const tasks = [northwest, urgentCentral, northeast];
    const driver = buildDriver(600);
    const input = buildPolishingInput({
      tasks,
      driver,
      travelMatrixMin: buildManualTravelMatrix(4, [
        [0, 1, 4],
        [0, 2, 1],
        [0, 3, 20],
        [1, 2, 1],
        [2, 3, 1],
        [2, 1, 1],
        [1, 3, 1],
      ]),
    });

    const { solution, diagnostics } = polishRoutingSolutionWithDiagnostics(
      input,
      buildPolishingSolution(driver, [2, 1, 3])
    );

    expect(solution.routes[0].stops.map((stop) => stop.taskId)).toEqual([1, 2, 3]);
    expect(diagnostics?.routes[0].before.bucketOrderPenaltyMin).toBe(82);
    expect(diagnostics?.routes[0].after.bucketOrderPenaltyMin).toBe(0);
  });

  it("reorders north bucket blocks in one candidate when item moves would fragment the route", () => {
    const westA = buildTask(1, 45.49, 9.16, 900);
    const westB = buildTask(2, 45.491, 9.161, 900);
    const westC = buildTask(3, 45.492, 9.162, 900);
    const westD = buildTask(4, 45.493, 9.163, 900);
    const centralA = buildTask(5, 45.49, 9.188, 765);
    const centralB = buildTask(6, 45.491, 9.189, 900);
    const centralC = buildTask(7, 45.492, 9.19, 900);
    const eastA = buildTask(8, 45.49, 9.215, 900);
    const eastB = buildTask(9, 45.491, 9.216, 900);
    const tasks = [westA, westB, westC, westD, centralA, centralB, centralC, eastA, eastB];
    const driver = buildDriver(600);
    const input = buildPolishingInput({
      tasks,
      driver,
      travelMatrixMin: buildManualTravelMatrix(10, [
        [0, 1, 4],
        [0, 5, 1],
        [1, 2, 1],
        [2, 3, 1],
        [3, 4, 1],
        [4, 5, 1],
        [4, 8, 1],
        [5, 6, 1],
        [6, 7, 1],
        [7, 1, 1],
        [7, 8, 1],
        [8, 9, 1],
      ]),
    });

    const { solution, diagnostics } = polishRoutingSolutionWithDiagnostics(
      input,
      buildPolishingSolution(driver, [5, 6, 7, 1, 2, 3, 4, 8, 9])
    );

    expect(solution.routes[0].stops.map((stop) => stop.taskId)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(diagnostics?.routes[0].generatedCanonicalBucketCandidates).toContainEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(diagnostics?.routes[0].before.bucketOrderPenaltyMin).toBe(82);
    expect(diagnostics?.routes[0].after.bucketOrderPenaltyMin).toBe(0);
    expect(diagnostics?.routes[0].acceptedMoves[0].length).toBeGreaterThanOrEqual(3);
  });

  it("generates reverse bucket order as a valid sequential shape candidate", () => {
    const west = buildTask(1, 45.49, 9.16, 900);
    const central = buildTask(2, 45.49, 9.188, 900);
    const east = buildTask(3, 45.49, 9.215, 900);
    const tasks = [west, central, east];
    const driver = buildDriver(600);
    const input = buildPolishingInput({
      tasks,
      driver,
      travelMatrixMin: buildManualTravelMatrix(4, [
        [0, 1, 20],
        [0, 2, 10],
        [0, 3, 1],
        [3, 2, 1],
        [2, 1, 1],
        [1, 2, 10],
        [2, 3, 10],
      ]),
    });

    const { solution, diagnostics } = polishRoutingSolutionWithDiagnostics(
      input,
      buildPolishingSolution(driver, [2, 1, 3])
    );

    expect([[1, 2, 3], [3, 2, 1]]).toContainEqual(
      solution.routes[0].stops.map((stop) => stop.taskId)
    );
    expect(diagnostics?.routes[0].generatedSequentialShapeCandidates).toContainEqual([3, 2, 1]);
    expect(diagnostics?.routes[0].after.sequentialShapePenaltyMin).toBe(0);
  });

  it("accepts a structural shape candidate with small travel increase", () => {
    const west = buildTask(1, 45.49, 9.16, 900);
    const central = buildTask(2, 45.49, 9.188, 900);
    const east = buildTask(3, 45.49, 9.215, 900);
    const tasks = [west, central, east];
    const driver = buildDriver(600);
    const input = buildPolishingInput({
      tasks,
      driver,
      travelMatrixMin: buildManualTravelMatrix(4, [
        [0, 1, 3],
        [0, 2, 1],
        [0, 3, 20],
        [1, 2, 2],
        [2, 3, 3],
        [2, 1, 1],
        [1, 3, 1],
      ]),
    });

    const { solution, diagnostics } = polishRoutingSolutionWithDiagnostics(
      input,
      buildPolishingSolution(driver, [2, 1, 3])
    );

    expect(solution.routes[0].stops.map((stop) => stop.taskId)).toEqual([1, 2, 3]);
    expect(diagnostics?.routes[0].acceptedShapeFirstCandidates.length).toBeGreaterThan(0);
    expect(diagnostics?.routes[0].acceptedShapeFirstCandidates[0].deltaTravelMin).toBeGreaterThan(0);
    expect(
      diagnostics?.routes[0].acceptedShapeFirstCandidates[0].deltaSequentialShapePenaltyMin
    ).toBeLessThan(0);
  });

  it("rejects structural shape candidates when travel increase is too high", () => {
    const west = buildTask(1, 45.49, 9.16, 900);
    const central = buildTask(2, 45.49, 9.188, 900);
    const east = buildTask(3, 45.49, 9.215, 900);
    const tasks = [west, central, east];
    const driver = buildDriver(600);
    const input = buildPolishingInput({
      tasks,
      driver,
      travelMatrixMin: buildManualTravelMatrix(4, [
        [0, 1, 30],
        [0, 2, 1],
        [0, 3, 20],
        [1, 2, 30],
        [2, 3, 30],
        [2, 1, 1],
        [1, 3, 1],
      ]),
    });

    const { solution, diagnostics } = polishRoutingSolutionWithDiagnostics(
      input,
      buildPolishingSolution(driver, [2, 1, 3])
    );

    expect(solution.routes[0].stops.map((stop) => stop.taskId)).toEqual([2, 1, 3]);
    expect(diagnostics?.routes[0].bestRejectedShapeCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rejectedBecause: "shape_improved_but_travel_too_high",
        }),
      ])
    );
  });

  it("classifies center-south-east tasks into more granular buckets", () => {
    const cseCentroid = THREE_DRIVER_TERRITORY_PROFILES[2].centroid;
    const centralEast = buildTask(1, cseCentroid.lat, cseCentroid.lng - 0.02, 900);
    const eastNorth = buildTask(2, cseCentroid.lat, cseCentroid.lng + 0.005, 900);
    const farEast = buildTask(3, cseCentroid.lat, cseCentroid.lng + 0.02, 900);
    const centerSouth = buildTask(4, cseCentroid.lat - 0.005, cseCentroid.lng + 0.005, 900);
    const southEast = buildTask(5, cseCentroid.lat - 0.009, cseCentroid.lng + 0.02, 900);
    const tasks = [centralEast, eastNorth, farEast, centerSouth, southEast];
    const driver = buildDriver(600);
    const input = buildPolishingInput({
      tasks,
      driver,
      territoryIndex: 2,
      travelMatrixMin: buildManualTravelMatrix(6, [
        [0, 1, 1],
        [1, 2, 1],
        [2, 3, 1],
        [3, 4, 1],
        [4, 5, 1],
      ]),
    });

    const { diagnostics } = polishRoutingSolutionWithDiagnostics(
      input,
      buildPolishingSolution(driver, [1, 2, 3, 4, 5])
    );

    expect(diagnostics?.routes[0].bucketSequenceBefore).toEqual([
      "center_south_east:central_east",
      "center_south_east:east_north",
      "center_south_east:far_east",
      "center_south_east:center_south",
      "center_south_east:south_east",
    ]);
  });

  it("classifies center-south-west tasks with south checked before west", () => {
    const cswCentroid = THREE_DRIVER_TERRITORY_PROFILES[1].centroid;
    const farWest = buildTask(1, cswCentroid.lat, cswCentroid.lng - 0.02, 900);
    const northWest = buildTask(2, cswCentroid.lat, cswCentroid.lng - 0.01, 900);
    const centralInner = buildTask(3, cswCentroid.lat, cswCentroid.lng, 900);
    const southWest = buildTask(4, cswCentroid.lat - 0.009, cswCentroid.lng - 0.02, 900);
    const tasks = [farWest, northWest, centralInner, southWest];
    const driver = buildDriver(600);
    const input = buildPolishingInput({
      tasks,
      driver,
      territoryIndex: 1,
      travelMatrixMin: buildManualTravelMatrix(5, [
        [0, 1, 1],
        [1, 2, 1],
        [2, 3, 1],
        [3, 4, 1],
      ]),
    });

    const { diagnostics } = polishRoutingSolutionWithDiagnostics(
      input,
      buildPolishingSolution(driver, [1, 2, 3, 4])
    );

    expect(diagnostics?.routes[0].bucketSequenceBefore).toEqual([
      "center_south_west:far_west",
      "center_south_west:north_west",
      "center_south_west:central_inner",
      "center_south_west:south_west",
    ]);
  });

  it("penalizes reopening an already closed bucket", () => {
    const cswCentroid = THREE_DRIVER_TERRITORY_PROFILES[1].centroid;
    const centralA = buildTask(1, cswCentroid.lat, cswCentroid.lng, 900);
    const southWest = buildTask(2, cswCentroid.lat - 0.009, cswCentroid.lng - 0.004, 900);
    const centralB = buildTask(3, cswCentroid.lat + 0.001, cswCentroid.lng + 0.001, 900);
    const tasks = [centralA, southWest, centralB];
    const driver = buildDriver(600);
    const input = buildPolishingInput({
      tasks,
      driver,
      territoryIndex: 1,
      travelMatrixMin: buildManualTravelMatrix(4, [
        [0, 1, 1],
        [1, 2, 1],
        [2, 3, 1],
      ]),
    });

    const { diagnostics } = polishRoutingSolutionWithDiagnostics(
      input,
      buildPolishingSolution(driver, [1, 2, 3])
    );

    expect(diagnostics?.routes[0].before.bucketRevisitPenaltyMin).toBe(35);
    expect(diagnostics?.routes[0].before.bucketFragmentationPenaltyMin).toBe(20);
    expect(diagnostics?.routes[0].before.subZonePenaltyMin).toBeGreaterThanOrEqual(55);
  });
});
