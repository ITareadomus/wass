import { describe, expect, it } from "vitest";
import { layoutHousekeepingTimelineTask } from "./housekeeping-timeline-layout";

describe("layoutHousekeepingTimelineTask", () => {
  it("tiene la task successiva sullo start time anche se la card precedente supera il suo end time", () => {
    const gridStart = 8 * 60;
    const first = layoutHousekeepingTimelineTask({
      isFirst: true,
      gridStartMinutes: gridStart,
      cursorMinutes: gridStart,
      startMinutes: 8 * 60 + 30,
      fallbackStartMinutes: null,
      travelMinutes: 0,
      cardMinutes: 120,
    });

    expect(first.initialOffsetMinutes).toBe(30);
    expect(first.nextCursorMinutes).toBe(10 * 60 + 30);

    const second = layoutHousekeepingTimelineTask({
      isFirst: false,
      gridStartMinutes: gridStart,
      cursorMinutes: first.nextCursorMinutes,
      startMinutes: 11 * 60,
      fallbackStartMinutes: null,
      travelMinutes: 0,
      cardMinutes: 180,
    });

    expect(second.alignGapMinutes).toBe(30);
    expect(first.nextCursorMinutes + second.alignGapMinutes).toBe(11 * 60);
  });

  it("riporta la task sullo start time se la barra precedente lo supera", () => {
    const slot = layoutHousekeepingTimelineTask({
      isFirst: false,
      gridStartMinutes: 8 * 60,
      cursorMinutes: 12 * 60,
      startMinutes: 11 * 60,
      fallbackStartMinutes: null,
      travelMinutes: 0,
      cardMinutes: 60,
    });

    expect(slot.alignGapMinutes).toBe(-60);
    expect(12 * 60 + slot.alignGapMinutes).toBe(11 * 60);
  });
});
