import { describe, expect, it } from "vitest";
import { buildRoutingProblemInputFromSource } from "../server/services/logistics-optimizer-final/build-routing-input";
import type { LogisticsRoutingSourceData } from "../server/services/logistics-optimizer-final/loaders";
import type { RoutingProblemInput } from "../server/services/logistics-optimizer-final/input-contract";
import { solveGreedyRouting } from "../server/services/logistics-optimizer-final/solver/greedy-routing-solver";
import type { RoutingSolution } from "../server/services/logistics-optimizer-final/solution-contract";
import { validateRoutingSolution } from "../server/services/logistics-optimizer-final/solution-validation";
import { validateRoutingProblemInput } from "../server/services/logistics-optimizer-final/validation";
import { buildRequiredDriverConstraints } from "../server/services/logistics-optimizer-final/timeline-assignment-hints";
import type { PriorityWindows } from "../server/services/optimizer/priorityWindows";

const priorityWindows: PriorityWindows = {
  EO: { startMin: 0, endMin: 659, graceMin: 0 },
  HP: { startMin: 660, endMin: 930, graceMin: 0 },
  LP: { startMin: 660, endMin: null, graceMin: 0 },
};

function buildBaseTask(taskId: number, overrides: Record<string, unknown> = {}) {
  return {
    taskId,
    logisticCode: 5000 + taskId,
    priority: "early_out",
    cleaningTime: 60,
    lat: 45.45 + taskId * 0.001,
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
    ...overrides,
  };
}

