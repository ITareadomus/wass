import { describe, expect, it } from "vitest";
import { LOGISTICS_SERVICE_DURATION_MIN } from "./logistics-scheduling-constraints";
import { buildRoutingProblemInputFromSource } from "../server/services/logistics-optimizer-final/build-routing-input";
import type { LogisticsRoutingSourceData } from "../server/services/logistics-optimizer-final/loaders";
import type { RoutingProblemInput } from "../server/services/logistics-optimizer-final/input-contract";
import { validateRoutingProblemInput } from "../server/services/logistics-optimizer-final/validation";
import type { PriorityWindows } from "../server/services/optimizer/priorityWindows";

const priorityWindows: PriorityWindows = {
  EO: { startMin: 0, endMin: 659, graceMin: 0 },
  HP: { startMin: 660, endMin: 930, graceMin: 0 },
  LP: { startMin: 660, endMin: null, graceMin: 0 },
};

function buildMinimalSourceData(): LogisticsRoutingSourceData {
  return {
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
        lat: null,
        lng: null,
        checkinDate: null,
        checkoutDate: null,
        checkinTime: null,
        checkoutTime: null,
        cleanerId: 10,
        cleanerStartTime: "10:00",
        cleanerTaskStartTime: "10:00",
        cleanerSequence: 1,
        premium: false,
        paxIn: 1,
        locked: false,
        lockedReason: null,
      },
      {
        taskId: 103,
        logisticCode: 5003,
        priority: "high_priority",
        cleaningTime: 45,
        lat: 45.46,
        lng: 9.19,
        checkinDate: null,
        checkoutDate: null,
        checkinTime: null,
        checkoutTime: null,
        cleanerId: 10,
        cleanerStartTime: "10:00",
        cleanerTaskStartTime: "10:00",
        cleanerSequence: 1,
        premium: true,
        paxIn: 5,
        locked: true,
        lockedReason: "manual_lock",
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
    ],
    lockedTasksExcluded: 1,
    tasksExcludedNoCoordinatesIds: [102],
    selectedDrivers: [
      {
        id: 7,
        startTime: "09:30",
        startTimeSource: "driver_row",
        endTime: "20:00",
        endTimeSource: "default",
      },
    ],
    existingLockedAssignments: [],
    windowConfig: {
      source: "app_settings",
      workDate: "2026-06-04",
      priorityWindows,
      fallbackUsed: false,
    },
  };
}

function buildMinimalValidInput(): RoutingProblemInput {
  return buildRoutingProblemInputFromSource(buildMinimalSourceData());
}

