import { describe, expect, it } from "vitest";
import { LOGISTICS_SERVICE_DURATION_MIN } from "./logistics-scheduling-constraints";
import { buildRoutingProblemInputFromSource } from "../server/services/logistics-optimizer-final/build-routing-input";
import type { DriverNode, TaskNode } from "../server/services/logistics-optimizer-final/input-contract";
import type { LogisticsRoutingSourceData } from "../server/services/logistics-optimizer-final/loaders";
import {
  buildSameBuildingDriverConstraints,
  canDriverServeSameBuildingGroup,
} from "../server/services/logistics-optimizer-final/same-building-driver-constraints";
import { buildBusinessGroups } from "../server/services/logistics-optimizer-final/groups/build-business-groups";
import { buildTravelMatrixMin, buildLocationNodes } from "../server/services/logistics-optimizer-final/travel-matrix";
import { solveGreedyRouting } from "../server/services/logistics-optimizer-final/solver/greedy-routing-solver";
import type { PriorityWindows } from "../server/services/optimizer/priorityWindows";

const priorityWindows: PriorityWindows = {
  EO: { startMin: 0, endMin: 659, graceMin: 0 },
  HP: { startMin: 660, endMin: 930, graceMin: 0 },
  LP: { startMin: 660, endMin: null, graceMin: 0 },
};

function buildTask(overrides: Partial<TaskNode> & Pick<TaskNode, "taskId">): TaskNode {
  return {
    taskId: overrides.taskId,
    logisticCode: overrides.logisticCode ?? overrides.taskId,
    nodeIndex: overrides.nodeIndex ?? overrides.taskId,
    location: overrides.location ?? { lat: 45.45, lng: 9.18 },
    priority: overrides.priority ?? "LP",
    logisticsTaskKind: overrides.logisticsTaskKind ?? "delivery/pick-up",
    serviceDurationMin: overrides.serviceDurationMin ?? LOGISTICS_SERVICE_DURATION_MIN,
    rawTimes: overrides.rawTimes ?? {
      checkoutDate: null,
      checkoutTime: null,
      checkinDate: null,
      checkinTime: null,
      cleanerStartTime: null,
      cleanerTaskStartTime: null,
    },
    hardWindow: overrides.hardWindow ?? {
      earliestStartMin: 660,
      latestStartMin: 900,
      latestEndMin: 915,
      reasons: [],
    },
    softWindows: overrides.softWindows ?? [],
    groupingHints: overrides.groupingHints ?? {
      cleanerId: null,
      cleanerSequence: null,
      addressGroupId: null,
      sameLogisticCodeGroup: null,
    },
    eligibility: overrides.eligibility ?? {
      schedulable: true,
      exclusionReasons: [],
    },
  };
}

function buildDriver(id: number): DriverNode {
  return {
    id,
    startLocationNodeId: "depot",
    workWindow: {
      startMin: 600,
      endMin: 1200,
      startSource: "default",
      endSource: "default",
    },
    selected: true,
  };
}