function buildBaseSourceData(overrides: Partial<LogisticsRoutingSourceData> = {}): LogisticsRoutingSourceData {
  const task101 = buildBaseTask(101);
  return {
    workDate: "2026-06-04",
    allTaskData: [task101],
    unlockedTaskData: [task101],
    schedulableTasks: [task101],
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
      {
        id: 8,
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
    ...overrides,
  };
}

describe("buildRequiredDriverConstraints", () => {
  it("returns zero REQUIRED when there are no hints", () => {
    const result = buildRequiredDriverConstraints({
      hints: [],
      schedulableTaskIds: [101],
      selectedDriverIds: [7],
    });

    expect(result.constraints).toEqual([]);
    expect(result.skippedHints).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("product default: does not create REQUIRED_DRIVER_TASK from timeline hints", () => {
    const result = buildRequiredDriverConstraints({
      hints: [
        {
          taskId: 101,
          driverId: 7,
          source: "timeline",
          sequence: 1,
          manuallyMoved: false,
        },
      ],
      schedulableTaskIds: [101],
      selectedDriverIds: [7],
    });

    expect(result.constraints).toEqual([]);
    expect(result.skippedHints).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("creates REQUIRED_DRIVER_TASK for a valid pre-assigned task when locks enabled", () => {
    const result = buildRequiredDriverConstraints({
      enableTimelineRequiredDriverLocks: true,
      hints: [
        {
          taskId: 101,
          driverId: 7,
          source: "timeline",
          sequence: 1,
          manuallyMoved: false,
        },
      ],
      schedulableTaskIds: [101],
      selectedDriverIds: [7],
    });

    expect(result.constraints).toEqual([
      {
        type: "REQUIRED_DRIVER_TASK",
        taskId: 101,
        driverId: 7,
        source: "timeline_pre_assigned",
      },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("preserves manuallyMoved metadata without extra lock semantics when locks enabled", () => {
    const result = buildRequiredDriverConstraints({
      enableTimelineRequiredDriverLocks: true,
      hints: [
        {
          taskId: 101,
          driverId: 7,
          source: "timeline",
          sequence: 2,
          manuallyMoved: true,
        },
      ],
      schedulableTaskIds: [101],
      selectedDriverIds: [7],
    });

    expect(result.constraints[0]).toMatchObject({
      type: "REQUIRED_DRIVER_TASK",
      manuallyMoved: true,
    });
  });

  it("skips hints for non-schedulable tasks when locks enabled", () => {
    const hint = {
      taskId: 999,
      driverId: 7,
      source: "timeline" as const,
      sequence: null,
      manuallyMoved: false,
    };
    const result = buildRequiredDriverConstraints({
      enableTimelineRequiredDriverLocks: true,
      hints: [hint],
      schedulableTaskIds: [101],
      selectedDriverIds: [7],
    });

    expect(result.constraints).toEqual([]);
    expect(result.skippedHints).toEqual([hint]);
  });

  it("skips hints for non-selected drivers when locks enabled", () => {
    const hint = {
      taskId: 101,
      driverId: 99,
      source: "timeline" as const,
      sequence: null,
      manuallyMoved: false,
    };
    const result = buildRequiredDriverConstraints({
      enableTimelineRequiredDriverLocks: true,
      hints: [hint],
      schedulableTaskIds: [101],
      selectedDriverIds: [7],
    });

    expect(result.constraints).toEqual([]);
    expect(result.skippedHints).toEqual([hint]);
  });

  it("returns MULTIPLE_REQUIRED_DRIVERS_FOR_TASK when same task has different drivers and locks enabled", () => {
    const result = buildRequiredDriverConstraints({
      enableTimelineRequiredDriverLocks: true,
      hints: [
        {
          taskId: 101,
          driverId: 7,
          source: "timeline",
          sequence: 1,
          manuallyMoved: false,
        },
        {
          taskId: 101,
          driverId: 8,
          source: "timeline",
          sequence: 1,
          manuallyMoved: false,
        },
      ],
      schedulableTaskIds: [101],
      selectedDriverIds: [7, 8],
    });

    expect(result.constraints).toEqual([]);
    expect(result.errors).toEqual([
      {
        code: "MULTIPLE_REQUIRED_DRIVERS_FOR_TASK",
        taskId: 101,
        driverIds: [7, 8],
      },
    ]);
  });
});

function injectTimelineRequiredDriverTask(
  input: RoutingProblemInput,
  taskId: number,
  driverId: number
): void {
  input.hardConstraints.push({
    type: "REQUIRED_DRIVER_TASK",
    taskId,
    driverId,
    source: "timeline_pre_assigned",
  });
  input.metadata.preAssignedRequiredCount += 1;
}

describe("buildRoutingProblemInputFromSource timeline integration", () => {
  it("excludes task locked nei containers from tasks and REQUIRED", () => {
    const lockedTask = buildBaseTask(103, { locked: true, lockedReason: "manual_lock" });
    const input = buildRoutingProblemInputFromSource(
      buildBaseSourceData({
        allTaskData: [buildBaseTask(101), lockedTask],
        unlockedTaskData: [buildBaseTask(101)],
        schedulableTasks: [buildBaseTask(101)],
        lockedTasksExcluded: 1,
        timelineAssignmentHints: [
          {
            taskId: 103,
            driverId: 7,
            source: "timeline",
            sequence: 1,
            manuallyMoved: false,
          },
        ],
      })
    );

    expect(input.tasks.map((task) => task.taskId)).toEqual([101]);
    expect(
      input.hardConstraints.filter((constraint) => constraint.type === "REQUIRED_DRIVER_TASK")
    ).toHaveLength(0);
    expect(input.metadata.skippedTimelineAssignmentHintsCount).toBe(0);
  });

  it("keeps pre-assigned tasks in tasks[] without REQUIRED_DRIVER_TASK lock", () => {
    const input = buildRoutingProblemInputFromSource(
      buildBaseSourceData({
        timelineAssignmentHints: [
          {
            taskId: 101,
            driverId: 7,
            source: "timeline",
            sequence: 1,
            manuallyMoved: false,
          },
        ],
      })
    );

    expect(input.tasks.map((task) => task.taskId)).toEqual([101]);
    expect(
      input.hardConstraints.filter((constraint) => constraint.type === "REQUIRED_DRIVER_TASK")
    ).toHaveLength(0);
    expect(input.metadata.preAssignedRequiredCount).toBe(0);
    expect(input.metadata.timelineAssignmentHintsCount).toBe(1);
    expect(input.metadata.lockedAssignmentsSolverIntegration).toBe("integrated_v4b");
  });
});

describe("validateRoutingProblemInput REQUIRED_DRIVER_TASK", () => {
  it("errors when REQUIRED references unknown task", () => {
    const input = buildRoutingProblemInputFromSource(buildBaseSourceData());
    input.hardConstraints.push({
      type: "REQUIRED_DRIVER_TASK",
      taskId: 999,
      driverId: 7,
      source: "timeline_pre_assigned",
    });

    const result = validateRoutingProblemInput(input);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "UNKNOWN_TASK_IN_CONSTRAINT",
        taskId: 999,
      })
    );
  });

  it("errors on duplicate REQUIRED_DRIVER_TASK for same task", () => {
    const input = buildRoutingProblemInputFromSource(buildBaseSourceData());
    input.hardConstraints.push(
      {
        type: "REQUIRED_DRIVER_TASK",
        taskId: 101,
        driverId: 7,
        source: "timeline_pre_assigned",
      },
      {
        type: "REQUIRED_DRIVER_TASK",
        taskId: 101,
        driverId: 7,
        source: "timeline_pre_assigned",
      }
    );

    const result = validateRoutingProblemInput(input);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "DUPLICATE_REQUIRED_DRIVER_TASK",
        taskId: 101,
      })
    );
  });

  it("does not emit LOCKED_ASSIGNMENTS_NOT_SOLVER_INTEGRATED", () => {
    const input = buildRoutingProblemInputFromSource(
      buildBaseSourceData({
        timelineAssignmentHints: [
          {
            taskId: 101,
            driverId: 7,
            source: "timeline",
            sequence: 1,
            manuallyMoved: true,
          },
        ],
      })
    );

    const result = validateRoutingProblemInput(input);

    expect(result.warnings.map((warning) => warning.code)).not.toContain(
      "LOCKED_ASSIGNMENTS_NOT_SOLVER_INTEGRATED"
    );
  });

  it("does not surface MULTIPLE_REQUIRED_DRIVERS_FOR_TASK while timeline locks are disabled", () => {
    const input = buildRoutingProblemInputFromSource(
      buildBaseSourceData({
        timelineAssignmentHints: [
          {
            taskId: 101,
            driverId: 7,
            source: "timeline",
            sequence: 1,
            manuallyMoved: false,
          },
          {
            taskId: 101,
            driverId: 8,
            source: "timeline",
            sequence: 1,
            manuallyMoved: false,
          },
        ],
      })
    );

    expect(input.metadata.preAssignedRequiredCount).toBe(0);
    expect(input.metadata.validation.errors).not.toContainEqual(
      expect.objectContaining({
        code: "MULTIPLE_REQUIRED_DRIVERS_FOR_TASK",
      })
    );
  });
});

describe("solveGreedyRouting REQUIRED_DRIVER_TASK", () => {
  it("assigns required task to the mandated driver", () => {
    const input = buildRoutingProblemInputFromSource(buildBaseSourceData());
    injectTimelineRequiredDriverTask(input, 101, 8);
    const solution = solveGreedyRouting(input, {
      generatedAt: "2026-06-04T00:00:00.000Z",
      solveDurationMs: 0,
    });

    expect(solution.status).toBe("FEASIBLE");
    expect(solution.routes).toHaveLength(1);
    expect(solution.routes[0].driverId).toBe(8);
    expect(solution.routes[0].stops[0].taskId).toBe(101);
  });

  it("schedules required tasks before free tasks on the same driver", () => {
    const freeTask = buildBaseTask(102, {
      priority: "low_priority",
      cleanerTaskStartTime: "12:00",
      cleanerStartTime: "12:00",
    });
    const input = buildRoutingProblemInputFromSource(
      buildBaseSourceData({
        allTaskData: [buildBaseTask(101), freeTask],
        unlockedTaskData: [buildBaseTask(101), freeTask],
        schedulableTasks: [buildBaseTask(101), freeTask],
      })
    );
    injectTimelineRequiredDriverTask(input, 102, 7);
    const solution = solveGreedyRouting(input, {
      generatedAt: "2026-06-04T00:00:00.000Z",
      solveDurationMs: 0,
    });

    const route = solution.routes.find((entry) => entry.driverId === 7);
    expect(route).toBeDefined();
    expect(route!.stops.map((stop) => stop.taskId)).toEqual([102, 101]);
  });

  it("drops required task with REQUIRED_DRIVER_INFEASIBLE and INVALID status", () => {
    const input = buildRoutingProblemInputFromSource(buildBaseSourceData());
    injectTimelineRequiredDriverTask(input, 101, 7);
    input.tasks[0].hardWindow = {
      earliestStartMin: 1200,
      latestStartMin: 1200,
      latestEndMin: 1205,
      reasons: [],
    };
    const matchingWindow = input.hardConstraints.find(
      (constraint) => constraint.type === "TASK_TIME_WINDOW" && constraint.taskId === 101
    );
    if (matchingWindow && matchingWindow.type === "TASK_TIME_WINDOW") {
      matchingWindow.earliestStartMin = 1200;
      matchingWindow.latestStartMin = 1200;
      matchingWindow.latestEndMin = 1205;
    }

    const solution = solveGreedyRouting(input, {
      generatedAt: "2026-06-04T00:00:00.000Z",
      solveDurationMs: 0,
    });

    expect(solution.status).toBe("INVALID");
    expect(solution.droppedTasks).toContainEqual(
      expect.objectContaining({
        taskId: 101,
        reason: "REQUIRED_DRIVER_INFEASIBLE",
      })
    );

    const validation = validateRoutingSolution(input, solution);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContainEqual(
      expect.objectContaining({
        code: "REQUIRED_DRIVER_DROPPED",
        taskId: 101,
      })
    );
  });
});

describe("validateRoutingSolution REQUIRED_DRIVER_TASK", () => {
  it("flags REQUIRED_DRIVER_VIOLATION when task is on wrong driver", () => {
    const input = buildRoutingProblemInputFromSource(buildBaseSourceData());
    injectTimelineRequiredDriverTask(input, 101, 7);
    const solution = solveGreedyRouting(input, {
      generatedAt: "2026-06-04T00:00:00.000Z",
      solveDurationMs: 0,
    });

    const mutated: RoutingSolution = {
      ...solution,
      status: "FEASIBLE",
      routes: solution.routes.map((route) => ({
        ...route,
        driverId: route.driverId === 7 ? 8 : route.driverId,
      })),
    };

    const result = validateRoutingSolution(input, mutated);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "REQUIRED_DRIVER_VIOLATION",
        taskId: 101,
      })
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "INVALID_SOLUTION_STATUS",
      })
    );
  });
});
