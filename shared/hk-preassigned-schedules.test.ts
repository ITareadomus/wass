import { describe, expect, it } from "vitest";
import {
  applyHkPreassignedSchedule,
  durationLabelFromWindow,
  parseHkPreassignedSchedules,
} from "./hk-preassigned-schedules";

describe("hk preassigned schedules", () => {
  it("keeps a valid code window and drops a bad one", () => {
    const rows = parseHkPreassignedSchedules({
      entries: [
        { logisticCode: "1741", startTime: "08:00", endTime: "10:00" },
        { logisticCode: "12a", startTime: "08:00", endTime: "09:00" },
        { logisticCode: "1621", startTime: "10:00", endTime: "09:00" },
      ],
    });
    expect(rows).toEqual([{ logisticCode: "1741", startTime: "08:00", endTime: "10:00" }]);
    expect(durationLabelFromWindow("08:00", "10:00")).toBe("2.00");
  });

  it("replaces start, end and duration on the matching task", () => {
    const task = applyHkPreassignedSchedule(
      { name: "1741", logistic_code: "1741", start_time: "08:00", end_time: "08:00", duration: "0.00" },
      [{ logisticCode: "1741", startTime: "08:00", endTime: "10:00" }],
    );
    expect(task.start_time).toBe("08:00");
    expect(task.end_time).toBe("10:00");
    expect(task.duration).toBe("2.00");
    expect(task.cleaning_time).toBe(120);
  });
});
