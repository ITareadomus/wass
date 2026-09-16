import { describe, expect, it } from "vitest";
import {
  formatClockFromMinutes,
  formatClockLabel,
  wrapHourOfDay,
} from "./clock-display";

describe("wrapHourOfDay", () => {
  it("keeps hours inside the 24h clock", () => {
    expect(wrapHourOfDay(10)).toBe(10);
    expect(wrapHourOfDay(0)).toBe(0);
    expect(wrapHourOfDay(23)).toBe(23);
  });

  it("wraps past midnight", () => {
    expect(wrapHourOfDay(24)).toBe(0);
    expect(wrapHourOfDay(25)).toBe(1);
    expect(wrapHourOfDay(26)).toBe(2);
  });
});

describe("formatClockFromMinutes", () => {
  it("formats ordinary daytime minutes", () => {
    expect(formatClockFromMinutes(10 * 60)).toBe("10:00");
    expect(formatClockFromMinutes(14 * 60 + 37)).toBe("14:37");
  });

  it("restarts hours after 24", () => {
    expect(formatClockFromMinutes(24 * 60)).toBe("00:00");
    expect(formatClockFromMinutes(25 * 60)).toBe("01:00");
    expect(formatClockFromMinutes(26 * 60)).toBe("02:00");
    expect(formatClockFromMinutes(26 * 60 + 15)).toBe("02:15");
  });
});

describe("formatClockLabel", () => {
  it("wraps stored clocks past 24", () => {
    expect(formatClockLabel("26:00")).toBe("02:00");
    expect(formatClockLabel("26:00:00")).toBe("02:00");
    expect(formatClockLabel("19:37")).toBe("19:37");
  });

  it("leaves non-clock text alone", () => {
    expect(formatClockLabel("non assegnato")).toBe("non assegnato");
    expect(formatClockLabel("")).toBe("");
  });
});
