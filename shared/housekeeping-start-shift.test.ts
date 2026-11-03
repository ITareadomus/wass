import { describe, expect, it } from "vitest";
import {
  reflowStartsAfterManualMove,
  shiftedRouteStarts,
  taskBlockMinutes,
  taskScheduleFloor,
} from "./housekeeping-start-shift";

describe("shiftedRouteStarts", () => {
  it("slides the following tasks with the first apartment", () => {
    const starts = shiftedRouteStarts({
      startMinutes: [10 * 60, 12 * 60, 14 * 60],
      travelMinutes: [0, 20, 15],
      blockMinutes: [100, 100, 90],
      movedIndex: 0,
      movedStartMinutes: 11 * 60,
      cascade: true,
    });

    expect(starts).toEqual([11 * 60, 13 * 60, 15 * 60]);
  });

  it("does not let a later block move back into the previous task", () => {
    const starts = shiftedRouteStarts({
      startMinutes: [10 * 60, 12 * 60, 14 * 60],
      travelMinutes: [0, 10, 10],
      blockMinutes: [90, 60, 60],
      movedIndex: 1,
      movedStartMinutes: 10 * 60 + 30,
      cascade: false,
    });

    expect(starts[1]).toBe(11 * 60 + 40);
    expect(starts[2]).toBe(14 * 60);
  });

  it("pushes the next task when a block moves into it", () => {
    const starts = shiftedRouteStarts({
      startMinutes: [10 * 60, 12 * 60, 14 * 60],
      travelMinutes: [0, 10, 10],
      blockMinutes: [90, 90, 60],
      movedIndex: 1,
      movedStartMinutes: 13 * 60,
      cascade: false,
    });

    expect(starts[1]).toBe(13 * 60);
    expect(starts[2]).toBe(14 * 60 + 40);
  });

  it("keeps a zero-length task from inventing a duration", () => {
    expect(taskBlockMinutes(16 * 60 + 2, 16 * 60 + 2, 0)).toBe(0);
  });
});

describe("taskScheduleFloor", () => {
  it("uses checkout when it is later than the previous task", () => {
    const floor = taskScheduleFloor({
      checkoutMinutes: 12 * 60 + 12,
      previousEndMinutes: 11 * 60,
      travelMinutes: 20,
      durationMinutes: 120,
    });
    expect(floor.minStartMinutes).toBe(12 * 60 + 12);
    expect(floor.minEndMinutes).toBe(14 * 60 + 12);
  });

  it("uses arrival from the previous task when it is later than checkout", () => {
    const floor = taskScheduleFloor({
      checkoutMinutes: 11 * 60,
      previousEndMinutes: 12 * 60,
      travelMinutes: 12,
      durationMinutes: 60,
    });
    expect(floor.minStartMinutes).toBe(12 * 60 + 12);
    expect(floor.minEndMinutes).toBe(13 * 60 + 12);
  });

  it("leaves the floor open when nothing constrains the task", () => {
    expect(taskScheduleFloor({
      checkoutMinutes: null,
      previousEndMinutes: null,
      travelMinutes: 0,
      durationMinutes: 90,
    })).toEqual({ minStartMinutes: null, minEndMinutes: null });
  });
});

describe("reflowStartsAfterManualMove", () => {
  it("pulls the next task back to its checkout when the previous block moves earlier", () => {
    const starts = reflowStartsAfterManualMove({
      startMinutes: [11 * 60, 13 * 60 + 28],
      travelMinutes: [0, 28],
      blockMinutes: [120, 90],
      earliestMinutes: [11 * 60, 11 * 60],
      pinned: [true, false],
      movedIndex: 0,
      movedStartMinutes: 8 * 60,
    });

    expect(starts[0]).toBe(8 * 60);
    expect(starts[1]).toBe(11 * 60);
  });

  it("starts the next task at arrival when that is later than checkout", () => {
    const starts = reflowStartsAfterManualMove({
      startMinutes: [11 * 60, 13 * 60 + 28],
      travelMinutes: [0, 90],
      blockMinutes: [120, 90],
      earliestMinutes: [null, 11 * 60],
      pinned: [true, false],
      movedIndex: 0,
      movedStartMinutes: 8 * 60,
    });

    expect(starts[1]).toBe(11 * 60 + 30);
  });

  it("does not pull a later manual schedule earlier", () => {
    const starts = reflowStartsAfterManualMove({
      startMinutes: [11 * 60, 15 * 60],
      travelMinutes: [0, 20],
      blockMinutes: [120, 60],
      earliestMinutes: [null, 11 * 60],
      pinned: [true, true],
      movedIndex: 0,
      movedStartMinutes: 8 * 60,
    });

    expect(starts[1]).toBe(15 * 60);
  });
});
