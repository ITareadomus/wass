import { describe, expect, it } from "vitest";
import {
  buildLogisticsTaskKindPayload,
  buildManualLogisticsTaskKindPayload,
  isCleanerHasBag,
  logisticsTaskKindBadge,
  normalizeLogisticsTaskKind,
  requiresDriverBeforeCleaner,
  resolveAutoLogisticsTaskKind,
  resolveLogisticsTaskKind,
} from "./logistics-task-kind";

describe("normalizeLogisticsTaskKind", () => {
  it("maps legacy auto delivery to delivery/pick-up", () => {
    expect(normalizeLogisticsTaskKind("delivery")).toBe("delivery/pick-up");
    expect(normalizeLogisticsTaskKind("delivery/pick-up")).toBe("delivery/pick-up");
    expect(normalizeLogisticsTaskKind("pick-up")).toBe("pick-up");
  });

  it("keeps manual delivery distinct from D&P", () => {
    expect(normalizeLogisticsTaskKind("delivery", "manual")).toBe("delivery");
    expect(normalizeLogisticsTaskKind("delivery/pick-up", "manual")).toBe("delivery/pick-up");
  });
});

describe("resolveLogisticsTaskKind", () => {
  it("returns pick-up when cleaner has bag", () => {
    expect(
      resolveLogisticsTaskKind({
        cleanerId: 10,
        cleanerSequence: 1,
        premium: false,
        paxIn: 2,
      })
    ).toBe("pick-up");
  });

  it("returns delivery/pick-up for premium first task", () => {
    expect(
      resolveLogisticsTaskKind({
        cleanerId: 10,
        cleanerSequence: 1,
        premium: true,
        paxIn: 2,
      })
    ).toBe("delivery/pick-up");
  });

  it("returns delivery/pick-up for high pax on first task", () => {
    expect(
      resolveLogisticsTaskKind({
        cleanerId: 10,
        cleanerSequence: 1,
        premium: false,
        paxIn: 5,
      })
    ).toBe("delivery/pick-up");
  });

  it("returns delivery/pick-up for non-first cleaner task", () => {
    expect(
      resolveLogisticsTaskKind({
        cleanerId: 10,
        cleanerSequence: 2,
        premium: false,
        paxIn: 2,
      })
    ).toBe("delivery/pick-up");
  });

  it("returns null without cleaner context", () => {
    expect(
      resolveLogisticsTaskKind({
        cleanerId: null,
        cleanerSequence: null,
        premium: false,
        paxIn: 2,
      })
    ).toBeNull();
  });

  it("uses persisted auto logistics_task_kind", () => {
    expect(
      resolveLogisticsTaskKind({
        logisticsTaskKind: "delivery/pick-up",
        logisticsTaskKindSource: "auto",
      })
    ).toBe("delivery/pick-up");
  });

  it("normalizes legacy persisted delivery", () => {
    expect(
      resolveLogisticsTaskKind({
        logisticsTaskKind: "delivery",
        logisticsTaskKindSource: "auto",
      })
    ).toBe("delivery/pick-up");
  });

  it("returns manual delivery when explicitly set", () => {
    expect(
      resolveLogisticsTaskKind({
        logisticsTaskKind: "delivery",
        logisticsTaskKindSource: "manual",
      })
    ).toBe("delivery");
  });

  it("never auto-resolves delivery kind", () => {
    expect(
      resolveLogisticsTaskKind({
        cleanerId: 10,
        cleanerSequence: 1,
        premium: true,
        paxIn: 2,
      })
    ).toBe("delivery/pick-up");
  });
});

describe("buildLogisticsTaskKindPayload", () => {
  it("returns auto source when kind is resolved", () => {
    expect(
      buildLogisticsTaskKindPayload({
        cleanerId: 10,
        cleanerSequence: 1,
        premium: true,
        paxIn: 2,
      })
    ).toEqual({
      logistics_task_kind: "delivery/pick-up",
      logistics_task_kind_source: "auto",
    });
  });

  it("returns empty object when kind cannot be resolved", () => {
    expect(buildLogisticsTaskKindPayload({ cleanerId: null, cleanerSequence: null })).toEqual({});
  });
});

describe("buildManualLogisticsTaskKindPayload", () => {
  it("persists only kind and manual source", () => {
    expect(buildManualLogisticsTaskKindPayload("delivery")).toEqual({
      logistics_task_kind: "delivery",
      logistics_task_kind_source: "manual",
    });
    expect(buildManualLogisticsTaskKindPayload("pick-up")).toEqual({
      logistics_task_kind: "pick-up",
      logistics_task_kind_source: "manual",
    });
  });
});

describe("isCleanerHasBag", () => {
  it("matches the canonical pick-up auto rule", () => {
    expect(isCleanerHasBag({ cleanerSequence: 1, isPremium: false, paxIn: 2 })).toBe(true);
    expect(isCleanerHasBag({ cleanerSequence: 2, isPremium: false, paxIn: 2 })).toBe(false);
    expect(isCleanerHasBag({ cleanerSequence: 1, isPremium: true, paxIn: 2 })).toBe(false);
  });
});

describe("resolveAutoLogisticsTaskKind", () => {
  it("auto-resolves only pick-up, D&P, or null", () => {
    expect(
      resolveAutoLogisticsTaskKind({
        cleanerId: 10,
        cleanerSequence: 1,
        premium: false,
        paxIn: 2,
      })
    ).toBe("pick-up");
    expect(
      resolveAutoLogisticsTaskKind({
        cleanerId: 10,
        cleanerSequence: 1,
        premium: true,
        paxIn: 2,
      })
    ).toBe("delivery/pick-up");
    expect(resolveAutoLogisticsTaskKind({ cleanerId: null, cleanerSequence: null })).toBeNull();
  });
});

describe("requiresDriverBeforeCleaner", () => {
  it("requires cleaner-before-driver only for D&P", () => {
    expect(requiresDriverBeforeCleaner("delivery/pick-up")).toBe(true);
    expect(requiresDriverBeforeCleaner("pick-up")).toBe(false);
    expect(requiresDriverBeforeCleaner("delivery")).toBe(false);
    expect(requiresDriverBeforeCleaner(null)).toBe(false);
  });
});

describe("logisticsTaskKindBadge", () => {
  it("returns labels and color classes", () => {
    expect(logisticsTaskKindBadge("delivery/pick-up").text).toBe("D&P");
    expect(logisticsTaskKindBadge("delivery").text).toBe("DELIVERY");
    expect(logisticsTaskKindBadge("pick-up").text).toBe("PICK-UP");
    expect(logisticsTaskKindBadge("delivery/pick-up").className).toContain("purple");
    expect(logisticsTaskKindBadge("pick-up").className).toContain("sky");
  });
});