describe("buildSameBuildingDriverConstraints", () => {
  it("locks same-building tasks to the same driver", () => {
    const tasks = [
      buildTask({
        taskId: 229,
        nodeIndex: 1,
        logisticCode: 229,
        location: { lat: 45.451047, lng: 9.191063 },
      }),
      buildTask({
        taskId: 273,
        nodeIndex: 2,
        logisticCode: 273,
        location: { lat: 45.451041, lng: 9.191066 },
      }),
    ];
    const drivers = [buildDriver(10), buildDriver(20)];
    const travelMatrixMin = buildTravelMatrixMin(buildLocationNodes(tasks));
    const businessGroups = buildBusinessGroups(tasks, travelMatrixMin);

    const result = buildSameBuildingDriverConstraints({
      businessGroups,
      tasks,
      drivers,
      travelMatrixMin,
      existingRequiredDriverByTaskId: new Map(),
    });

    expect(result.lockedGroupCount).toBe(1);
    expect(result.constraints).toHaveLength(2);
    expect(result.constraints.every((c) => c.type === "REQUIRED_DRIVER_TASK")).toBe(true);

    const driverIds = result.constraints.map((c) =>
      c.type === "REQUIRED_DRIVER_TASK" ? c.driverId : null
    );
    expect(driverIds).toEqual([driverIds[0], driverIds[0]]);
    expect(result.constraints[0]).toMatchObject({
      source: "same_coordinates_building",
      taskId: 229,
    });
    expect(result.constraints[1]).toMatchObject({
      source: "same_coordinates_building",
      taskId: 273,
    });
  });

  it("greedy solver keeps same-building tasks on one driver", () => {
    const tasks = [
      buildTask({
        taskId: 229,
        nodeIndex: 1,
        logisticCode: 229,
        location: { lat: 45.451047, lng: 9.191063 },
      }),
      buildTask({
        taskId: 273,
        nodeIndex: 2,
        logisticCode: 273,
        location: { lat: 45.451041, lng: 9.191066 },
      }),
      buildTask({
        taskId: 999,
        nodeIndex: 3,
        logisticCode: 999,
        location: { lat: 45.48, lng: 9.19 },
      }),
    ];
    const drivers = [buildDriver(10), buildDriver(20)];
    const travelMatrixMin = buildTravelMatrixMin(buildLocationNodes(tasks));
    const businessGroups = buildBusinessGroups(tasks, travelMatrixMin);
    const sameBuilding = buildSameBuildingDriverConstraints({
      businessGroups,
      tasks,
      drivers,
      travelMatrixMin,
      existingRequiredDriverByTaskId: new Map(),
    });

    const solution = solveGreedyRouting({
      schemaVersion: "logistics-routing-input/v1",
      workDate: "2026-06-18",
      windowConfig: {
        source: "app_settings",
        workDate: "2026-06-18",
        priorityWindows,
        fallbackUsed: false,
      },
      depot: { nodeId: "depot", nodeIndex: 0, kind: "DEPOT", lat: 45.434029, lng: 9.180008 },
      drivers,
      tasks,
      travelMatrixMin,
      serviceDurationMin: LOGISTICS_SERVICE_DURATION_MIN,
      hardConstraints: [
        ...drivers.map((driver) => ({
          type: "DRIVER_WORK_WINDOW" as const,
          driverId: driver.id,
          startMin: driver.workWindow.startMin,
          endMin: driver.workWindow.endMin,
        })),
        ...tasks.flatMap((task) => [
          {
            type: "TASK_TIME_WINDOW" as const,
            taskId: task.taskId,
            earliestStartMin: task.hardWindow.earliestStartMin,
            latestStartMin: task.hardWindow.latestStartMin,
            latestEndMin: task.hardWindow.latestEndMin,
          },
          {
            type: "TASK_REQUIRED" as const,
            taskId: task.taskId,
          },
        ]),
        ...sameBuilding.constraints,
      ],
      softConstraints: [],
      businessGroups,
      metadata: {
        generatedAt: new Date().toISOString(),
        totalLogisticsTasks: 3,
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
        sameBuildingDriverLockCount: 1,
        skippedSameBuildingGroupsCount: 0,
        lockedAssignmentsSolverIntegration: "integrated_v4b",
        validation: { valid: true, errors: [], warnings: [] },
      },
    });

    const routeFor229 = solution.routes.find((route) =>
      route.stops.some((stop) => stop.taskId === 229)
    );
    const routeFor273 = solution.routes.find((route) =>
      route.stops.some((stop) => stop.taskId === 273)
    );

    expect(routeFor229).toBeDefined();
    expect(routeFor273).toBe(routeFor229);
  });

  it("skips groups with conflicting pre-assigned drivers", () => {
    const tasks = [
      buildTask({
        taskId: 1,
        nodeIndex: 1,
        location: { lat: 45.451047, lng: 9.191063 },
      }),
      buildTask({
        taskId: 2,
        nodeIndex: 2,
        location: { lat: 45.451041, lng: 9.191066 },
      }),
    ];
    const drivers = [buildDriver(10), buildDriver(20)];
    const travelMatrixMin = buildTravelMatrixMin(buildLocationNodes(tasks));
    const businessGroups = buildBusinessGroups(tasks, travelMatrixMin);

    const result = buildSameBuildingDriverConstraints({
      businessGroups,
      tasks,
      drivers,
      travelMatrixMin,
      existingRequiredDriverByTaskId: new Map([
        [1, 10],
        [2, 20],
      ]),
    });

    expect(result.constraints).toHaveLength(0);
    expect(result.skippedGroups).toHaveLength(1);
    expect(result.skippedGroups[0].reason).toBe("CONFLICTING_PRE_ASSIGNED_DRIVERS");
  });
});

