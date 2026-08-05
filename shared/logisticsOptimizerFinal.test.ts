import { describe, expect, it } from "vitest";
import {
  computeLogisticsTaskKind,
  resolveLogisticsTaskKindModeWithTrace,
} from "../server/services/logistics-optimizer-final/bag-handling";
import {
  resolveDriverBringsBagLatestStartMin,
  resolveEarliestServiceStartMin,
} from "../server/services/logistics-optimizer-final/business-rules";
import { buildRoutingProblemInputFromSource } from "../server/services/logistics-optimizer-final/build-routing-input";
import {
  DRIVER_BRINGS_BAG_TOLERANCE_REASON,
  buildTaskWindow,
} from "../server/services/logistics-optimizer-final/windows";
import type { LogisticsRoutingSourceData } from "../server/services/logistics-optimizer-final/loaders";
import type { PriorityWindows } from "../server/services/optimizer/priorityWindows";
import { buildSchedulingWindows, parsePrioritySettings } from "./taskPriorityClassification";

const priorityWindows: PriorityWindows = {
  EO: { startMin: 0, endMin: 659, graceMin: 0 },
  HP: { startMin: 660, endMin: 930, graceMin: 0 },
  LP: { startMin: 660, endMin: null, graceMin: 0 },
};

describe("priority scheduling windows", () => {
  it("builds EO HP LP scheduling windows from high-priority settings", () => {
    const settings = parsePrioritySettings({
      "high-priority": {
        hp_start_time: "10:30",
        hp_end_time: "14:00",
        hp_clients: [],
      },
      "early-out": {
        eo_clients: [],
      },
      dedupe_strategy: "eo_wins",
    });

    const windows = buildSchedulingWindows(settings);

    expect(windows.EO.startMin).toBe(0);
    expect(windows.EO.endMin).toBe(629);
    expect(windows.HP.startMin).toBe(630);
    expect(windows.HP.endMin).toBe(840);
    expect(windows.LP.startMin).toBe(630);
    expect(windows.LP.endMin).toBe(null);
  });

  it("moves HP LP lower bound and EO upper bound when hp_start_time changes", () => {
    const settingsA = parsePrioritySettings({
      "high-priority": {
        hp_start_time: "10:00",
        hp_end_time: "14:00",
        hp_clients: [],
      },
      "early-out": {
        eo_clients: [],
      },
      dedupe_strategy: "eo_wins",
    });
    const settingsB = parsePrioritySettings({
      "high-priority": {
        hp_start_time: "11:00",
        hp_end_time: "14:00",
        hp_clients: [],
      },
      "early-out": {
        eo_clients: [],
      },
      dedupe_strategy: "eo_wins",
    });

    const windowsA = buildSchedulingWindows(settingsA);
    const windowsB = buildSchedulingWindows(settingsB);

    expect(windowsA.HP.startMin).toBe(600);
    expect(windowsA.LP.startMin).toBe(600);
    expect(windowsA.EO.endMin).toBe(599);
    expect(windowsB.HP.startMin).toBe(660);
    expect(windowsB.LP.startMin).toBe(660);
    expect(windowsB.EO.endMin).toBe(659);
  });
});

describe("computeLogisticsTaskKind", () => {
  it("separates no-cleaner tasks from D&P and pick-up", () => {
    expect(computeLogisticsTaskKind({ cleanerId: null, sequence: null, premium: false, paxIn: 2 })).toBeNull();
    expect(computeLogisticsTaskKind({ cleanerId: 10, sequence: 1, premium: false, paxIn: 2 })).toBe(
      "pick-up"
    );
    expect(computeLogisticsTaskKind({ cleanerId: 10, sequence: 1, premium: false, paxIn: 5 })).toBe(
      "delivery/pick-up"
    );
    expect(computeLogisticsTaskKind({ cleanerId: 10, sequence: 1, premium: true, paxIn: 2 })).toBe(
      "delivery/pick-up"
    );
    expect(computeLogisticsTaskKind({ cleanerId: 10, sequence: 2, premium: false, paxIn: 2 })).toBe(
      "delivery/pick-up"
    );
  });
});

