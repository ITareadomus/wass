import { describe, expect, it } from "vitest";
import { buildRoutingProblemInputFromSource } from "../server/services/logistics-optimizer-final/build-routing-input";
import type { LogisticsRoutingSourceData } from "../server/services/logistics-optimizer-final/loaders";
import type { RoutingProblemInput } from "../server/services/logistics-optimizer-final/input-contract";
import { solveGreedyRouting } from "../server/services/logistics-optimizer-final/solver/greedy-routing-solver";
import {
  GREEDY_SOLVER_ID,
  ROUTING_SOLUTION_SCHEMA_VERSION,
  type RoutingSolution,
} from "../server/services/logistics-optimizer-final/solution-contract";
import { validateRoutingSolution } from "../server/services/logistics-optimizer-final/solution-validation";
import {
  assertSolutionCanBeApplied,
  evaluateSolutionApplyGate,
  SolutionCannotBeAppliedError,
} from "../server/services/logistics-optimizer-final/solution-apply-gate";
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
}

function buildMinimalValidInput(): RoutingProblemInput {
  return buildRoutingProblemInputFromSource(buildMinimalSourceData());
}

function buildTwoTaskValidInput(): RoutingProblemInput {
  const secondTask = {
    taskId: 102,
    logisticCode: 5002,
    priority: "low_priority",
    cleaningTime: 30,
    lat: 45.485,
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
  };

  return buildRoutingProblemInputFromSource({
    ...buildMinimalSourceData(),
    schedulableTasks: [buildMinimalSourceData().schedulableTasks[0], secondTask],
    tasksExcludedNoCoordinatesIds: [],
  });
}

function buildNoDriverInput(): RoutingProblemInput {
  const input = buildMinimalValidInput();
  input.drivers = [];
  return input;
}

describe("solveGreedyRouting", () => {
  it("assigns a feasible single task", () => {
    const input = buildMinimalValidInput();
    const solution = solveGreedyRouting(input);

    expect(solution.schemaVersion).toBe(ROUTING_SOLUTION_SCHEMA_VERSION);
    expect(solution.solverId).toBe(GREEDY_SOLVER_ID);
    expect(solution.status).toBe("FEASIBLE");
    expect(solution.routes).toHaveLength(1);
    expect(solution.routes[0].stops).toHaveLength(1);
    expect(solution.routes[0].stops[0].taskId).toBe(101);
    expect(solution.droppedTasks).toHaveLength(0);
    expect(solution.objectiveBreakdown?.assignedTasks).toBe(1);
  });

  it("drops all tasks when no drivers are available", () => {
    const input = buildNoDriverInput();
    const solution = solveGreedyRouting(input);

    expect(solution.status).toBe("INFEASIBLE");
    expect(solution.routes).toHaveLength(0);
    expect(solution.droppedTasks).toHaveLength(1);
    expect(solution.droppedTasks[0]).toMatchObject({
      taskId: 101,
      reason: "NO_FEASIBLE_DRIVER",
    });
  });

  it("is deterministic for the same input", () => {
    const input = buildTwoTaskValidInput();
    const stableOptions = {
      generatedAt: "2026-06-04T00:00:00.000Z",
      solveDurationMs: 0,
    };
    const first = solveGreedyRouting(input, stableOptions);
    const second = solveGreedyRouting(input, stableOptions);

    expect(second).toEqual(first);
  });
});