describe("buildRoutingProblemInputFromSource integration", () => {
  it("adds same-building REQUIRED_DRIVER constraints from source data", () => {
    const sourceData: LogisticsRoutingSourceData = {
      workDate: "2026-06-18",
      allTaskData: [],
      schedulableTasks: [
        {
          taskId: 227684,
          logisticCode: 229,
          priority: "low_priority",
          cleaningTime: 60,
          lat: 45.451047,
          lng: 9.191063,
          checkinDate: null,
          checkoutDate: null,
          checkinTime: null,
          checkoutTime: null,
          cleanerId: 987,
          cleanerStartTime: "10:00",
          cleanerTaskStartTime: "12:38",
          cleanerSequence: 2,
          premium: false,
          paxIn: 1,
          logisticsTaskKind: "delivery/pick-up",
          logisticsTaskKindSource: "auto",
        },
        {
          taskId: 231165,
          logisticCode: 273,
          priority: "low_priority",
          cleaningTime: 60,
          lat: 45.451041,
          lng: 9.191066,
          checkinDate: "2026-06-19",
          checkoutDate: null,
          checkinTime: "19:00",
          checkoutTime: null,
          cleanerId: 987,
          cleanerStartTime: "10:00",
          cleanerTaskStartTime: "13:43",
          cleanerSequence: 3,
          premium: false,
          paxIn: 2,
          logisticsTaskKind: "delivery/pick-up",
          logisticsTaskKindSource: "auto",
        },
      ],
      selectedDrivers: [
        {
          id: 737,
          startTime: "10:00",
          endTime: "20:00",
          startTimeSource: "default",
          endTimeSource: "default",
        },
        {
          id: 1078,
          startTime: "10:00",
          endTime: "20:00",
          startTimeSource: "default",
          endTimeSource: "default",
        },
      ],
      windowConfig: {
        source: "app_settings",
        workDate: "2026-06-18",
        priorityWindows,
        fallbackUsed: false,
      },
      lockedTasksExcluded: 0,
      tasksExcludedNoCoordinatesIds: [],
      timelineAssignmentHints: [],
    };

    const input = buildRoutingProblemInputFromSource(sourceData);
    const sameBuildingConstraints = input.hardConstraints.filter(
      (constraint) =>
        constraint.type === "REQUIRED_DRIVER_TASK" &&
        constraint.source === "same_coordinates_building"
    );

    expect(sameBuildingConstraints).toHaveLength(2);
    const driverIds = sameBuildingConstraints.map((c) =>
      c.type === "REQUIRED_DRIVER_TASK" ? c.driverId : null
    );
    expect(driverIds[0]).toBe(driverIds[1]);
    expect(input.metadata.sameBuildingDriverLockCount).toBe(1);
  });
});

describe("canDriverServeSameBuildingGroup", () => {
  it("returns true when a driver can serve both tasks in order", () => {
    const tasks = [
      buildTask({
        taskId: 1,
        nodeIndex: 1,
        hardWindow: { earliestStartMin: 660, latestStartMin: 798, latestEndMin: 813, reasons: [] },
        location: { lat: 45.451047, lng: 9.191063 },
      }),
      buildTask({
        taskId: 2,
        nodeIndex: 2,
        hardWindow: { earliestStartMin: 660, latestStartMin: 863, latestEndMin: 878, reasons: [] },
        location: { lat: 45.451041, lng: 9.191066 },
      }),
    ];
    const travelMatrixMin = buildTravelMatrixMin(buildLocationNodes(tasks));
    const driver = buildDriver(10);

    expect(canDriverServeSameBuildingGroup({ travelMatrixMin }, driver, tasks)).toBe(true);
  });
});
