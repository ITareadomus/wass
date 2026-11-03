import { describe, expect, it } from "vitest";
import {
  attachScheduleBlockMinutes,
  fictionalScheduleMinutes,
  parseOperationBaseMinutes,
  usesFictionalOperationDuration,
} from "./operation-base-duration";

describe("operation base duration", () => {
  const bases = parseOperationBaseMinutes({
    operation_base_minutes: { "12": 90, "4": 0, "bad": 30 },
  });

  it("keeps an ADAM duration", () => {
    expect(fictionalScheduleMinutes({ operation_id: 12, cleaning_time: 60 }, bases)).toBeNull();
    expect(usesFictionalOperationDuration({ operation_id: 12, cleaning_time: 60 }, bases)).toBe(false);
  });

  it("uses the base only when ADAM sent 0 hours", () => {
    expect(fictionalScheduleMinutes({ operation_id: 12, cleaning_time: 0 }, bases)).toBe(90);
  });

  it("does not replace a duration set by hand in WASS", () => {
    expect(
      fictionalScheduleMinutes(
        { operation_id: 12, cleaning_time: 0, reasons: ["wass_cleaning_time_manual"] },
        bases,
      ),
    ).toBeNull();
  });

  it("attaches the block without changing cleaning_time", () => {
    const cleaner = attachScheduleBlockMinutes(
      { tasks: [{ operation_id: 12, cleaning_time: 0 }, { operation_id: 12, cleaning_time: 45 }] },
      { operation_base_minutes: { "12": 90 } },
    );
    expect(cleaner.tasks[0].schedule_block_minutes).toBe(90);
    expect(cleaner.tasks[0].cleaning_time).toBe(0);
    expect(cleaner.tasks[1].schedule_block_minutes).toBeUndefined();
  });
});
