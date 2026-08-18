import { describe, expect, it } from "vitest";
import { buildRoutingProblemInputFromSource } from "../server/services/logistics-optimizer-final/build-routing-input";
import type { LogisticsRoutingSourceData } from "../server/services/logistics-optimizer-final/loaders";
import type { PriorityWindows } from "../server/services/optimizer/priorityWindows";

const priorityWindows: PriorityWindows = {
  EO: { startMin: 0, endMin: 659, graceMin: 0 },
  HP: { startMin: 660, endMin: 930, graceMin: 0 },
  LP: { startMin: 660, endMin: null, graceMin: 0 },
};

function buildTask(
  taskId: number,
  overrides: Record<string, unknown> = {}
): LogisticsRoutingSourceData["schedulableTasks"][number] {
  return {
    taskId,
    logisticCode: 7000 + taskId,
    priority: "early_out",
    cleaningTime: 60,
    lat: 45.45,
    lng: 9.18,
    checkinDate: "2026-06-04",
    checkoutDate: "2026-06-04",
    checkinTime: "16:00",
    checkoutTime: "11:00",
    premium: false,
    straordinaria: false,
    paxIn: 2,
    cleanerId: 10,
    cleanerStartTime: "10:00",
    cleanerTaskStartTime: "10:00",
    cleanerSequence: 1,
    locked: false,
    lockedReason: null,
    logisticsTaskKind: "pick-up",
    logisticsTaskKindSource: "auto",
    ...overrides,
  };
}

describe("logistics invalid hard window exclusion", () => {
  it("esclude solo la task con finestra impossibile e tiene le altre nel pool", () => {
    const okTask = buildTask(101);
    // checkout dopo check-in → finestra inconsistente
    const badTask = buildTask(102, {
      checkoutTime: "17:00",
      checkinTime: "14:00",
      logisticCode: 88991,
    });

    const sourceData: LogisticsRoutingSourceData = {
      workDate: "2026-06-04",
      allTaskData: [okTask, badTask],
      unlockedTaskData: [okTask, badTask],
      schedulableTasks: [okTask, badTask],
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

    expect(input.tasks.map((task) => task.taskId)).toEqual([101]);
    expect(input.metadata.tasksExcludedInvalidHardWindowIds).toEqual([102]);
    expect(input.metadata.excludedTasks).toContainEqual(
      expect.objectContaining({
        taskId: 102,
        reason: "INVALID_HARD_WINDOW",
        logisticCode: 88991,
      })
    );
    expect(input.metadata.validation.valid).toBe(true);
  });
});
