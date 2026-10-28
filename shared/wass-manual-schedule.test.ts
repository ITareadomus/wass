import { describe, expect, it } from "vitest";
import {
  WASS_MANUAL_SCHEDULE_REASON,
  formatScheduleDurationLabel,
  hasManualSchedule,
  manualScheduleSpanMinutes,
  normalizeScheduleClock,
  withManualScheduleReason,
  withoutManualScheduleReason,
} from "./wass-manual-schedule";

describe("manual schedule", () => {
  it("normalizes clocks and rejects invalid ones", () => {
    expect(normalizeScheduleClock("9:05")).toBe("09:05");
    expect(normalizeScheduleClock("09:05:00")).toBe("09:05");
    expect(normalizeScheduleClock("24:00")).toBeNull();
    expect(normalizeScheduleClock("")).toBeNull();
  });

  it("keeps the marker once", () => {
    expect(withManualScheduleReason(["preassigned_enable_wass_readonly"])).toEqual([
      "preassigned_enable_wass_readonly",
      WASS_MANUAL_SCHEDULE_REASON,
    ]);
    expect(
      withManualScheduleReason([WASS_MANUAL_SCHEDULE_REASON, WASS_MANUAL_SCHEDULE_REASON])
    ).toEqual([WASS_MANUAL_SCHEDULE_REASON]);
    expect(withoutManualScheduleReason(withManualScheduleReason(["keep"]))).toEqual(["keep"]);
  });

  it("measures only a valid manual window", () => {
    expect(hasManualSchedule({ reasons: [WASS_MANUAL_SCHEDULE_REASON] })).toBe(true);
    expect(
      manualScheduleSpanMinutes({
        reasons: [WASS_MANUAL_SCHEDULE_REASON],
        start_time: "10:00",
        end_time: "11:30",
      })
    ).toBe(90);
    expect(formatScheduleDurationLabel(90)).toBe("1.30");
    expect(
      manualScheduleSpanMinutes({
        reasons: [WASS_MANUAL_SCHEDULE_REASON],
        start_time: "12:00",
        end_time: "11:00",
      })
    ).toBeNull();
    expect(
      manualScheduleSpanMinutes({ start_time: "10:00", end_time: "11:00" })
    ).toBeNull();
  });
});
