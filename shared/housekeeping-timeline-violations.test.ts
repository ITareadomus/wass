import { describe, expect, it } from "vitest";
import {
  getHousekeepingTimelineViolationMessages,
  getHousekeepingTimelineViolationShortLabels,
} from "./housekeeping-timeline-violations";

describe("getHousekeepingTimelineViolationMessages", () => {
  it("segnala inizio prima del check-out", () => {
    const messages = getHousekeepingTimelineViolationMessages({
      startTime: "09:00",
      checkoutTime: "10:00",
      checkoutDate: "2026-08-31",
    });
    expect(messages.some((m) => m.includes("prima del check-out"))).toBe(true);
  });

  it("segnala fine dopo il check-in", () => {
    const messages = getHousekeepingTimelineViolationMessages({
      startTime: "11:00",
      endTime: "16:00",
      checkoutTime: "10:00",
      checkinTime: "15:00",
      checkoutDate: "2026-08-31",
      checkinDate: "2026-08-31",
    });
    expect(messages.some((m) => m.includes("supera l'orario di check-in"))).toBe(true);
  });

  it("non segnala nulla se gli orari rispettano checkout e check-in", () => {
    const messages = getHousekeepingTimelineViolationMessages({
      startTime: "11:00",
      endTime: "14:00",
      checkoutTime: "10:00",
      checkinTime: "16:00",
      checkoutDate: "2026-08-31",
      checkinDate: "2026-08-31",
    });
    expect(messages).toEqual([]);
  });
});

describe("getHousekeepingTimelineViolationShortLabels", () => {
  it("usa etichette brevi per il tooltip", () => {
    expect(
      getHousekeepingTimelineViolationShortLabels({
        startTime: "09:00",
        checkoutTime: "10:00",
        checkoutDate: "2026-08-31",
      })
    ).toEqual(["checkout violato"]);
  });
});
