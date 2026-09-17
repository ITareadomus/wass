import { describe, expect, it } from "vitest";
import { buildRoutingProblemInputFromSource } from "../server/services/logistics-optimizer-final/build-routing-input";
import {
  computeExclusiveWorkZones,
  partitionExclusiveWorkZones,
} from "../server/services/logistics-optimizer-final/exclusive-work-zones";
import { generateLogisticsRoutingHypotheses } from "../server/services/logistics-optimizer-final/routing-hypotheses";
import type { LogisticsRoutingSourceData } from "../server/services/logistics-optimizer-final/loaders";
import type { PriorityWindows } from "../server/services/optimizer/priorityWindows";
import { LOGISTICS_HYPOTHESIS_IDS } from "./logistics-routing-hypotheses";

const priorityWindows: PriorityWindows = {
  EO: { startMin: 0, endMin: 659, graceMin: 0 },
  HP: { startMin: 660, endMin: 930, graceMin: 0 },
  LP: { startMin: 660, endMin: null, graceMin: 0 },
};

function makeTask(
  taskId: number,
  lat: number,
  lng: number,
  extras: Partial<{
    cleaningTime: number;
    logisticsTaskKind: string;
    cleanerSequence: number;
    cleanerStartTime: string;
  }> = {}
) {
  return {
    taskId,
    logisticCode: 7000 + taskId,
    priority: "low_priority",
    cleaningTime: extras.cleaningTime ?? 60,
    lat,
    lng,
    checkinDate: null,
    checkoutDate: null,
    checkinTime: null,
    checkoutTime: null,
    cleanerId: 10,
    cleanerStartTime: extras.cleanerStartTime ?? "11:00",
    cleanerTaskStartTime: extras.cleanerStartTime ?? "11:00",
    cleanerSequence: extras.cleanerSequence ?? 2,
    premium: false,
    straordinaria: false,
    paxIn: 2,
    logisticsTaskKind: extras.logisticsTaskKind ?? "delivery/pick-up",
    logisticsTaskKindSource: "manual",
    locked: false,
    lockedReason: null,
  };
}

function buildSource(tasks: ReturnType<typeof makeTask>[]): LogisticsRoutingSourceData {
  return {
    workDate: "2026-06-04",
    allTaskData: tasks,
    unlockedTaskData: tasks,
    schedulableTasks: tasks,
    lockedTasksExcluded: 0,
    tasksExcludedNoCoordinatesIds: [],
    selectedDrivers: [
      {
        id: 7,
        startTime: "09:30",
        startTimeSource: "driver_row",
        endTime: "20:00",
        endTimeSource: "default",
      },
      {
        id: 8,
        startTime: "09:30",
        startTimeSource: "driver_row",
        endTime: "20:00",
        endTimeSource: "default",
      },
    ],
    timelineAssignmentHints: [],
    windowConfig: {
      source: "app_settings",
      workDate: "2026-06-04",
      priorityWindows,
      fallbackUsed: false,
    },
  };
}

describe("exclusive work zones", () => {
  it("keeps geographically distant apartments in separate zones", () => {
    const north = [makeTask(1, 45.51, 9.19), makeTask(2, 45.505, 9.185)];
    const south = [makeTask(3, 45.43, 9.17), makeTask(4, 45.435, 9.175)];
    const input = buildRoutingProblemInputFromSource(buildSource([...north, ...south]));

    const partition = computeExclusiveWorkZones({
      tasks: input.tasks,
      drivers: input.drivers,
      travelMatrixMin: input.travelMatrixMin,
    });

    expect(partition).not.toBeNull();
    expect(partition!.zones).toHaveLength(2);
    const northIds = new Set(north.map((task) => task.taskId));
    const zoneSets = partition!.zones.map((zone) => new Set(zone.taskIds));
    const northZone = zoneSets.find((zone) => [...northIds].every((taskId) => zone.has(taskId)));
    expect(northZone).toBeDefined();
    expect([...northZone!].some((taskId) => south.some((task) => task.taskId === taskId))).toBe(
      false
    );
  });

  it("does not mix apartments from different zones on the same hypothesis route", () => {
    const tasks = [
      makeTask(1, 45.51, 9.19),
      makeTask(2, 45.508, 9.188),
      makeTask(3, 45.43, 9.17),
      makeTask(4, 45.432, 9.172),
    ];
    const input = buildRoutingProblemInputFromSource(buildSource(tasks));
    const zones = partitionExclusiveWorkZones(input);
    const hypotheses = generateLogisticsRoutingHypotheses(input);

    expect(hypotheses.map((hypothesis) => hypothesis.summary.id)).toEqual([
      ...LOGISTICS_HYPOTHESIS_IDS,
    ]);

    const zoneByTask = new Map(
      zones.flatMap((zone) => zone.taskIds.map((taskId) => [taskId, zone.zoneIndex]))
    );

    for (const hypothesis of hypotheses) {
      for (const route of hypothesis.solution.routes) {
        const zoneIndexes = new Set(
          route.stops.map((stop) => zoneByTask.get(stop.taskId)).filter((value) => value != null)
        );
        expect(zoneIndexes.size).toBeLessThanOrEqual(1);
      }
    }
  });

  it("starts the four hypotheses from different first apartments when possible", () => {
    const tasks = [
      makeTask(1, 45.51, 9.19, { cleanerStartTime: "10:30", cleaningTime: 60 }),
      makeTask(2, 45.508, 9.22),
      makeTask(3, 45.43, 9.17, { cleaningTime: 360, cleanerStartTime: "10:00" }),
      makeTask(4, 45.432, 9.14),
    ];
    const input = buildRoutingProblemInputFromSource(buildSource(tasks));
    const hypotheses = generateLogisticsRoutingHypotheses(input);
    const firstStops = hypotheses.map((hypothesis) =>
      hypothesis.summary.routes.map((route) => route.firstLogisticCode).join(",")
    );
    expect(new Set(firstStops).size).toBeGreaterThan(1);
  });
});