describe("validateRoutingSolution", () => {
  it("accepts a greedy solution for a valid input", () => {
    const input = buildMinimalValidInput();
    const solution = solveGreedyRouting(input);
    const result = validateRoutingSolution(input, solution);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("flags duplicate assigned tasks", () => {
    const input = buildMinimalValidInput();
    const solution = solveGreedyRouting(input);
    const duplicated: RoutingSolution = {
      ...solution,
      routes: [
        ...solution.routes,
        {
          ...solution.routes[0],
          driverId: input.drivers[0].id,
          stops: solution.routes[0].stops.map((stop) => ({ ...stop })),
        },
      ],
    };

    const result = validateRoutingSolution(input, duplicated);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "DUPLICATE_ASSIGNED_TASK",
        taskId: 101,
      })
    );
  });

  it("flags travel matrix mismatch", () => {
    const input = buildMinimalValidInput();
    const solution = solveGreedyRouting(input);
    const mutated: RoutingSolution = {
      ...solution,
      routes: solution.routes.map((route) => ({
        ...route,
        stops: route.stops.map((stop) => ({
          ...stop,
          travelFromPreviousMin: stop.travelFromPreviousMin + 5,
        })),
      })),
    };

    const result = validateRoutingSolution(input, mutated);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "TRAVEL_MATRIX_MISMATCH",
        taskId: 101,
      })
    );
  });

  it("flags task partition mismatch", () => {
    const input = buildMinimalValidInput();
    const solution = solveGreedyRouting(input);
    const incomplete: RoutingSolution = {
      ...solution,
      droppedTasks: [],
      routes: [],
      status: "INFEASIBLE",
      objectiveBreakdown: {
        assignedTasks: 0,
        droppedTasks: 0,
        totalTravelMin: 0,
        totalWaitMin: 0,
      },
    };

    const result = validateRoutingSolution(input, incomplete);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "TASK_PARTITION_MISMATCH",
        taskId: 101,
      })
    );
  });

  it("flags hard window violation", () => {
    const input = buildMinimalValidInput();
    const solution = solveGreedyRouting(input);
    const violated: RoutingSolution = {
      ...solution,
      routes: solution.routes.map((route) => ({
        ...route,
        stops: route.stops.map((stop) => ({
          ...stop,
          startMin: input.tasks[0].hardWindow.latestStartMin + 30,
          endMin: input.tasks[0].hardWindow.latestStartMin + 30 + stop.serviceDurationMin,
          arrivalMin: input.tasks[0].hardWindow.latestStartMin + 20,
          waitMin: 10,
        })),
      })),
    };

    const result = validateRoutingSolution(input, violated);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "TASK_HARD_WINDOW_VIOLATION",
        taskId: 101,
      })
    );
  });

  it("flags duplicate dropped tasks", () => {
    const input = buildMinimalValidInput();
    const solution = solveGreedyRouting(input);
    const duplicatedDropped: RoutingSolution = {
      ...solution,
      routes: [],
      droppedTasks: [
        { taskId: 101, reason: "NO_FEASIBLE_DRIVER" },
        { taskId: 101, reason: "NO_FEASIBLE_DRIVER" },
      ],
      status: "INFEASIBLE",
      objectiveBreakdown: {
        assignedTasks: 0,
        droppedTasks: 2,
        totalTravelMin: 0,
        totalWaitMin: 0,
      },
    };

    const result = validateRoutingSolution(input, duplicatedDropped);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "DUPLICATE_DROPPED_TASK",
        taskId: 101,
      })
    );
  });

  it("flags invalid route sequence gaps", () => {
    const input = buildMinimalValidInput();
    const solution = solveGreedyRouting(input);
    const badSequence: RoutingSolution = {
      ...solution,
      routes: solution.routes.map((route) => ({
        ...route,
        stops: route.stops.map((stop) => ({
          ...stop,
          sequence: 2,
        })),
      })),
    };

    const result = validateRoutingSolution(input, badSequence);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "INVALID_ROUTE_SEQUENCE",
        driverId: input.drivers[0].id,
      })
    );
  });

  it("flags driver window violation", () => {
    const input = buildMinimalValidInput();
    const solution = solveGreedyRouting(input);
    const violated: RoutingSolution = {
      ...solution,
      routes: solution.routes.map((route) => ({
        ...route,
        endMin: input.drivers[0].workWindow.endMin + 60,
        stops: route.stops.map((stop) => ({
          ...stop,
          endMin: input.drivers[0].workWindow.endMin + 60,
        })),
      })),
    };

    const result = validateRoutingSolution(input, violated);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "DRIVER_WINDOW_VIOLATION",
        driverId: input.drivers[0].id,
      })
    );
  });

  it("flags previousTaskId inconsistent with route order", () => {
    const input = buildTwoTaskValidInput();
    const solution = solveGreedyRouting(input, {
      generatedAt: "2026-06-04T00:00:00.000Z",
      solveDurationMs: 0,
    });

    if (solution.routes[0]?.stops.length < 2) return;

    const mutated: RoutingSolution = {
      ...solution,
      routes: solution.routes.map((route) => ({
        ...route,
        stops: route.stops.map((stop, index) =>
          index === 1 ? { ...stop, previousTaskId: 999 } : stop
        ),
      })),
    };

    const result = validateRoutingSolution(input, mutated);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "PREVIOUS_TASK_MISMATCH",
      })
    );
  });

  it("flags incoherent route totals", () => {
    const input = buildMinimalValidInput();
    const solution = solveGreedyRouting(input);
    const mutated: RoutingSolution = {
      ...solution,
      routes: solution.routes.map((route) => ({
        ...route,
        totalTravelMin: route.totalTravelMin + 10,
      })),
    };

    const result = validateRoutingSolution(input, mutated);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "ROUTE_TOTALS_MISMATCH",
        driverId: input.drivers[0].id,
      })
    );
  });

  it("flags unsupported schema version as error", () => {
    const input = buildMinimalValidInput();
    const solution = solveGreedyRouting(input, {
      generatedAt: "2026-06-04T00:00:00.000Z",
      solveDurationMs: 0,
    });
    const mutated: RoutingSolution = {
      ...solution,
      schemaVersion: "logistics-routing-solution/v0" as RoutingSolution["schemaVersion"],
    };

    const result = validateRoutingSolution(input, mutated);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "UNSUPPORTED_SCHEMA_VERSION",
      })
    );
  });
});

