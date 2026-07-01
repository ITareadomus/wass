import { describe, expect, it } from "vitest";
import { LOGISTICS_SERVICE_DURATION_MIN } from "./logistics-scheduling-constraints";
import {
  hasTightCheckinDeadline,
  resolveEoEarlyDecision,
} from "../server/services/logistics-optimizer-final/priority-route-compatibility";
import { buildVehicleArcPenalties } from "../server/services/logistics-optimizer-final/groups/route-sequence-penalties";
import { polishRoutingSolution } from "../server/services/logistics-optimizer-final/route-polishing";
import type {
  DriverNode,
  RoutingProblemInput,
  TaskNode,
} from "../server/services/logistics-optimizer-final/input-contract";
import { buildLocationNodes, buildTravelMatrixMin } from "../server/services/logistics-optimizer-final/travel-matrix";
import { THREE_DRIVER_TERRITORY_PROFILES } from "../server/services/logistics-optimizer-final/groups/historical-territory-profiles";
import { buildOrToolsPayload } from "../server/services/logistics-optimizer-final/solver/ortools/ortools-adapter";
import { ROUTING_SOLUTION_SCHEMA_VERSION } from "../server/services/logistics-optimizer-final/solution-contract";

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

    expect(buildOrToolsPayload(input).payload.vehicleArcPenalties).toBeUndefined();
  });

  it("polishes route order without changing the assigned driver", () => {
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
    expect(polished.routes[0].stops.map((stop) => stop.taskId)).not.toEqual([2, 1, 3]);
    expect(polished.routes[0].stops).toHaveLength(3);
  });
});