describe("validateRoutingProblemInput", () => {
  it("returns valid for a normal sourceData fixture", () => {
    const input = buildMinimalValidInput();
    const result = validateRoutingProblemInput(input);

    expect(input.metadata.validation.valid).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(input.serviceDurationMin).toBe(LOGISTICS_SERVICE_DURATION_MIN);
    expect(input.tasks[0].serviceDurationMin).toBe(LOGISTICS_SERVICE_DURATION_MIN);
  });

  it("flags invalid driver work window", () => {
    const input = buildMinimalValidInput();
    input.drivers[0].workWindow.startMin = 1200;
    input.drivers[0].workWindow.endMin = 600;

    const result = validateRoutingProblemInput(input);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "INVALID_DRIVER_WORK_WINDOW",
        driverId: 7,
      })
    );
  });

  it("flags missing DRIVER_WORK_WINDOW constraint", () => {
    const input = buildMinimalValidInput();
    input.hardConstraints = input.hardConstraints.filter(
      (constraint) => constraint.type !== "DRIVER_WORK_WINDOW"
    );

    const result = validateRoutingProblemInput(input);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "MISSING_DRIVER_WORK_WINDOW_CONSTRAINT",
        driverId: 7,
      })
    );
  });

  it("flags invalid task coordinates", () => {
    const input = buildMinimalValidInput();
    input.tasks[0].location.lat = Number.NaN;

    const result = validateRoutingProblemInput(input);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "INVALID_TASK_COORDINATES",
        taskId: 101,
      })
    );
  });

  it("flags invalid task hard window", () => {
    const input = buildMinimalValidInput();
    input.tasks[0].hardWindow.earliestStartMin = 900;
    input.tasks[0].hardWindow.latestStartMin = 800;

    const result = validateRoutingProblemInput(input);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "INVALID_TASK_HARD_WINDOW",
        taskId: 101,
      })
    );
  });

  it("flags task service exceeding latestEndMin", () => {
    const input = buildMinimalValidInput();
    input.tasks[0].hardWindow.latestStartMin = 800;
    input.tasks[0].hardWindow.latestEndMin = 810;

    const result = validateRoutingProblemInput(input);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "TASK_SERVICE_EXCEEDS_WINDOW",
        taskId: 101,
      })
    );
  });

  it("flags missing TASK_REQUIRED constraint", () => {
    const input = buildMinimalValidInput();
    input.hardConstraints = input.hardConstraints.filter(
      (constraint) =>
        !(constraint.type === "TASK_REQUIRED" && constraint.taskId === input.tasks[0].taskId)
    );

    const result = validateRoutingProblemInput(input);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "MISSING_TASK_REQUIRED_CONSTRAINT",
        taskId: 101,
      })
    );
  });

  it("flags invalid travel matrix size", () => {
    const input = buildMinimalValidInput();
    input.travelMatrixMin.pop();

    const result = validateRoutingProblemInput(input);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "INVALID_TRAVEL_MATRIX_SIZE",
      })
    );
  });

  it("flags negative travel matrix value", () => {
    const input = buildMinimalValidInput();
    input.travelMatrixMin[0][1] = -5;

    const result = validateRoutingProblemInput(input);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "INVALID_TRAVEL_MATRIX_VALUE",
      })
    );
  });

  it("warns when priority windows are unavailable without failing validation", () => {
    const input = buildMinimalValidInput();
    input.windowConfig.priorityWindows = null;

    const result = validateRoutingProblemInput(input);

    expect(result.valid).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "PRIORITY_WINDOWS_UNAVAILABLE",
      })
    );
  });

  it("flags inconsistent task serviceDurationMin", () => {
    const input = buildMinimalValidInput();
    input.tasks[0].serviceDurationMin = 0;

    const result = validateRoutingProblemInput(input);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "INVALID_TASK_SERVICE_DURATION",
        taskId: 101,
      })
    );
  });

  it("flags duplicate TASK_REQUIRED constraint", () => {
    const input = buildMinimalValidInput();
    input.hardConstraints.push({
      type: "TASK_REQUIRED",
      taskId: input.tasks[0].taskId,
    });

    const result = validateRoutingProblemInput(input);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "DUPLICATE_HARD_CONSTRAINT",
        taskId: 101,
      })
    );
  });

  it("flags TASK_REQUIRED for unknown task", () => {
    const input = buildMinimalValidInput();
    input.hardConstraints.push({
      type: "TASK_REQUIRED",
      taskId: 999999,
    });

    const result = validateRoutingProblemInput(input);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "UNKNOWN_TASK_IN_CONSTRAINT",
        taskId: 999999,
      })
    );
  });

  it("flags DRIVER_WORK_WINDOW mismatch with driver.workWindow", () => {
    const input = buildMinimalValidInput();
    const driverConstraint = input.hardConstraints.find(
      (constraint) => constraint.type === "DRIVER_WORK_WINDOW" && constraint.driverId === 7
    );
    if (driverConstraint?.type === "DRIVER_WORK_WINDOW") {
      driverConstraint.startMin = 600;
    }

    const result = validateRoutingProblemInput(input);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "INVALID_HARD_CONSTRAINT",
        driverId: 7,
      })
    );
  });

  it("flags PREFERRED_PRIORITY_WINDOW for unknown task", () => {
    const input = buildMinimalValidInput();
    input.softConstraints.push({
      type: "PREFERRED_PRIORITY_WINDOW",
      taskId: 999999,
      startMin: 660,
      endMin: 900,
      penaltyPerMinOutside: 1,
    });

    const result = validateRoutingProblemInput(input);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "UNKNOWN_TASK_IN_CONSTRAINT",
        taskId: 999999,
      })
    );
  });

  it("flags invalid soft constraint weight", () => {
    const input = buildMinimalValidInput();
    const travel = input.softConstraints.find(
      (constraint) => constraint.type === "MINIMIZE_TOTAL_TRAVEL"
    );

    if (travel?.type === "MINIMIZE_TOTAL_TRAVEL") {
      travel.weight = 0;
    }

    const result = validateRoutingProblemInput(input);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "INVALID_SOFT_CONSTRAINT",
      })
    );
  });

  it("flags invalid nodeIndex without cascading travel matrix size error", () => {
    const input = buildMinimalValidInput();
    input.tasks[0].nodeIndex = 999;

    const result = validateRoutingProblemInput(input);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "INVALID_NODE_INDEX",
        taskId: 101,
      })
    );
    expect(result.errors.some((issue) => issue.code === "INVALID_TRAVEL_MATRIX_SIZE")).toBe(false);
  });
});