describe("business rules", () => {
  it("resolves earliest service start with trace", () => {
    expect(
      resolveEarliestServiceStartMin({
        customerCheckoutMin: null,
        priority: "EO",
        priorityWindows,
      })
    ).toMatchObject({
      value: 0,
      trace: [{ code: "EO_NO_HARD_LOWER_BOUND" }],
    });

    expect(
      resolveEarliestServiceStartMin({
        customerCheckoutMin: null,
        priority: "HP",
        priorityWindows,
      })
    ).toMatchObject({
      value: priorityWindows.HP.startMin,
      trace: [{ code: "HP_CONFIGURED_START" }],
    });

    expect(
      resolveEarliestServiceStartMin({
        customerCheckoutMin: 720,
        priority: "EO",
        priorityWindows,
      })
    ).toMatchObject({
      value: 720,
      trace: [{ code: "CUSTOMER_CHECKOUT_MIGRATED" }],
    });
  });

  it("traces unavailable priority windows instead of silently falling back for HP and LP", () => {
    expect(
      resolveEarliestServiceStartMin({
        customerCheckoutMin: null,
        priority: "HP",
        priorityWindows: null,
      })
    ).toMatchObject({
      value: 0,
      trace: [{ code: "PRIORITY_WINDOWS_UNAVAILABLE" }],
    });

    expect(
      resolveEarliestServiceStartMin({
        customerCheckoutMin: 720,
        priority: "HP",
        priorityWindows: null,
      })
    ).toMatchObject({
      value: 720,
      trace: [{ code: "CUSTOMER_CHECKOUT_MIGRATED" }],
    });
  });

  it("resolves driver bag latest start with tolerance trace and fallback trace", () => {
    expect(
      resolveDriverBringsBagLatestStartMin({
        cleanerTaskStartMin: 840,
        cleaningTimeMin: 60,
      })
    ).toMatchObject({
      value: 880,
      trace: [{ code: DRIVER_BRINGS_BAG_TOLERANCE_REASON }],
    });

    expect(
      resolveDriverBringsBagLatestStartMin({
        cleanerTaskStartMin: 840,
        cleaningTimeMin: null,
      })
    ).toMatchObject({
      value: 870,
      trace: [{ code: "DRIVER_BRINGS_BAG_DEFAULT_TOLERANCE" }],
    });
  });

  it("resolves logistics task kind with trace", () => {
    expect(
      resolveLogisticsTaskKindModeWithTrace({
        cleanerId: null,
        cleanerSequence: null,
        isPremium: false,
        paxIn: 2,
      })
    ).toMatchObject({
      value: null,
      trace: [{ code: "NO_CLEANER_CONTEXT" }],
    });

    expect(
      resolveLogisticsTaskKindModeWithTrace({
        cleanerId: 10,
        cleanerSequence: 1,
        isPremium: true,
        paxIn: 2,
      })
    ).toMatchObject({
      value: "delivery/pick-up",
      trace: [{ code: "DRIVER_BRINGS_BAG_REQUIRED" }],
    });

    expect(
      resolveLogisticsTaskKindModeWithTrace({
        cleanerId: 10,
        cleanerSequence: 1,
        isPremium: false,
        paxIn: 2,
      })
    ).toMatchObject({
      value: "pick-up",
      trace: [{ code: "CLEANER_HAS_BAG_FLEXIBLE_PICKUP" }],
    });
  });
});

