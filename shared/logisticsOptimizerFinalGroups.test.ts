import { describe, expect, it } from "vitest";
import { LOGISTICS_SERVICE_DURATION_MIN } from "./logistics-scheduling-constraints";
import {
  buildBusinessGroupSoftConstraints,
  buildBusinessGroups,
  hasCleanerAssignment,
} from "../server/services/logistics-optimizer-final/groups/build-business-groups";
import { BUSINESS_GROUP_THRESHOLDS } from "../server/services/logistics-optimizer-final/groups/group-weights";
import { buildRoutingProblemInputFromSource } from "../server/services/logistics-optimizer-final/build-routing-input";
import type { TaskNode } from "../server/services/logistics-optimizer-final/input-contract";
import type { LogisticsRoutingSourceData } from "../server/services/logistics-optimizer-final/loaders";
import { validateRoutingProblemInput } from "../server/services/logistics-optimizer-final/validation";
import { buildTravelMatrixMin, buildLocationNodes } from "../server/services/logistics-optimizer-final/travel-matrix";
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
    priority: overrides.priority ?? "EO",
    logisticsTaskKind: overrides.logisticsTaskKind ?? null,
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
      earliestStartMin: 600,
      latestStartMin: 720,
      latestEndMin: 780,
      reasons: [],
    },
    softWindows: overrides.softWindows ?? [],
    debug: overrides.debug,
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

function travelMatrixForTasks(tasks: TaskNode[]): number[][] {
  return buildTravelMatrixMin(buildLocationNodes(tasks));
}

describe("hasCleanerAssignment", () => {
  it("requires cleanerId and cleanerSequence", () => {
    expect(
      hasCleanerAssignment(
        buildTask({
          taskId: 1,
          groupingHints: { cleanerId: 10, cleanerSequence: 1, addressGroupId: null, sameLogisticCodeGroup: null },
        })
      )
    ).toBe(true);
    expect(
      hasCleanerAssignment(
        buildTask({
          taskId: 2,
          groupingHints: { cleanerId: 10, cleanerSequence: null, addressGroupId: null, sameLogisticCodeGroup: null },
        })
      )
    ).toBe(false);
  });
});

