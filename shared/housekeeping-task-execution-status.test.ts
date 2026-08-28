import { describe, expect, it } from "vitest";
import {
  isHousekeepingTaskCleaned,
  mergeHousekeepingExecutionStatusIntoTasks,
  parseHousekeepingFlag,
  parseHousekeepingStartworkAtMs,
  pickHousekeepingExecutionStatusFields,
  resolveHousekeepingCleaningMinutes,
  resolveHousekeepingTaskExecutionStatus,
  resolveHousekeepingWorkProgress,
} from "./housekeeping-task-execution-status";

describe("resolveHousekeepingTaskExecutionStatus", () => {
  it("maps startwork 0 and cleaned 0 to not started", () => {
    expect(
      resolveHousekeepingTaskExecutionStatus({ startwork: 0, cleaned: 0 })
    ).toBe("not_started");
  });

  it("maps startwork 1 to in progress", () => {
    expect(
      resolveHousekeepingTaskExecutionStatus({ startwork: 1, cleaned: 0 })
    ).toBe("in_progress");
  });

  it("maps cleaned 1 to completed even if startwork is 1", () => {
    expect(
      resolveHousekeepingTaskExecutionStatus({ startwork: 1, cleaned: 1 })
    ).toBe("completed");
  });

  it("maps cleaned 1 to completed even if startwork is 0", () => {
    expect(
      resolveHousekeepingTaskExecutionStatus({ startwork: 0, cleaned: 1 })
    ).toBe("completed");
  });
});

describe("parseHousekeepingFlag", () => {
  it("parses tinyint and strings", () => {
    expect(parseHousekeepingFlag(1)).toBe(true);
    expect(parseHousekeepingFlag("true")).toBe(true);
    expect(parseHousekeepingFlag(0)).toBe(false);
  });
});

describe("isHousekeepingTaskCleaned", () => {
  it("locks cleaned=1 even without execution status", () => {
    expect(isHousekeepingTaskCleaned({ cleaned: 1, startwork: 0 })).toBe(true);
  });

  it("locks completed execution status", () => {
    expect(
      isHousekeepingTaskCleaned({ housekeeping_execution_status: "completed" })
    ).toBe(true);
  });

  it("allows in-progress and not started tasks", () => {
    expect(isHousekeepingTaskCleaned({ cleaned: 0, startwork: 1 })).toBe(false);
    expect(
      isHousekeepingTaskCleaned({ housekeeping_execution_status: "in_progress" })
    ).toBe(false);
  });
});

describe("mergeHousekeepingExecutionStatusIntoTasks", () => {
  it("patches only changed execution fields and keeps other task data", () => {
    const tasks = [
      {
        id: "101",
        task_id: 101,
        start_time: "10:00",
        startwork: false,
        cleaned: false,
        housekeeping_execution_status: "not_started",
      },
      {
        id: "102",
        task_id: 102,
        startwork: true,
        cleaned: false,
        housekeeping_execution_status: "in_progress",
      },
    ];

    const { tasks: next, changed } = mergeHousekeepingExecutionStatusIntoTasks(
      tasks,
      {
        "101": {
          startwork: true,
          cleaned: false,
          startwork_at: "2026-08-20 10:00:00",
          housekeeping_execution_status: "in_progress",
        },
        "102": {
          startwork: true,
          cleaned: false,
          startwork_at: null,
          housekeeping_execution_status: "in_progress",
        },
      }
    );

    expect(changed).toBe(true);
    expect(next[0].housekeeping_execution_status).toBe("in_progress");
    expect(next[0].startwork).toBe(true);
    expect(next[0].start_time).toBe("10:00");
    expect(next[1]).toBe(tasks[1]);
  });

  it("returns the same array when nothing changed", () => {
    const tasks = [
      {
        id: "101",
        startwork: true,
        cleaned: true,
        housekeeping_execution_status: "completed",
      },
    ];
    const { tasks: next, changed } = mergeHousekeepingExecutionStatusIntoTasks(
      tasks,
      {
        "101": {
          startwork: true,
          cleaned: true,
          startwork_at: null,
          housekeeping_execution_status: "completed",
        },
      }
    );
    expect(changed).toBe(false);
    expect(next).toBe(tasks);
  });
});

describe("pickHousekeepingExecutionStatusFields", () => {
  it("preserves status for timeline mappers", () => {
    const picked = pickHousekeepingExecutionStatusFields({
      startwork: 1,
      cleaned: 0,
      housekeeping_execution_status: "in_progress",
    });
    expect(picked.housekeeping_execution_status).toBe("in_progress");
    expect(picked.startwork).toBe(true);
    expect(picked.cleaned).toBe(false);
  });
});

describe("resolveHousekeepingCleaningMinutes", () => {
  it("returns 0 when cleaning_time is missing or zero", () => {
    expect(resolveHousekeepingCleaningMinutes({})).toBe(0);
    expect(resolveHousekeepingCleaningMinutes({ cleaning_time: 0 })).toBe(0);
    expect(resolveHousekeepingCleaningMinutes({ duration: "0.0" })).toBe(0);
  });

  it("uses cleaning_time minutes when present", () => {
    expect(resolveHousekeepingCleaningMinutes({ cleaning_time: 90 })).toBe(90);
  });
});

describe("resolveHousekeepingWorkProgress", () => {
  const startMs = parseHousekeepingStartworkAtMs("2026-08-20T08:00:00.000Z");

  it("returns null when cleaning time is missing or zero", () => {
    expect(
      resolveHousekeepingWorkProgress({
        status: "in_progress",
        startworkAt: "2026-08-20T08:00:00.000Z",
        cleaningMinutes: 0,
        nowMs: (startMs ?? 0) + 30 * 60_000,
      })
    ).toBeNull();
  });

  it("fills to 50% halfway through cleaning_time", () => {
    const progress = resolveHousekeepingWorkProgress({
      status: "in_progress",
      startworkAt: "2026-08-20T08:00:00.000Z",
      cleaningMinutes: 60,
      nowMs: (startMs ?? 0) + 30 * 60_000,
    });
    expect(progress?.percent).toBe(50);
    expect(progress?.remainingMinutes).toBe(30);
    expect(progress?.overdue).toBe(false);
  });

  it("is overdue at 100% after cleaning_time elapses", () => {
    const progress = resolveHousekeepingWorkProgress({
      status: "in_progress",
      startworkAt: "2026-08-20T08:00:00.000Z",
      cleaningMinutes: 60,
      nowMs: (startMs ?? 0) + 90 * 60_000,
    });
    expect(progress?.percent).toBe(100);
    expect(progress?.remainingMinutes).toBe(0);
    expect(progress?.overdue).toBe(true);
  });
});
