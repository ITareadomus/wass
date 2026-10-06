import { describe, expect, it } from "vitest";
import {
  WASS_CLEANING_SPLIT_MANUAL_REASON,
  WASS_CLEANING_TIME_MANUAL_REASON,
  applyWassCleaningTimeOverride,
  collectManualCleaningTimeOverrides,
  hasManualCleaningSplit,
  hasManualCleaningTime,
  restoreManualCleaningTimeOverrides,
  splitCleaningTimeAcrossCollaborators,
  withManualCleaningSplitReason,
  withManualCleaningTimeReason,
  withoutManualCleaningSplitReason,
} from "./wass-cleaning-time";

describe("hasManualCleaningTime", () => {
  it("detects the marker on reasons arrays and task objects", () => {
    expect(hasManualCleaningTime([WASS_CLEANING_TIME_MANUAL_REASON])).toBe(true);
    expect(hasManualCleaningTime({ reasons: [WASS_CLEANING_TIME_MANUAL_REASON] })).toBe(
      true
    );
    expect(hasManualCleaningTime({ reasons: ["preassigned_enable_wass"] })).toBe(false);
    expect(hasManualCleaningTime(null)).toBe(false);
  });
});

describe("withManualCleaningTimeReason", () => {
  it("appends the marker without duplicating it", () => {
    expect(withManualCleaningTimeReason(["preassigned_enable_wass"])).toEqual([
      "preassigned_enable_wass",
      WASS_CLEANING_TIME_MANUAL_REASON,
    ]);
    expect(
      withManualCleaningTimeReason([WASS_CLEANING_TIME_MANUAL_REASON, WASS_CLEANING_TIME_MANUAL_REASON])
    ).toEqual([WASS_CLEANING_TIME_MANUAL_REASON]);
  });
});

describe("manual cleaning split marker", () => {
  it("adds, detects and removes the marker", () => {
    const marked = withManualCleaningSplitReason(["preassigned_enable_wass"]);
    expect(marked).toEqual([
      "preassigned_enable_wass",
      WASS_CLEANING_SPLIT_MANUAL_REASON,
    ]);
    expect(hasManualCleaningSplit({ reasons: marked })).toBe(true);
    expect(hasManualCleaningSplit({ reasons: ["preassigned_enable_wass"] })).toBe(false);
    expect(withoutManualCleaningSplitReason(marked)).toEqual(["preassigned_enable_wass"]);
  });
});

describe("splitCleaningTimeAcrossCollaborators", () => {
  it("divides the apartment total among the collaborators", () => {
    expect(splitCleaningTimeAcrossCollaborators(180, 1)).toBe(180);
    expect(splitCleaningTimeAcrossCollaborators(180, 2)).toBe(90);
    expect(splitCleaningTimeAcrossCollaborators(300, 2)).toBe(150);
    expect(splitCleaningTimeAcrossCollaborators(145, 2)).toBe(73);
    expect(splitCleaningTimeAcrossCollaborators(180, 0)).toBe(180);
  });
});

describe("applyWassCleaningTimeOverride", () => {
  it("treats the value as the apartment total and splits it per cleaner", () => {
    const task: any = { reasons: ["preassigned_enable_wass"] };
    applyWassCleaningTimeOverride(task, 300, 2);
    expect(task.base_cleaning_time).toBe(300);
    expect(task.cleaning_time).toBe(150);
    expect(task.duration).toBe("2.30");
    expect(task.reasons).toContain(WASS_CLEANING_TIME_MANUAL_REASON);
  });

  it("drops a manual split: editing the total re-splits evenly", () => {
    const task: any = { reasons: [WASS_CLEANING_SPLIT_MANUAL_REASON] };
    applyWassCleaningTimeOverride(task, 240, 2);
    expect(task.cleaning_time).toBe(120);
    expect(hasManualCleaningSplit(task)).toBe(false);
    expect(hasManualCleaningTime(task)).toBe(true);
  });

  it("keeps total and per-cleaner aligned without collaborators", () => {
    const task: any = {};
    applyWassCleaningTimeOverride(task, 90);
    expect(task.base_cleaning_time).toBe(90);
    expect(task.cleaning_time).toBe(90);
    expect(task.duration).toBe("1.30");
  });
});

describe("collect + restore manual cleaning time", () => {
  it("prefers the timeline base and restores it onto containers", () => {
    const overrides = collectManualCleaningTimeOverrides(
      {
        containers: {
          low_priority: {
            tasks: [
              {
                task_id: 10,
                cleaning_time: 40,
                reasons: [WASS_CLEANING_TIME_MANUAL_REASON],
              },
            ],
          },
        },
      },
      {
        cleaners_assignments: [
          {
            tasks: [
              {
                task_id: 10,
                cleaning_time: 90,
                base_cleaning_time: 180,
                collaborator_count: 2,
                reasons: [WASS_CLEANING_TIME_MANUAL_REASON],
              },
            ],
          },
        ],
      }
    );
    expect(overrides.get(10)?.baseCleaningTime).toBe(180);

    const containersData = {
      containers: {
        low_priority: {
          tasks: [{ task_id: 10, cleaning_time: 0, reasons: [] }],
        },
      },
    };
    expect(restoreManualCleaningTimeOverrides(containersData, overrides)).toBe(1);
    expect(containersData.containers.low_priority.tasks[0].cleaning_time).toBe(180);
    expect(containersData.containers.low_priority.tasks[0].duration).toBe("3.00");
    expect(containersData.containers.low_priority.tasks[0].reasons).toContain(
      WASS_CLEANING_TIME_MANUAL_REASON
    );
  });
});