describe("buildBusinessGroups", () => {
  it("groups same coordinates within 100m", () => {
    const tasks = [
      buildTask({ taskId: 1, nodeIndex: 1, location: { lat: 45.45, lng: 9.18 } }),
      buildTask({
        taskId: 2,
        nodeIndex: 2,
        location: { lat: 45.45 + 0.00045, lng: 9.18 },
      }),
    ];

    const groups = buildBusinessGroups(tasks, travelMatrixForTasks(tasks));
    const coordinateGroup = groups.find((group) => group.type === "SAME_COORDINATES_BUILDING");

    expect(coordinateGroup).toMatchObject({
      type: "SAME_COORDINATES_BUILDING",
      taskIds: [1, 2],
      toleranceMeters: 100,
      source: "coordinates",
      confidence: "high",
    });
  });

  it("forms transitive same-coordinates groups within 100m", () => {
    const tasks = [
      buildTask({ taskId: 1, nodeIndex: 1, location: { lat: 45.45, lng: 9.18 } }),
      buildTask({
        taskId: 2,
        nodeIndex: 2,
        location: { lat: 45.45 + 0.00045, lng: 9.18 },
      }),
      buildTask({
        taskId: 3,
        nodeIndex: 3,
        location: { lat: 45.45 + 0.0009, lng: 9.18 },
      }),
    ];

    const groups = buildBusinessGroups(tasks, travelMatrixForTasks(tasks));
    const coordinateGroup = groups.find((group) => group.type === "SAME_COORDINATES_BUILDING");

    expect(coordinateGroup?.taskIds).toEqual([1, 2, 3]);
  });

  it("does not group distant coordinates", () => {
    const tasks = [
      buildTask({ taskId: 1, nodeIndex: 1, location: { lat: 45.45, lng: 9.18 } }),
      buildTask({ taskId: 2, nodeIndex: 2, location: { lat: 45.46, lng: 9.18 } }),
    ];

    const groups = buildBusinessGroups(tasks, travelMatrixForTasks(tasks));

    expect(groups.filter((group) => group.type === "SAME_COORDINATES_BUILDING")).toHaveLength(0);
  });

  it("groups same cleaner only when cleanerId and cleanerSequence are present", () => {
    const tasks = [
      buildTask({
        taskId: 1,
        nodeIndex: 1,
        groupingHints: { cleanerId: 10, cleanerSequence: 1, addressGroupId: null, sameLogisticCodeGroup: null },
      }),
      buildTask({
        taskId: 2,
        nodeIndex: 2,
        groupingHints: { cleanerId: 10, cleanerSequence: 2, addressGroupId: null, sameLogisticCodeGroup: null },
      }),
    ];

    const groups = buildBusinessGroups(tasks, travelMatrixForTasks(tasks));

    expect(groups.filter((group) => group.type === "SAME_CLEANER")).toEqual([
      expect.objectContaining({
        type: "SAME_CLEANER",
        cleanerId: 10,
        taskIds: [1, 2],
        source: "cleaner_id",
      }),
    ]);
  });

  it("excludes same cleanerId without cleanerSequence", () => {
    const tasks = [
      buildTask({
        taskId: 1,
        nodeIndex: 1,
        groupingHints: { cleanerId: 10, cleanerSequence: null, addressGroupId: null, sameLogisticCodeGroup: null },
      }),
      buildTask({
        taskId: 2,
        nodeIndex: 2,
        groupingHints: { cleanerId: 10, cleanerSequence: null, addressGroupId: null, sameLogisticCodeGroup: null },
      }),
    ];

    const groups = buildBusinessGroups(tasks, travelMatrixForTasks(tasks));

    expect(groups.filter((group) => group.type === "SAME_CLEANER")).toHaveLength(0);
    expect(groups.filter((group) => group.type === "CLEANER_SEQUENCE")).toHaveLength(0);
  });

  it("mixes assigned and unassigned tasks in geo and nearby groups but not cleaner groups", () => {
    const tasks = [
      buildTask({
        taskId: 1,
        nodeIndex: 1,
        location: { lat: 45.45, lng: 9.18 },
        groupingHints: { cleanerId: 10, cleanerSequence: 1, addressGroupId: null, sameLogisticCodeGroup: null },
      }),
      buildTask({
        taskId: 2,
        nodeIndex: 2,
        location: { lat: 45.45 + 0.00045, lng: 9.18 },
        groupingHints: { cleanerId: null, cleanerSequence: null, addressGroupId: null, sameLogisticCodeGroup: null },
      }),
    ];

    const groups = buildBusinessGroups(tasks, travelMatrixForTasks(tasks));

    expect(groups.some((group) => group.type === "SAME_COORDINATES_BUILDING")).toBe(true);
    expect(groups.some((group) => group.type === "NEARBY_CLUSTER")).toBe(true);
    expect(groups.filter((group) => group.type === "SAME_CLEANER")).toHaveLength(0);
  });

  it("orders cleaner sequence by cleanerTaskStartMin then cleanerSequence then taskId", () => {
    const tasks = [
      buildTask({
        taskId: 3,
        nodeIndex: 1,
        groupingHints: { cleanerId: 10, cleanerSequence: 2, addressGroupId: null, sameLogisticCodeGroup: null },
        debug: { ruleTrace: [], sourceTimes: { cleanerTaskStartMin: 700, customerCheckoutMin: null, customerCheckinMin: null } },
      }),
      buildTask({
        taskId: 1,
        nodeIndex: 2,
        groupingHints: { cleanerId: 10, cleanerSequence: 1, addressGroupId: null, sameLogisticCodeGroup: null },
        debug: { ruleTrace: [], sourceTimes: { cleanerTaskStartMin: 660, customerCheckoutMin: null, customerCheckinMin: null } },
      }),
      buildTask({
        taskId: 2,
        nodeIndex: 3,
        groupingHints: { cleanerId: 10, cleanerSequence: 2, addressGroupId: null, sameLogisticCodeGroup: null },
        debug: { ruleTrace: [], sourceTimes: { cleanerTaskStartMin: 660, customerCheckoutMin: null, customerCheckinMin: null } },
      }),
    ];

    const groups = buildBusinessGroups(tasks, travelMatrixForTasks(tasks));
    const sequenceGroup = groups.find((group) => group.type === "CLEANER_SEQUENCE");

    expect(sequenceGroup).toMatchObject({
      type: "CLEANER_SEQUENCE",
      orderedTaskIds: [1, 2, 3],
      taskIds: [1, 2, 3],
    });
  });

  it("ignores cleaner sequence tasks without cleanerTaskStartMin", () => {
    const tasks = [
      buildTask({
        taskId: 1,
        nodeIndex: 1,
        groupingHints: { cleanerId: 10, cleanerSequence: 1, addressGroupId: null, sameLogisticCodeGroup: null },
        debug: { ruleTrace: [], sourceTimes: { cleanerTaskStartMin: 660, customerCheckoutMin: null, customerCheckinMin: null } },
      }),
      buildTask({
        taskId: 2,
        nodeIndex: 2,
        groupingHints: { cleanerId: 10, cleanerSequence: 2, addressGroupId: null, sameLogisticCodeGroup: null },
        debug: { ruleTrace: [], sourceTimes: { cleanerTaskStartMin: null, customerCheckoutMin: null, customerCheckinMin: null } },
      }),
    ];

    const groups = buildBusinessGroups(tasks, travelMatrixForTasks(tasks));

    expect(groups.filter((group) => group.type === "CLEANER_SEQUENCE")).toHaveLength(0);
  });

  it("groups priority-compatible tasks with common overlap >= 45 min", () => {
    const tasks = [
      buildTask({
        taskId: 1,
        nodeIndex: 1,
        hardWindow: { earliestStartMin: 600, latestStartMin: 720, latestEndMin: 780, reasons: [] },
      }),
      buildTask({
        taskId: 2,
        nodeIndex: 2,
        hardWindow: { earliestStartMin: 660, latestStartMin: 750, latestEndMin: 810, reasons: [] },
      }),
    ];

    const groups = buildBusinessGroups(tasks, travelMatrixForTasks(tasks));
    const priorityGroup = groups.find((group) => group.type === "PRIORITY_COMPATIBLE");

    expect(priorityGroup).toMatchObject({
      type: "PRIORITY_COMPATIBLE",
      taskIds: [1, 2],
      windowOverlap: { startMin: 660, endMin: 720 },
      source: "priority_window",
    });
    expect(
      priorityGroup?.type === "PRIORITY_COMPATIBLE"
        ? priorityGroup.windowOverlap.endMin - priorityGroup.windowOverlap.startMin
        : 0
    ).toBeGreaterThanOrEqual(BUSINESS_GROUP_THRESHOLDS.PRIORITY_COMPATIBLE_MIN_OVERLAP_MIN);
  });

  it("rejects priority groups with insufficient common overlap", () => {
    const tasks = [
      buildTask({
        taskId: 1,
        nodeIndex: 1,
        hardWindow: { earliestStartMin: 600, latestStartMin: 660, latestEndMin: 720, reasons: [] },
      }),
      buildTask({
        taskId: 2,
        nodeIndex: 2,
        hardWindow: { earliestStartMin: 630, latestStartMin: 690, latestEndMin: 750, reasons: [] },
      }),
      buildTask({
        taskId: 3,
        nodeIndex: 3,
        hardWindow: { earliestStartMin: 660, latestStartMin: 720, latestEndMin: 780, reasons: [] },
      }),
    ];

    const groups = buildBusinessGroups(tasks, travelMatrixForTasks(tasks));

    expect(groups.filter((group) => group.type === "PRIORITY_COMPATIBLE")).toHaveLength(0);
  });

  it("groups assigned and unassigned tasks when priority overlap is sufficient", () => {
    const tasks = [
      buildTask({
        taskId: 1,
        nodeIndex: 1,
        groupingHints: { cleanerId: 10, cleanerSequence: 1, addressGroupId: null, sameLogisticCodeGroup: null },
        hardWindow: { earliestStartMin: 600, latestStartMin: 720, latestEndMin: 780, reasons: [] },
      }),
      buildTask({
        taskId: 2,
        nodeIndex: 2,
        groupingHints: { cleanerId: null, cleanerSequence: null, addressGroupId: null, sameLogisticCodeGroup: null },
        hardWindow: { earliestStartMin: 660, latestStartMin: 750, latestEndMin: 810, reasons: [] },
      }),
    ];

    const groups = buildBusinessGroups(tasks, travelMatrixForTasks(tasks));

    expect(groups.some((group) => group.type === "PRIORITY_COMPATIBLE")).toBe(true);
  });

  it("groups nearby tasks within hub travel limit via travel matrix", () => {
    const tasks = [
      buildTask({ taskId: 1, nodeIndex: 1, location: { lat: 45.45, lng: 9.18 } }),
      buildTask({
        taskId: 2,
        nodeIndex: 2,
        location: { lat: 45.45 + 0.00045, lng: 9.18 },
      }),
    ];
    const travelMatrixMin = travelMatrixForTasks(tasks);
    const groups = buildBusinessGroups(tasks, travelMatrixMin);
    const nearbyGroup = groups.find((group) => group.type === "NEARBY_CLUSTER");

    expect(nearbyGroup).toMatchObject({
      type: "NEARBY_CLUSTER",
      taskIds: [1, 2],
      maxTravelMin: 10,
      hubTaskId: 1,
      source: "travel_matrix",
    });
    expect(travelMatrixMin[1][2]).toBeLessThanOrEqual(10);
  });

  it("does not create mega nearby groups through hub-ineligible chain members", () => {
    const tasks = [
      buildTask({ taskId: 1, nodeIndex: 1, location: { lat: 45.45, lng: 9.18 } }),
      buildTask({
        taskId: 2,
        nodeIndex: 2,
        location: { lat: 45.45 + 0.00045, lng: 9.18 },
      }),
      buildTask({ taskId: 3, nodeIndex: 3, location: { lat: 45.485, lng: 9.18 } }),
    ];
    const travelMatrixMin = travelMatrixForTasks(tasks);

    expect(travelMatrixMin[1][2]).toBeLessThanOrEqual(10);
    expect(travelMatrixMin[1][3]).toBeGreaterThan(10);

    const groups = buildBusinessGroups(tasks, travelMatrixMin);
    const nearbyGroups = groups.filter((group) => group.type === "NEARBY_CLUSTER");

    expect(nearbyGroups).toHaveLength(1);
    expect(nearbyGroups[0]?.taskIds).toEqual([1, 2]);
  });

  it("returns no groups for empty or single-task input", () => {
    expect(buildBusinessGroups([], [])).toEqual([]);

    const singleTask = [buildTask({ taskId: 1, nodeIndex: 1 })];
    expect(buildBusinessGroups(singleTask, travelMatrixForTasks(singleTask))).toEqual([]);
  });

  it("maps business groups to KEEP_* soft constraints with maxTravelMin on nearby", () => {
    const tasks = [
      buildTask({ taskId: 1, nodeIndex: 1, location: { lat: 45.45, lng: 9.18 } }),
      buildTask({
        taskId: 2,
        nodeIndex: 2,
        location: { lat: 45.45 + 0.00045, lng: 9.18 },
      }),
    ];
    const groups = buildBusinessGroups(tasks, travelMatrixForTasks(tasks));
    const softConstraints = buildBusinessGroupSoftConstraints(groups);

    expect(softConstraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "KEEP_SAME_COORDINATES_BUILDING_TOGETHER",
          toleranceMeters: 100,
          weight: 100,
        }),
        expect.objectContaining({
          type: "KEEP_NEARBY_CLUSTER_TOGETHER",
          maxTravelMin: 10,
          weight: 45,
        }),
      ])
    );
    expect(softConstraints.some((constraint) => "radiusMeters" in constraint)).toBe(false);
  });
});

