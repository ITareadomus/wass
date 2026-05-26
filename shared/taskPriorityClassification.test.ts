import { describe, expect, it } from "vitest";
import {
  classifyTaskPriority,
  parsePrioritySettings,
  PriorityClassificationSettings,
} from "./taskPriorityClassification";

const rawSettings = {
  "early-out": {
    eo_clients: [101],
  },
  "high-priority": {
    global_start_time: "11:00",
    hp_start_time: "11:00",
    hp_end_time: "15:30",
    hp_clients: [202],
  },
  dedupe_strategy: "eo_wins",
};

const settings = parsePrioritySettings(rawSettings);

function withDedupe(dedupeStrategy: "eo_wins" | "hp_wins"): PriorityClassificationSettings {
  return parsePrioritySettings({ ...rawSettings, dedupe_strategy: dedupeStrategy });
}

describe("classifyTaskPriority", () => {
  it("classifies a non-premium task with checkout before hpStart as EO", () => {
    expect(classifyTaskPriority({ checkout_time: "10:30" }, settings)).toBe("EO");
  });

  it("classifies a non-premium EO client as EO", () => {
    expect(classifyTaskPriority({ client_id: 101, checkout_time: "12:00" }, settings)).toBe("EO");
  });

  it("classifies a non-premium HP client as HP", () => {
    expect(classifyTaskPriority({ client_id: 202, checkout_time: "12:00" }, settings)).toBe("HP");
  });

  it("classifies a premium task without check-in as HP", () => {
    expect(classifyTaskPriority({ premium: true, checkout_time: "12:00" }, settings)).toBe("HP");
  });

  it("classifies a premium task with check-in after hpEnd as HP", () => {
    expect(
      classifyTaskPriority(
        {
          premium: true,
          checkout_time: "12:00",
          checkout_date: "2026-05-25",
          checkin_date: "2026-05-25",
          checkin_time: "16:00",
        },
        settings
      )
    ).toBe("HP");
  });

  it("uses dedupeStrategy when premium also matches EO by checkout time", () => {
    const task = { premium: true, checkout_time: "10:30" };

    expect(classifyTaskPriority(task, withDedupe("eo_wins"))).toBe("EO");
    expect(classifyTaskPriority(task, withDedupe("hp_wins"))).toBe("HP");
  });

  it("uses dedupeStrategy when a client is in both EO and HP lists", () => {
    const bothListsSettings = parsePrioritySettings({
      "early-out": { eo_clients: [303] },
      "high-priority": {
        global_start_time: "11:00",
        hp_start_time: "11:00",
        hp_end_time: "15:30",
        hp_clients: [303],
      },
      dedupe_strategy: "eo_wins",
    });

    expect(classifyTaskPriority({ client_id: 303, checkout_time: "12:00" }, bothListsSettings)).toBe("EO");
    expect(
      classifyTaskPriority(
        { client_id: 303, checkout_time: "12:00" },
        { ...bothListsSettings, dedupeStrategy: "hp_wins" }
      )
    ).toBe("HP");
  });

  it("classifies a same-day non-premium task with check-in inside the HP window as HP", () => {
    expect(
      classifyTaskPriority(
        {
          checkout_time: "12:00",
          checkout_date: "2026-05-25",
          checkin_date: "2026-05-25",
          checkin_time: "13:00",
        },
        settings
      )
    ).toBe("HP");
  });

  it("classifies a same-day non-premium task with check-in after hpEnd as LP", () => {
    expect(
      classifyTaskPriority(
        {
          checkout_time: "12:00",
          checkout_date: "2026-05-25",
          checkin_date: "2026-05-25",
          checkin_time: "16:00",
        },
        settings
      )
    ).toBe("LP");
  });

  it("does not classify tomorrow check-in before hpStart as HP by time", () => {
    expect(
      classifyTaskPriority(
        {
          checkout_time: "12:00",
          checkout_date: "2026-05-25",
          checkin_date: "2026-05-26",
          checkin_time: "10:30",
        },
        settings
      )
    ).toBe("LP");
  });

  it("classifies non-premium missing check-in with no EO/HP override as LP", () => {
    expect(classifyTaskPriority({ checkout_time: "12:00" }, settings)).toBe("LP");
  });

  it("throws an explicit error when globalStart/hpStart fallback or hpEnd is missing", () => {
    expect(() =>
      parsePrioritySettings({
        "early-out": { eo_clients: [] },
        "high-priority": { hp_end_time: "15:30", hp_clients: [] },
        dedupe_strategy: "eo_wins",
      })
    ).toThrow("high-priority.global_start_time");

    expect(() =>
      parsePrioritySettings({
        "early-out": { eo_clients: [] },
        "high-priority": { global_start_time: "11:00", hp_clients: [] },
        dedupe_strategy: "eo_wins",
      })
    ).toThrow("high-priority.hp_end_time is required");
  });
});
