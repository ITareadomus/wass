import { describe, expect, it } from "vitest";
import {
  getLogisticsTimelineViolationMessages,
  isBagRuleViolation,
  pickLogisticsViolationFields,
  resolveDriverBringsBagLatestStartMin,
  shouldBlinkLogisticsTimelineTask,
} from "./logistics-scheduling-constraints";

describe("resolveDriverBringsBagLatestStartMin", () => {
  it("uses 2/3 cleaning time tolerance when available", () => {
    expect(
      resolveDriverBringsBagLatestStartMin({
        cleanerTaskStartMin: 11 * 60 + 20,
        cleaningTimeMin: 60,
      })
    ).toBe(12 * 60);
  });
});

describe("isBagRuleViolation", () => {
  it("flags task 840 scenario: driver after HK start + tolerance", () => {
    expect(
      isBagRuleViolation({
        start_time: "13:02",
        logistics_task_kind: "delivery/pick-up",
        cleaner_sequence: 2,
        cleaner_id: 24,
        hk_start_time: "11:20",
        cleaning_time: 60,
        premium: false,
        pax_in: 2,
      })
    ).toBe(true);
  });

  it("does not flag pick-up tasks (cleaner already has bag)", () => {
    expect(
      isBagRuleViolation({
        start_time: "13:02",
        logistics_task_kind: "pick-up",
        cleaner_sequence: 1,
        cleaner_id: 24,
        hk_start_time: "11:20",
        cleaning_time: 60,
      })
    ).toBe(false);
  });

  it("does not flag when driver arrives within tolerance", () => {
    expect(
      isBagRuleViolation({
        start_time: "11:50",
        logistics_task_kind: "delivery/pick-up",
        cleaner_sequence: 2,
        cleaner_id: 24,
        hk_start_time: "11:20",
        cleaning_time: 60,
      })
    ).toBe(false);
  });
});

describe("pickLogisticsViolationFields", () => {
  it("maps raw timeline task fields for violation checks", () => {
    expect(
      pickLogisticsViolationFields({
        start_time: "13:02",
        end_time: "13:17",
        checkin_time: "14:00",
        checkin_date: "2026-06-18",
        logistics_task_kind: "delivery/pick-up",
        cleaner_sequence: 2,
        hk_start_time: "11:20",
        cleaning_time: 60,
        _checkin_violated: true,
      })
    ).toMatchObject({
      start_time: "13:02",
      hk_start_time: "11:20",
      cleaning_time: 60,
      cleaner_sequence: 2,
      _checkin_violated: true,
    });
  });
});

describe("getLogisticsTimelineViolationMessages", () => {
  it("describes bag rule violation for task 840 scenario", () => {
    const messages = getLogisticsTimelineViolationMessages(
      {
        start_time: "13:02",
        end_time: "13:17",
        logistics_task_kind: "delivery/pick-up",
        cleaner_sequence: 2,
        hk_start_time: "11:20",
        cleaning_time: 60,
      },
      "2026-06-18"
    );
    expect(messages.some((m) => m.includes("Regola borsone"))).toBe(true);
    expect(messages.some((m) => m.includes("12:00"))).toBe(true);
  });

  it("describes check-in violation", () => {
    const messages = getLogisticsTimelineViolationMessages(
      {
        start_time: "13:00",
        end_time: "14:30",
        checkin_time: "14:00",
        checkin_date: "2026-06-18",
      },
      "2026-06-18"
    );
    expect(messages.some((m) => m.includes("Check-in"))).toBe(true);
  });
});

describe("shouldBlinkLogisticsTimelineTask", () => {
  it("blinks for bag rule or check-in violations", () => {
    expect(
      shouldBlinkLogisticsTimelineTask(
        {
          start_time: "13:02",
          logistics_task_kind: "delivery/pick-up",
          cleaner_sequence: 2,
          hk_start_time: "11:20",
          cleaning_time: 60,
        },
        "2026-06-18"
      )
    ).toBe(true);
    expect(
      shouldBlinkLogisticsTimelineTask(
        {
          start_time: "13:00",
          end_time: "14:30",
          checkin_time: "14:00",
          checkin_date: "2026-06-18",
        },
        "2026-06-18"
      )
    ).toBe(true);
  });
});