describe("buildTaskWindow", () => {
  it("allows DRIVER_BRINGS_BAG until cleaner start + 2/3 cleaning time", () => {
    expect(
      resolveDriverBringsBagLatestStartMin({
        cleanerTaskStartMin: 840,
        cleaningTimeMin: 60,
      }).value
    ).toBe(880);
  });

  it("keeps route-compatible EO early soft and HP/LP lower bounds hard", () => {
    const eo = buildTaskWindow({
      taskId: 1,
      priority: "EO",
      logisticsTaskKind: null,
      workDate: "2026-06-04",
      cleaningTime: null,
      checkoutDate: null,
      checkoutTime: null,
      checkinDate: null,
      checkinTime: null,
      cleanerStartTime: null,
      cleanerTaskStartTime: null,
      priorityWindows,
      dayEndMin: 1200,
    });
    const hp = buildTaskWindow({
      taskId: 2,
      priority: "HP",
      logisticsTaskKind: null,
      workDate: "2026-06-04",
      cleaningTime: null,
      checkoutDate: null,
      checkoutTime: null,
      checkinDate: null,
      checkinTime: null,
      cleanerStartTime: null,
      cleanerTaskStartTime: null,
      priorityWindows,
      dayEndMin: 1200,
    });

    expect(eo.hardWindow.earliestStartMin).toBe(0);
    expect(eo.softWindows[0]?.reason).toBe("EO_EARLY_IF_ROUTE_COMPATIBLE_SOFT_PREFERENCE");
    expect(eo.ruleTrace.some((trace) => trace.code === "EO_EARLY_ROUTE_COMPATIBLE")).toBe(true);
    expect(hp.hardWindow.earliestStartMin).toBe(660);
  });

  it("does not push flexible EO pick-ups early", () => {
    const result = buildTaskWindow({
      taskId: 3,
      priority: "EO",
      logisticsTaskKind: "pick-up",
      workDate: "2026-06-04",
      cleaningTime: null,
      checkoutDate: null,
      checkoutTime: null,
      checkinDate: null,
      checkinTime: null,
      cleanerStartTime: null,
      cleanerTaskStartTime: null,
      priorityWindows,
      dayEndMin: 1200,
    });

    expect(result.hardWindow.earliestStartMin).toBe(0);
    expect(result.softWindows).toEqual([]);
    expect(result.ruleTrace.some((trace) => trace.code === "EO_EARLY_FLEXIBLE_SUPPRESSED")).toBe(true);
  });

  it("keeps early pressure for urgent EO delivery/pick-up tasks", () => {
    const result = buildTaskWindow({
      taskId: 4,
      priority: "EO",
      logisticsTaskKind: "delivery/pick-up",
      workDate: "2026-06-04",
      cleaningTime: 60,
      checkoutDate: null,
      checkoutTime: null,
      checkinDate: null,
      checkinTime: null,
      cleanerStartTime: "12:00",
      cleanerTaskStartTime: "12:00",
      priorityWindows,
      dayEndMin: 1200,
    });

    expect(result.softWindows[0]?.reason).toBe("EO_EARLY_URGENT_SOFT_PREFERENCE");
    expect(result.softWindows[0]?.penaltyPerMin).toBe(1);
    expect(result.ruleTrace.some((trace) => trace.code === "EO_EARLY_URGENT")).toBe(true);
  });

  it("does not treat a late-evening check-in EO as urgent", () => {
    const result = buildTaskWindow({
      taskId: 5,
      priority: "EO",
      logisticsTaskKind: "pick-up",
      workDate: "2026-06-04",
      cleaningTime: null,
      checkoutDate: null,
      checkoutTime: null,
      checkinDate: "2026-06-04",
      checkinTime: "22:45",
      cleanerStartTime: null,
      cleanerTaskStartTime: null,
      priorityWindows,
      dayEndMin: 1200,
    });

    expect(result.softWindows).toEqual([]);
    expect(result.ruleTrace.some((trace) => trace.code === "EO_EARLY_FLEXIBLE_SUPPRESSED")).toBe(true);
    expect(result.ruleTrace.some((trace) => trace.code === "EO_EARLY_URGENT")).toBe(false);
  });

  it("treats a midday check-in EO as urgent", () => {
    const result = buildTaskWindow({
      taskId: 6,
      priority: "EO",
      logisticsTaskKind: "pick-up",
      workDate: "2026-06-04",
      cleaningTime: null,
      checkoutDate: null,
      checkoutTime: null,
      checkinDate: "2026-06-04",
      checkinTime: "13:00",
      cleanerStartTime: null,
      cleanerTaskStartTime: null,
      priorityWindows,
      dayEndMin: 1200,
    });

    expect(result.softWindows[0]?.reason).toBe("EO_EARLY_URGENT_SOFT_PREFERENCE");
    expect(result.ruleTrace.some((trace) => trace.code === "EO_EARLY_URGENT")).toBe(true);
  });

  it("does not use EO priority window as a hard lower bound", () => {
    const result = buildTaskWindow({
      taskId: 20,
      priority: "EO",
      logisticsTaskKind: null,
      workDate: "2026-06-04",
      cleaningTime: null,
      checkoutDate: null,
      checkoutTime: null,
      checkinDate: null,
      checkinTime: null,
      cleanerStartTime: null,
      cleanerTaskStartTime: null,
      priorityWindows: {
        EO: { startMin: 0, endMin: 629, graceMin: 0 },
        HP: { startMin: 630, endMin: 840, graceMin: 0 },
        LP: { startMin: 630, endMin: null, graceMin: 0 },
      },
      dayEndMin: 1200,
    });

    expect(result.hardWindow.earliestStartMin).toBe(0);
    expect(result.ruleTrace).toContainEqual({ code: "EO_NO_HARD_LOWER_BOUND", value: 0 });
  });

  it("uses configured HP and LP starts as hard lower bounds when checkout is not migrated", () => {
    const customWindows: PriorityWindows = {
      EO: { startMin: 0, endMin: 629, graceMin: 0 },
      HP: { startMin: 630, endMin: 840, graceMin: 0 },
      LP: { startMin: 630, endMin: null, graceMin: 0 },
    };
    const base = {
      logisticsTaskKind: null,
      workDate: "2026-06-04",
      cleaningTime: null,
      checkoutDate: null,
      checkoutTime: null,
      checkinDate: null,
      checkinTime: null,
      cleanerStartTime: null,
      cleanerTaskStartTime: null,
      priorityWindows: customWindows,
      dayEndMin: 1200,
    };

    const hp = buildTaskWindow({ ...base, taskId: 21, priority: "HP" });
    const lp = buildTaskWindow({ ...base, taskId: 22, priority: "LP" });

    expect(hp.hardWindow.earliestStartMin).toBe(630);
    expect(hp.ruleTrace).toContainEqual({ code: "HP_CONFIGURED_START", value: 630 });
    expect(lp.hardWindow.earliestStartMin).toBe(630);
    expect(lp.ruleTrace).toContainEqual({ code: "LP_CONFIGURED_START", value: 630 });
  });

  it("uses migrated customer checkout as hard lower bound even for EO", () => {
    const result = buildTaskWindow({
      taskId: 23,
      priority: "EO",
      logisticsTaskKind: null,
      workDate: "2026-06-04",
      cleaningTime: null,
      checkoutDate: "2026-06-04",
      checkoutTime: "12:00",
      checkinDate: null,
      checkinTime: null,
      cleanerStartTime: null,
      cleanerTaskStartTime: null,
      priorityWindows: {
        EO: { startMin: 0, endMin: 629, graceMin: 0 },
        HP: { startMin: 630, endMin: 840, graceMin: 0 },
        LP: { startMin: 630, endMin: null, graceMin: 0 },
      },
      dayEndMin: 1200,
    });

    expect(result.hardWindow.earliestStartMin).toBe(720);
    expect(result.ruleTrace).toContainEqual({ code: "CUSTOMER_CHECKOUT_MIGRATED", value: 720 });
  });

  it("uses migrated customer checkout as hard lower bound even for HP and LP", () => {
    const customWindows: PriorityWindows = {
      EO: { startMin: 0, endMin: 629, graceMin: 0 },
      HP: { startMin: 630, endMin: 840, graceMin: 0 },
      LP: { startMin: 630, endMin: null, graceMin: 0 },
    };
    const base = {
      logisticsTaskKind: null,
      workDate: "2026-06-04",
      cleaningTime: null,
      checkoutDate: "2026-06-04",
      checkoutTime: "12:00",
      checkinDate: null,
      checkinTime: null,
      cleanerStartTime: null,
      cleanerTaskStartTime: null,
      priorityWindows: customWindows,
      dayEndMin: 1200,
    };

    const hp = buildTaskWindow({ ...base, taskId: 24, priority: "HP" });
    const lp = buildTaskWindow({ ...base, taskId: 25, priority: "LP" });

    expect(hp.hardWindow.earliestStartMin).toBe(720);
    expect(hp.hardWindow.earliestStartMin).not.toBeLessThan(720);
    expect(hp.ruleTrace.map((trace) => trace.code)).toContain("CUSTOMER_CHECKOUT_MIGRATED");
    expect(lp.hardWindow.earliestStartMin).toBe(720);
    expect(lp.hardWindow.earliestStartMin).not.toBeLessThan(720);
    expect(lp.ruleTrace.map((trace) => trace.code)).toContain("CUSTOMER_CHECKOUT_MIGRATED");
  });

  it("uses checkout as the hard lower bound without exposing max wait, plus check-in and cleaner tolerance", () => {
    const checkout = buildTaskWindow({
      taskId: 3,
      priority: null,
      logisticsTaskKind: null,
      workDate: "2026-06-04",
      cleaningTime: null,
      checkoutDate: "2026-06-04",
      checkoutTime: "12:00",
      checkinDate: "2026-06-04",
      checkinTime: "13:00",
      cleanerStartTime: null,
      cleanerTaskStartTime: null,
      priorityWindows,
      dayEndMin: 1200,
    });
    const cleaner = buildTaskWindow({
      taskId: 4,
      priority: null,
      logisticsTaskKind: "delivery/pick-up" as const,
      workDate: "2026-06-04",
      cleaningTime: 60,
      checkoutDate: null,
      checkoutTime: null,
      checkinDate: null,
      checkinTime: null,
      cleanerStartTime: "10:00",
      cleanerTaskStartTime: null,
      priorityWindows,
      dayEndMin: 1200,
    });

    expect(checkout.hardWindow.earliestStartMin).toBe(720);
    expect(checkout.hardWindow.earliestStartMin).not.toBeLessThan(720);
    expect(checkout.hardWindow.latestEndMin).toBe(780);
    expect(checkout.hardConstraints.map((constraint) => constraint.type)).not.toContain("CHECKOUT_MAX_WAIT");
    expect(cleaner.hardWindow.latestStartMin).toBe(640);
    expect(cleaner.hardWindow.reasons).toContain(DRIVER_BRINGS_BAG_TOLERANCE_REASON);
    expect(cleaner.ruleTrace.map((trace) => trace.code)).toContain(DRIVER_BRINGS_BAG_TOLERANCE_REASON);
  });
});

