import { describe, expect, it } from "vitest";
import { buildRoutingProblemInputFromSource } from "../server/services/logistics-optimizer-final/build-routing-input";
import type { LogisticsRoutingSourceData } from "../server/services/logistics-optimizer-final/loaders";
import { solveGreedyRouting } from "../server/services/logistics-optimizer-final/solver/greedy-routing-solver";
import { GREEDY_SOLVER_ID } from "../server/services/logistics-optimizer-final/solution-contract";
import { diagnoseDroppedTasks } from "../server/services/logistics-optimizer-final/unassigned-diagnostics";
import type { PriorityWindows } from "../server/services/optimizer/priorityWindows";

const priorityWindows: PriorityWindows = {
  EO: { startMin: 0, endMin: 659, graceMin: 0 },
  HP: { startMin: 660, endMin: 930, graceMin: 0 },
  LP: { startMin: 660, endMin: null, graceMin: 0 },
};

function buildSourceWithoutDrivers(): LogisticsRoutingSourceData {
  const task = {
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
  };

  return {
    workDate: "2026-06-04",
    allTaskData: [task],
    unlockedTaskData: [task],
    schedulableTasks: [task],
    lockedTasksExcluded: 0,
    tasksExcludedNoCoordinatesIds: [],
    selectedDrivers: [],
    timelineAssignmentHints: [],
    windowConfig: {
      source: "app_settings",
      workDate: "2026-06-04",
      priorityWindows,
      fallbackUsed: false,
    },
  };
}

describe("diagnoseDroppedTasks", () => {
  it("returns legacy-compatible diagnostics for dropped tasks", () => {
    const input = buildRoutingProblemInputFromSource(buildSourceWithoutDrivers());
    const solution = solveGreedyRouting(input);
    expect(solution.droppedTasks.length).toBeGreaterThan(0);

    const diagnostics = diagnoseDroppedTasks(input, solution);
    expect(diagnostics).toHaveLength(solution.droppedTasks.length);
    expect(diagnostics[0]).toMatchObject({
      taskId: 101,
      reason: expect.any(String),
      diagnostics: {
        failedDrivers: expect.any(Array),
      },
    });
  });

  it("uses TRULY_IMPOSSIBLE only when every checked driver fails solo simulation", () => {
    const source = buildSourceWithoutDrivers();
    source.selectedDrivers = [
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
    ];
    const input = buildRoutingProblemInputFromSource(source);
    input.tasks[0].hardWindow = {
      earliestStartMin: 0,
      latestStartMin: 0,
      latestEndMin: 0,
      reasons: ["forced_infeasible"],
    };

    const diagnostics = diagnoseDroppedTasks(input, {
      schemaVersion: "logistics-routing-solution/v1",
      solverId: GREEDY_SOLVER_ID,
      workDate: input.workDate,
      status: "INFEASIBLE",
      generatedAt: "2026-06-04T00:00:00.000Z",
      routes: [],
      droppedTasks: [{ taskId: 101, reason: "NO_FEASIBLE_DRIVER" }],
    });

    expect(diagnostics[0].reason).toBe("TRULY_IMPOSSIBLE");
    expect(diagnostics[0].diagnostics.failedDrivers).toHaveLength(2);
  });
});