describe("routing input integration", () => {
  it("includes businessGroups and KEEP_* soft constraints in built input", () => {
    const sourceData: LogisticsRoutingSourceData = {
      workDate: "2026-06-04",
      allTaskData: [
        {
          taskId: 101,
          logisticCode: 5001,
          priority: "early_out",
          cleaningTime: 60,
          lat: 45.45,
          lng: 9.18,
          checkinDate: null,
          checkoutDate: null,
          checkinTime: null,
          checkoutTime: null,
          cleanerId: 10,
          cleanerStartTime: "10:00",
          cleanerTaskStartTime: "10:00",
          cleanerSequence: 1,
          premium: false,
          paxIn: 2,
          locked: false,
          lockedReason: null,
        },
        {
          taskId: 102,
          logisticCode: 5002,
          priority: "low_priority",
          cleaningTime: 30,
          lat: 45.45045,
          lng: 9.18,
          checkinDate: null,
          checkoutDate: null,
          checkinTime: null,
          checkoutTime: null,
          cleanerId: 10,
          cleanerStartTime: "11:00",
          cleanerTaskStartTime: "11:00",
          cleanerSequence: 2,
          premium: false,
          paxIn: 1,
          locked: false,
          lockedReason: null,
        },
      ],
      unlockedTaskData: [],
      schedulableTasks: [
        {
          taskId: 101,
          logisticCode: 5001,
          priority: "early_out",
          cleaningTime: 60,
          lat: 45.45,
          lng: 9.18,
          checkinDate: null,
          checkoutDate: null,
          checkinTime: null,
          checkoutTime: null,
          cleanerId: 10,
          cleanerStartTime: "10:00",
          cleanerTaskStartTime: "10:00",
          cleanerSequence: 1,
          premium: false,
          paxIn: 2,
          locked: false,
          lockedReason: null,
        },
        {
          taskId: 102,
          logisticCode: 5002,
          priority: "low_priority",
          cleaningTime: 30,
          lat: 45.45045,
          lng: 9.18,
          checkinDate: null,
          checkoutDate: null,
          checkinTime: null,
          checkoutTime: null,
          cleanerId: 10,
          cleanerStartTime: "11:00",
          cleanerTaskStartTime: "11:00",
          cleanerSequence: 2,
          premium: false,
          paxIn: 1,
          locked: false,
          lockedReason: null,
        },
      ],
      lockedTasksExcluded: 0,
      tasksExcludedNoCoordinatesIds: [],
      selectedDrivers: [
        {
          id: 7,
          startTime: "09:30",
          startTimeSource: "driver_row",
          endTime: "20:00",
          endTimeSource: "default",
        },
      ],
      timelineAssignmentHints: [],
      windowConfig: {
        source: "app_settings",
        workDate: "2026-06-04",
        priorityWindows,
        fallbackUsed: false,
      },
    };

    const input = buildRoutingProblemInputFromSource(sourceData);

    expect(Array.isArray(input.businessGroups)).toBe(true);
    expect(input.softConstraints.some((constraint) => constraint.type.startsWith("KEEP_"))).toBe(true);
    expect(input.metadata.validation.valid).toBe(true);
    expect(validateRoutingProblemInput(input).valid).toBe(true);
  });
});