describe("buildRoutingProblemInputFromSource", () => {
  it("builds input tasks from pure schedulable tasks and tracks exclusions", () => {
    const sourceData: LogisticsRoutingSourceData = {
      workDate: "2026-06-04",
      allTaskData: [
        {
          taskId: 101,
          logisticCode: 5001,
          priority: "early_out",
          cleaningTime: 60,
          lat: 45.45,
          lng: 9.18,
          checkinDate: null,
          checkoutDate: null,
          checkinTime: null,
          checkoutTime: null,
          cleanerId: 10,
          cleanerStartTime: "10:00",
          cleanerTaskStartTime: "10:00",
          cleanerSequence: 1,
          premium: false,
          paxIn: 2,
          locked: false,
          lockedReason: null,
        },
        {
          taskId: 102,
          logisticCode: 5002,
          priority: "low_priority",
          cleaningTime: 30,
          lat: null,
          lng: null,
          checkinDate: null,
          checkoutDate: null,
          checkinTime: null,
          checkoutTime: null,
          cleanerId: 10,
          cleanerStartTime: "10:00",
          cleanerTaskStartTime: "10:00",
          cleanerSequence: 1,
          premium: false,
          paxIn: 1,
          locked: false,
          lockedReason: null,
        },
        {
          taskId: 103,
          logisticCode: 5003,
          priority: "high_priority",
          cleaningTime: 45,
          lat: 45.46,
          lng: 9.19,
          checkinDate: null,
          checkoutDate: null,
          checkinTime: null,
          checkoutTime: null,
          cleanerId: 10,
          cleanerStartTime: "10:00",
          cleanerTaskStartTime: "10:00",
          cleanerSequence: 1,
          premium: true,
          paxIn: 5,
          locked: true,
          lockedReason: "manual_lock",
        },
      ],
      unlockedTaskData: [
        {
          taskId: 101,
          logisticCode: 5001,
          priority: "early_out",
          cleaningTime: 60,
          lat: 45.45,
          lng: 9.18,
          checkinDate: null,
          checkoutDate: null,
          checkinTime: null,
          checkoutTime: null,
          cleanerId: 10,
          cleanerStartTime: "10:00",
          cleanerTaskStartTime: "10:00",
          cleanerSequence: 1,
          premium: false,
          paxIn: 2,
          locked: false,
          lockedReason: null,
        },
        {
          taskId: 102,
          logisticCode: 5002,
          priority: "low_priority",
          cleaningTime: 30,
          lat: null,
          lng: null,
          checkinDate: null,
          checkoutDate: null,
          checkinTime: null,
          checkoutTime: null,
          cleanerId: 10,
          cleanerStartTime: "10:00",
          cleanerTaskStartTime: "10:00",
          cleanerSequence: 1,
          premium: false,
          paxIn: 1,
          locked: false,
          lockedReason: null,
        },
      ],
      schedulableTasks: [
        {
          taskId: 101,
          logisticCode: 5001,
          priority: "early_out",
          cleaningTime: 60,
          lat: 45.45,
          lng: 9.18,
          checkinDate: null,
          checkoutDate: null,
          checkinTime: null,
          checkoutTime: null,
          cleanerId: 10,
          cleanerStartTime: "10:00",
          cleanerTaskStartTime: "10:00",
          cleanerSequence: 1,
          premium: false,
          paxIn: 2,
          locked: false,
          lockedReason: null,
        },
      ],
      lockedTasksExcluded: 1,
      tasksExcludedNoCoordinatesIds: [102],
      selectedDrivers: [{
        id: 7,
        startTime: "09:30",
        startTimeSource: "driver_row",
        endTime: "20:00",
        endTimeSource: "default",
      }],
      timelineAssignmentHints: [],
      windowConfig: {
        source: "app_settings",
        workDate: "2026-06-04",
        priorityWindows,
        fallbackUsed: false,
      },
    };

    const input = buildRoutingProblemInputFromSource(sourceData);

    expect(input.tasks.map((task) => task.taskId)).toEqual([101]);
    expect(input.metadata.tasksExcludedNoCoordinatesIds).toEqual([102]);
    expect(input.metadata.lockedTasksExcluded).toBe(1);
    expect(input.metadata.excludedTasks).toEqual([
      { taskId: 103, reason: "LOCKED", detail: "manual_lock" },
      { taskId: 102, reason: "NO_COORDINATES" },
    ]);
    expect(input.metadata.timelineAssignmentHints).toEqual([]);
    expect(input.metadata.timelineAssignmentHintsCount).toBe(0);
    expect(input.metadata.preAssignedRequiredCount).toBe(0);
    expect(input.metadata.lockedAssignmentsSolverIntegration).toBe("integrated_v4b");
    expect(input.travelMatrixMin).toHaveLength(2);
    expect(input.travelMatrixMin[0]).toHaveLength(2);
    expect(input.tasks[0].debug?.ruleTrace).toContainEqual({ code: "EO_NO_HARD_LOWER_BOUND", value: 0 });
    expect(input.tasks[0].debug?.ruleTrace).toContainEqual(
      expect.objectContaining({ code: "CLEANER_HAS_BAG_FLEXIBLE_PICKUP" })
    );
    expect(input.metadata.validation.valid).toBe(true);
  });

  it("propagates complete bag and window rule trace to task debug", () => {
    const task = {
      taskId: 201,
      logisticCode: 6001,
      priority: "high_priority",
      cleaningTime: 60,
      lat: 45.45,
      lng: 9.18,
      checkinDate: null,
      checkoutDate: null,
      checkinTime: null,
      checkoutTime: null,
      cleanerId: 10,
      cleanerStartTime: "14:00",
      cleanerTaskStartTime: "14:00",
      cleanerSequence: 2,
      premium: false,
      paxIn: 2,
      locked: false,
      lockedReason: null,
    };
    const sourceData: LogisticsRoutingSourceData = {
      workDate: "2026-06-04",
      allTaskData: [task],
      unlockedTaskData: [task],
      schedulableTasks: [task],
      lockedTasksExcluded: 0,
      tasksExcludedNoCoordinatesIds: [],
      selectedDrivers: [{
        id: 7,
        startTime: "09:30",
        startTimeSource: "driver_row",
        endTime: "20:00",
        endTimeSource: "default",
      }],
      timelineAssignmentHints: [],
      windowConfig: {
        source: "app_settings",
        workDate: "2026-06-04",
        priorityWindows,
        fallbackUsed: false,
      },
    };

    const input = buildRoutingProblemInputFromSource(sourceData);
    const traceCodes = input.tasks[0].debug?.ruleTrace.map((trace) => trace.code) ?? [];

    expect(traceCodes).toContain("DRIVER_BRINGS_BAG_REQUIRED");
    expect(traceCodes).toContain("HP_CONFIGURED_START");
    expect(traceCodes).toContain(DRIVER_BRINGS_BAG_TOLERANCE_REASON);
  });
});
