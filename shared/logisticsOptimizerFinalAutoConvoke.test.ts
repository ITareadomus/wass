import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  computeAutoConvokeDriverPlan,
  autoConvokeLogisticsDriversWithPreAssignedTasks,
  AUTO_CONVOKED_PREASSIGNED_ACTION,
} from "../server/services/logistics-optimizer-final/auto-convoke-logistics-drivers";
import {
  buildRoutingProblemInputFromSource,
  buildLogisticsRoutingInput,
} from "../server/services/logistics-optimizer-final/build-routing-input";
import type { LogisticsRoutingSourceData } from "../server/services/logistics-optimizer-final/loaders";
import {
  parsePreAssignedTimelineEntries,
  buildRequiredDriverConstraints,
} from "../server/services/logistics-optimizer-final/timeline-assignment-hints";
import type { PriorityWindows } from "../server/services/optimizer/priorityWindows";

const priorityWindows: PriorityWindows = {
  EO: { startMin: 0, endMin: 659, graceMin: 0 },
  HP: { startMin: 660, endMin: 930, graceMin: 0 },
  LP: { startMin: 660, endMin: null, graceMin: 0 },
};

function buildBaseSourceData(overrides: Partial<LogisticsRoutingSourceData> = {}): LogisticsRoutingSourceData {
  const task101 = {
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
    ],
    timelineAssignmentHints: [
      {
        taskId: 101,
        driverId: 8,
        source: "timeline",
        sequence: 1,
        manuallyMoved: false,
      },
    ],
    windowConfig: {
      source: "app_settings",
      workDate: "2026-06-04",
      priorityWindows,
      fallbackUsed: false,
    },
    ...overrides,
  };
}

vi.mock("../server/services/workspace-files", () => ({
  loadLogisticsTimeline: vi.fn(),
  loadSelectedLogisticsDrivers: vi.fn(),
  saveSelectedLogisticsDrivers: vi.fn(),
}));

vi.mock("../server/services/pg-daily-assignments-service", () => ({
  pgDailyAssignmentsService: {
    loadLgDriversByIds: vi.fn(),
  },
}));

vi.mock("../server/services/logistics-optimizer-final/loaders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/services/logistics-optimizer-final/loaders")>();
  return {
    ...actual,
    loadLogisticsRoutingSourceData: vi.fn(),
  };
});

import * as workspaceFiles from "../server/services/workspace-files";
import { pgDailyAssignmentsService } from "../server/services/pg-daily-assignments-service";
import { loadLogisticsRoutingSourceData } from "../server/services/logistics-optimizer-final/loaders";

describe("parsePreAssignedTimelineEntries", () => {
  it("extracts hints and unique driver ids from timeline", () => {
    const result = parsePreAssignedTimelineEntries({
      drivers_assignments: [
        {
          driver: { id: 8 },
          tasks: [{ task_id: 101, sequence: 1, manually_moved: false }],
        },
        {
          driver: { id: 9 },
          tasks: [{ task_id: 102, sequence: 1, locked: true }],
        },
      ],
    });

    expect(result.hints).toEqual([
      {
        taskId: 101,
        driverId: 8,
        source: "timeline",
        sequence: 1,
        manuallyMoved: false,
      },
    ]);
    expect(result.driverIdsWithPreAssignedTasks).toEqual([8]);
  });

  it("returns empty result for invalid timeline", () => {
    expect(parsePreAssignedTimelineEntries(null)).toEqual({
      hints: [],
      driverIdsWithPreAssignedTasks: [],
    });
  });
});

describe("computeAutoConvokeDriverPlan", () => {
  it("appends convokable drivers preserving existing order", () => {
    const plan = computeAutoConvokeDriverPlan({
      timelineDriverIds: [7, 8],
      selectedDriverIds: [7],
      foundInDbDriverIds: [8],
    });

    expect(plan.autoConvokedDriverIds).toEqual([8]);
    expect(plan.missingInDbDriverIds).toEqual([]);
    expect(plan.mergedDriverIds).toEqual([7, 8]);
  });

  it("reports missingInDb for timeline drivers not found in lg_drivers", () => {
    const plan = computeAutoConvokeDriverPlan({
      timelineDriverIds: [99],
      selectedDriverIds: [7],
      foundInDbDriverIds: [],
    });

    expect(plan.autoConvokedDriverIds).toEqual([]);
    expect(plan.missingInDbDriverIds).toEqual([99]);
    expect(plan.mergedDriverIds).toEqual([7]);
  });
});

