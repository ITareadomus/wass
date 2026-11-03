import { describe, expect, it } from "vitest";
import { shiftedRouteStarts, taskBlockMinutes } from "./housekeeping-start-shift";

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