describe("evaluateSolutionApplyGate", () => {
  function buildSolution(status: RoutingSolution["status"], droppedCount = 0): RoutingSolution {
    return {
      schemaVersion: ROUTING_SOLUTION_SCHEMA_VERSION,
      solverId: GREEDY_SOLVER_ID,
      workDate: "2026-06-04",
      status,
      generatedAt: "2026-06-04T00:00:00.000Z",
      routes: status === "INFEASIBLE" ? [] : [{ driverId: 7, startMin: 570, endMin: 615, totalServiceMin: 15, totalTravelMin: 0, totalWaitMin: 0, stops: [] }],
      droppedTasks: Array.from({ length: droppedCount }, (_, index) => ({
        taskId: 200 + index,
        reason: "NO_FEASIBLE_DRIVER" as const,
      })),
    };
  }

  it("allows FEASIBLE solutions", () => {
    expect(evaluateSolutionApplyGate(buildSolution("FEASIBLE"))).toEqual({
      canApply: true,
      reason: "OK",
      droppedTaskCount: 0,
    });
  });

  it("blocks PARTIAL unless allowPartial", () => {
    expect(evaluateSolutionApplyGate(buildSolution("PARTIAL", 1))).toEqual({
      canApply: false,
      reason: "PARTIAL_REQUIRES_ALLOW_PARTIAL",
      droppedTaskCount: 1,
    });
    expect(evaluateSolutionApplyGate(buildSolution("PARTIAL", 1), { allowPartial: true })).toEqual({
      canApply: true,
      reason: "OK",
      droppedTaskCount: 1,
    });
  });

  it("blocks INVALID and INFEASIBLE", () => {
    expect(evaluateSolutionApplyGate(buildSolution("INVALID")).canApply).toBe(false);
    expect(evaluateSolutionApplyGate(buildSolution("INFEASIBLE")).canApply).toBe(false);
    expect(() => assertSolutionCanBeApplied(buildSolution("INFEASIBLE"))).toThrow(
      SolutionCannotBeAppliedError
    );
  });
});