describe("autoConvokeLogisticsDriversWithPreAssignedTasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists merged selected drivers when pre-assigned driver is missing", async () => {
    vi.mocked(workspaceFiles.loadLogisticsTimeline).mockResolvedValue({
      drivers_assignments: [
        {
          driver: { id: 8 },
          tasks: [{ task_id: 101, sequence: 1 }],
        },
      ],
    });
    vi.mocked(workspaceFiles.loadSelectedLogisticsDrivers).mockResolvedValue({
      drivers: [{ id: 7, name: "A", lastname: "One", role: "Driver", start_time: "09:30", end_time: "20:00" }],
      total_selected: 1,
    });
    vi.mocked(pgDailyAssignmentsService.loadLgDriversByIds).mockResolvedValue([
      { id: 8, name: "B", lastname: "Two", role: "Driver", start_time: "09:30", end_time: "20:00" },
    ]);
    vi.mocked(workspaceFiles.saveSelectedLogisticsDrivers).mockResolvedValue(true);

    const result = await autoConvokeLogisticsDriversWithPreAssignedTasks("2026-06-04", {
      performedBy: "test-user",
    });

    expect(result.autoConvokedDriverIds).toEqual([8]);
    expect(result.saved).toBe(true);
    expect(workspaceFiles.saveSelectedLogisticsDrivers).toHaveBeenCalledWith(
      "2026-06-04",
      expect.objectContaining({
        total_selected: 2,
        drivers: expect.arrayContaining([
          expect.objectContaining({ id: 7 }),
          expect.objectContaining({ id: 8 }),
        ]),
      }),
      false,
      "test-user",
      AUTO_CONVOKED_PREASSIGNED_ACTION
    );
  });

  it("does not persist when saveSelectedDrivers is false", async () => {
    vi.mocked(workspaceFiles.loadLogisticsTimeline).mockResolvedValue({
      drivers_assignments: [
        {
          driver: { id: 8 },
          tasks: [{ task_id: 101 }],
        },
      ],
    });
    vi.mocked(workspaceFiles.loadSelectedLogisticsDrivers).mockResolvedValue({
      drivers: [{ id: 7 }],
      total_selected: 1,
    });
    vi.mocked(pgDailyAssignmentsService.loadLgDriversByIds).mockResolvedValue([{ id: 8 }]);

    const result = await autoConvokeLogisticsDriversWithPreAssignedTasks("2026-06-04", {
      saveSelectedDrivers: false,
    });

    expect(result.autoConvokedDriverIds).toEqual([8]);
    expect(result.saved).toBe(false);
    expect(workspaceFiles.saveSelectedLogisticsDrivers).not.toHaveBeenCalled();
  });

  it("returns no-op when driver is already selected", async () => {
    vi.mocked(workspaceFiles.loadLogisticsTimeline).mockResolvedValue({
      drivers_assignments: [
        {
          driver: { id: 7 },
          tasks: [{ task_id: 101 }],
        },
      ],
    });
    vi.mocked(workspaceFiles.loadSelectedLogisticsDrivers).mockResolvedValue({
      drivers: [{ id: 7 }],
      total_selected: 1,
    });

    const result = await autoConvokeLogisticsDriversWithPreAssignedTasks("2026-06-04");

    expect(result.autoConvokedDriverIds).toEqual([]);
    expect(result.saved).toBe(false);
    expect(pgDailyAssignmentsService.loadLgDriversByIds).not.toHaveBeenCalled();
  });
});

describe("buildRoutingProblemInputFromSource pre-assigned + selected drivers", () => {
  it("skips REQUIRED when pre-assigned driver is not selected", () => {
    const sourceData = buildBaseSourceData();
    const input = buildRoutingProblemInputFromSource(sourceData);

    expect(input.metadata.skippedTimelineAssignmentHintsCount).toBe(1);
    expect(
      input.hardConstraints.filter((constraint) => constraint.type === "REQUIRED_DRIVER_TASK")
    ).toHaveLength(0);
  });

  it("creates REQUIRED when pre-assigned driver is selected (post auto-convoke)", () => {
    const sourceData = buildBaseSourceData({
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
    });
    const input = buildRoutingProblemInputFromSource(sourceData, {
      autoConvokeResult: {
        workDate: "2026-06-04",
        autoConvokedDriverIds: [8],
        alreadySelectedDriverIds: [7],
        missingInDbDriverIds: [],
        saved: true,
      },
    });

    expect(input.metadata.skippedTimelineAssignmentHintsCount).toBe(0);
    expect(input.metadata.autoConvokedDriverIds).toEqual([8]);
    expect(input.metadata.autoConvokedDriversCount).toBe(1);
    expect(input.hardConstraints).toContainEqual(
      expect.objectContaining({
        type: "REQUIRED_DRIVER_TASK",
        taskId: 101,
        driverId: 8,
      })
    );
  });
});

describe("buildRequiredDriverConstraints driver-not-selected skip", () => {
  it("skips hint when driver is not selected", () => {
    const result = buildRequiredDriverConstraints({
      hints: [
        {
          taskId: 101,
          driverId: 8,
          source: "timeline",
          sequence: 1,
          manuallyMoved: false,
        },
      ],
      schedulableTaskIds: [101],
      selectedDriverIds: [7],
    });

    expect(result.skippedHints).toHaveLength(1);
    expect(result.constraints).toHaveLength(0);
  });
});

describe("buildLogisticsRoutingInput auto-convoke hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls auto-convoke before loading source data", async () => {
    vi.mocked(workspaceFiles.loadLogisticsTimeline).mockResolvedValue({
      drivers_assignments: [{ driver: { id: 8 }, tasks: [{ task_id: 101 }] }],
    });
    vi.mocked(workspaceFiles.loadSelectedLogisticsDrivers).mockResolvedValue({
      drivers: [{ id: 7 }],
      total_selected: 1,
    });
    vi.mocked(pgDailyAssignmentsService.loadLgDriversByIds).mockResolvedValue([{ id: 8 }]);
    vi.mocked(workspaceFiles.saveSelectedLogisticsDrivers).mockResolvedValue(true);

    const sourceAfterConvoke = buildBaseSourceData({
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
    });
    vi.mocked(loadLogisticsRoutingSourceData).mockResolvedValue(sourceAfterConvoke);

    const input = await buildLogisticsRoutingInput("2026-06-04", {
      performedBy: "test-user",
    });

    expect(workspaceFiles.saveSelectedLogisticsDrivers).toHaveBeenCalled();
    expect(loadLogisticsRoutingSourceData).toHaveBeenCalledWith("2026-06-04");
    expect(input.metadata.autoConvokedDriverIds).toEqual([8]);
    expect(input.metadata.skippedTimelineAssignmentHintsCount).toBe(0);
    expect(
      input.hardConstraints.filter((constraint) => constraint.type === "REQUIRED_DRIVER_TASK")
    ).toHaveLength(1);
  });

  it("skips auto-convoke when skipAutoConvoke is true", async () => {
    const sourceData = buildBaseSourceData();
    vi.mocked(loadLogisticsRoutingSourceData).mockResolvedValue(sourceData);

    const input = await buildLogisticsRoutingInput("2026-06-04", { skipAutoConvoke: true });

    expect(workspaceFiles.loadLogisticsTimeline).not.toHaveBeenCalled();
    expect(input.metadata.skippedTimelineAssignmentHintsCount).toBe(1);
    expect(input.metadata.autoConvokedDriversCount).toBe(0);
  });
});
