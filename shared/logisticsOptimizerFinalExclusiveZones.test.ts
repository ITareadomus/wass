import { describe, expect, it } from "vitest";
import { buildRoutingProblemInputFromSource } from "../server/services/logistics-optimizer-final/build-routing-input";
import {
  computeExclusiveWorkZones,
  geographicZoneLabels,
  partitionExclusiveWorkZones,
} from "../server/services/logistics-optimizer-final/exclusive-work-zones";
import { generateLogisticsRoutingHypotheses } from "../server/services/logistics-optimizer-final/routing-hypotheses";
import { buildZoneStartPlanFromInput } from "../server/services/logistics-optimizer-final/zone-start-plan";
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
    priority: string;
    checkoutDate: string;
    checkoutTime: string;
  }> = {}
) {
  return {
    taskId,
    logisticCode: 7000 + taskId,
    priority: extras.priority ?? "low_priority",
    cleaningTime: extras.cleaningTime ?? 60,
    lat,
    lng,
    checkinDate: null,
    checkoutDate: extras.checkoutDate ?? null,
    checkinTime: null,
    checkoutTime: extras.checkoutTime ?? null,
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

function buildSource(
  tasks: ReturnType<typeof makeTask>[],
  driverCount = 2
): LogisticsRoutingSourceData {
  return {
    workDate: "2026-06-04",
    allTaskData: tasks,
    unlockedTaskData: tasks,
    schedulableTasks: tasks,
    lockedTasksExcluded: 0,
    tasksExcludedNoCoordinatesIds: [],
    selectedDrivers: Array.from({ length: driverCount }, (_, index) => ({
      id: 7 + index,
      startTime: "09:30",
      startTimeSource: "driver_row",
      endTime: "20:00",
      endTimeSource: "default",
    })),
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

  it("exposes only Priorità, Distanza and Bilanciato", () => {
    const tasks = [
      makeTask(1, 45.51, 9.19, { cleanerStartTime: "10:30", cleaningTime: 60 }),
      makeTask(2, 45.508, 9.22),
      makeTask(3, 45.43, 9.17, { cleaningTime: 360, cleanerStartTime: "10:00" }),
      makeTask(4, 45.432, 9.14),
    ];
    const input = buildRoutingProblemInputFromSource(buildSource(tasks));
    const hypotheses = generateLogisticsRoutingHypotheses(input);
    expect(hypotheses.map((hypothesis) => hypothesis.summary.id)).toEqual([
      "priority-strict",
      "proximity-strict",
      "balanced-geo-start",
    ]);
    expect(hypotheses.map((hypothesis) => hypothesis.summary.title)).toEqual([
      "Priorità",
      "Distanza",
      "Bilanciato",
    ]);
  });

  it("keeps two apartments in the same building on the same driver", () => {
    const buildingLat = 45.4642;
    const buildingLng = 9.1728;
    const sameBuilding = [
      makeTask(1, buildingLat, buildingLng),
      makeTask(2, buildingLat, buildingLng),
    ];
    const north = [
      makeTask(3, 45.51, 9.19),
      makeTask(4, 45.512, 9.188),
      makeTask(5, 45.509, 9.192),
    ];
    const south = [
      makeTask(6, 45.43, 9.17),
      makeTask(7, 45.432, 9.172),
      makeTask(8, 45.428, 9.175),
    ];
    const input = buildRoutingProblemInputFromSource(
      buildSource([...sameBuilding, ...north, ...south])
    );
    const partition = computeExclusiveWorkZones({
      tasks: input.tasks,
      drivers: input.drivers,
      travelMatrixMin: input.travelMatrixMin,
    });
    const hypotheses = generateLogisticsRoutingHypotheses(input);

    expect(partition).not.toBeNull();
    const zoneSets = partition!.zones.map((zone) => new Set(zone.taskIds));
    const buildingZone = zoneSets.find((zone) => zone.has(1));
    expect(buildingZone).toBeDefined();
    expect(buildingZone!.has(2)).toBe(true);

    const pianoB = hypotheses.find((entry) => entry.summary.id === "proximity-strict");
    expect(pianoB).toBeDefined();
    const driverByTask = new Map(
      pianoB!.solution.routes.flatMap((route) =>
        route.stops.map((stop) => [stop.taskId, route.driverId] as const)
      )
    );
    expect(driverByTask.get(1)).toBe(driverByTask.get(2));
  });

  it("builds compact count-balanced zones that do not mix east and west apartments", () => {
    const tasks = Array.from({ length: 12 }, (_, index) =>
      makeTask(index + 1, 45.46, 9.1 + index * 0.02)
    );
    const input = buildRoutingProblemInputFromSource(buildSource(tasks, 3));
    const partition = computeExclusiveWorkZones({
      tasks: input.tasks,
      drivers: input.drivers,
      travelMatrixMin: input.travelMatrixMin,
    });

    expect(partition).not.toBeNull();
    expect(partition!.zones).toHaveLength(3);
    const sizes = partition!.zones.map((zone) => zone.taskIds.length).sort((left, right) => left - right);
    expect(sizes[2] - sizes[0]).toBeLessThanOrEqual(1);

    const lngByTaskId = new Map(tasks.map((task) => [task.taskId, task.lng]));
    const orderedZones = [...partition!.zones].sort((left, right) => left.centroid.lng - right.centroid.lng);
    const lngBands = orderedZones.map((zone) =>
      zone.taskIds.map((taskId) => lngByTaskId.get(taskId)!).sort((left, right) => left - right)
    );
    expect(Math.max(...lngBands[0])).toBeLessThan(Math.min(...lngBands[1]));
    expect(Math.max(...lngBands[1])).toBeLessThan(Math.min(...lngBands[2]));
  });

  it("assigns every apartment on both Piano A and Piano B", () => {
    const tasks = [
      makeTask(1, 45.51, 9.19),
      makeTask(2, 45.508, 9.188),
      makeTask(3, 45.43, 9.17),
      makeTask(4, 45.432, 9.172),
      makeTask(5, 45.47, 9.21),
      makeTask(6, 45.44, 9.15),
    ];
    const input = buildRoutingProblemInputFromSource(buildSource(tasks));
    const hypotheses = generateLogisticsRoutingHypotheses(input);

    for (const id of ["priority-strict", "proximity-strict"] as const) {
      const hypothesis = hypotheses.find((entry) => entry.summary.id === id);
      expect(hypothesis).toBeDefined();
      expect(hypothesis!.summary.droppedTaskCount).toBe(0);
      expect(hypothesis!.summary.assignedTaskCount).toBe(tasks.length);
      const assigned = new Set(
        hypothesis!.solution.routes.flatMap((route) => route.stops.map((stop) => stop.taskId))
      );
      expect([...assigned].sort((left, right) => left - right)).toEqual(
        tasks.map((task) => task.taskId).sort((left, right) => left - right)
      );
    }
  });

  it("does not start Piano A from an early-out when a nearer apartment exists", () => {
    const earlyOut = makeTask(1, 45.52, 9.08, {
      priority: "early_out",
      checkoutDate: "2026-06-04",
      checkoutTime: "08:00",
      logisticsTaskKind: "pick-up",
      cleanerSequence: 1,
    });
    const nearby = makeTask(2, 45.435, 9.181);
    const input = buildRoutingProblemInputFromSource(buildSource([earlyOut, nearby], 1));
    const hypotheses = generateLogisticsRoutingHypotheses(input);
    const pianoA = hypotheses.find((entry) => entry.summary.id === "priority-strict");
    expect(pianoA).toBeDefined();
    expect(pianoA!.summary.routes[0]?.firstLogisticCode).toBe(nearby.logisticCode);
  });

  it("keeps a tight D&P ahead of a loose D&P that would steal its only window", () => {
    const loose = makeTask(1, 45.436, 9.182, {
      cleaningTime: 360,
      cleanerStartTime: "11:00",
    });
    const urgent = makeTask(2, 45.48, 9.55, {
      cleaningTime: 60,
      cleanerStartTime: "11:00",
    });
    const input = buildRoutingProblemInputFromSource(buildSource([loose, urgent], 1));
    const hypotheses = generateLogisticsRoutingHypotheses(input);

    for (const id of ["priority-strict", "proximity-strict"] as const) {
      const hypothesis = hypotheses.find((entry) => entry.summary.id === id);
      expect(hypothesis).toBeDefined();
      const order = hypothesis!.solution.routes[0]?.stops.map((stop) => stop.taskId) ?? [];
      expect(order.indexOf(urgent.taskId)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(urgent.taskId)).toBeLessThan(order.indexOf(loose.taskId));
    }
  });

  it("builds Piano B as a geographic sweep starting from the priority cluster", () => {
    const priorityWest = [
      makeTask(1, 45.46, 9.1, { priority: "high_priority" }),
      makeTask(2, 45.461, 9.12, { priority: "high_priority" }),
      makeTask(3, 45.459, 9.14, { priority: "early_out", checkoutDate: "2026-06-04", checkoutTime: "08:00" }),
    ];
    const lowEast = [
      makeTask(4, 45.46, 9.22),
      makeTask(5, 45.461, 9.24),
      makeTask(6, 45.459, 9.26),
    ];
    const input = buildRoutingProblemInputFromSource(buildSource([...priorityWest, ...lowEast], 1));
    const hypotheses = generateLogisticsRoutingHypotheses(input);
    const pianoB = hypotheses.find((entry) => entry.summary.id === "proximity-strict");
    expect(pianoB).toBeDefined();
    const order = pianoB!.solution.routes[0]?.stops.map((stop) => stop.taskId) ?? [];
    expect(order).toHaveLength(6);
    expect(priorityWest.some((task) => task.taskId === order[0])).toBe(true);

    const lngByTaskId = new Map(
      [...priorityWest, ...lowEast].map((task) => [task.taskId, task.lng])
    );
    const lngs = order.map((taskId) => lngByTaskId.get(taskId)!);
    let reversals = 0;
    for (let index = 1; index < lngs.length; index += 1) {
      if (Math.sign(lngs[index] - lngs[index - 1]) !== Math.sign(lngs[lngs.length - 1] - lngs[0])) {
        if (lngs[index] !== lngs[index - 1]) reversals += 1;
      }
    }
    expect(reversals).toBeLessThanOrEqual(1);
  });

  it("does not zigzag Piano B along a line of apartments", () => {
    const tasks = [
      makeTask(1, 45.46, 9.1),
      makeTask(2, 45.46, 9.14),
      makeTask(3, 45.46, 9.18),
      makeTask(4, 45.46, 9.22),
      makeTask(5, 45.46, 9.26),
    ];
    const input = buildRoutingProblemInputFromSource(buildSource(tasks, 1));
    const hypotheses = generateLogisticsRoutingHypotheses(input);
    const pianoB = hypotheses.find((entry) => entry.summary.id === "proximity-strict");
    const order = pianoB!.solution.routes[0]?.stops.map((stop) => stop.taskId) ?? [];
    expect([
      [1, 2, 3, 4, 5],
      [5, 4, 3, 2, 1],
    ]).toContainEqual(order);
  });

  it("keeps Piano A inside exclusive zones, assigns every apartment, and meets windows when they fit", () => {
    const west = [
      makeTask(1, 45.46, 9.1, { cleaningTime: 360 }),
      makeTask(2, 45.461, 9.12, { cleaningTime: 360 }),
    ];
    const center = [
      makeTask(3, 45.46, 9.2, { cleaningTime: 360 }),
      makeTask(4, 45.461, 9.22, { cleaningTime: 360 }),
    ];
    const east = [
      makeTask(5, 45.46, 9.3, { cleaningTime: 360 }),
      makeTask(6, 45.461, 9.32, { cleaningTime: 360 }),
    ];
    const tasks = [...west, ...center, ...east];
    const input = buildRoutingProblemInputFromSource(buildSource(tasks, 3));
    const zones = partitionExclusiveWorkZones(input);
    const pianoA = generateLogisticsRoutingHypotheses(input).find(
      (entry) => entry.summary.id === "priority-strict"
    );

    expect(zones).toHaveLength(3);
    expect(pianoA).toBeDefined();
    expect(pianoA!.summary.droppedTaskCount).toBe(0);
    expect(pianoA!.summary.assignedTaskCount).toBe(tasks.length);
    expect(pianoA!.summary.windowViolationCount).toBe(0);

    const zoneByTask = new Map(
      zones.flatMap((zone) => zone.taskIds.map((taskId) => [taskId, zone.zoneIndex]))
    );
    for (const route of pianoA!.solution.routes) {
      const zoneIndexes = new Set(
        route.stops.map((stop) => zoneByTask.get(stop.taskId)).filter((value) => value != null)
      );
      expect(zoneIndexes.size).toBeLessThanOrEqual(1);
    }
  });

  it("lists one start-choice group per driver after exclusive zoning", () => {
    const tasks = [
      makeTask(1, 45.51, 9.19),
      makeTask(2, 45.508, 9.188),
      makeTask(3, 45.43, 9.17),
      makeTask(4, 45.432, 9.172),
    ];
    const input = buildRoutingProblemInputFromSource(buildSource(tasks, 2));
    const plan = buildZoneStartPlanFromInput(input);
    expect(plan.drivers).toHaveLength(2);
    const listed = plan.drivers.flatMap((driver) => driver.tasks.map((task) => task.taskId)).sort();
    expect(listed).toEqual([1, 2, 3, 4]);
    expect(plan.drivers.every((driver) => driver.tasks.length > 0)).toBe(true);
    expect(plan.drivers.every((driver) => Number.isInteger(driver.zoneIndex))).toBe(true);
    expect(
      plan.drivers.every((driver) =>
        driver.tasks.every(
          (task) => Number.isFinite(task.lat) && Number.isFinite(task.lng)
        )
      )
    ).toBe(true);
  });

  it("labels exclusive zones by number", () => {
    expect(geographicZoneLabels(2)).toEqual(["Zona 1", "Zona 2"]);
    expect(geographicZoneLabels(3)).toEqual(["Zona 1", "Zona 2", "Zona 3"]);
    const tasks = [
      makeTask(1, 45.51, 9.19),
      makeTask(2, 45.508, 9.188),
      makeTask(3, 45.43, 9.17),
      makeTask(4, 45.432, 9.172),
    ];
    const input = buildRoutingProblemInputFromSource(buildSource(tasks, 2));
    const labels = partitionExclusiveWorkZones(input).map((zone) => zone.label);
    expect(labels).toEqual(["Zona 1", "Zona 2"]);
  });

  it("assigns swapped exclusive zones to the chosen drivers", () => {
    const tasks = [
      makeTask(1, 45.51, 9.19),
      makeTask(2, 45.508, 9.188),
      makeTask(3, 45.43, 9.17),
      makeTask(4, 45.432, 9.172),
    ];
    const input = buildRoutingProblemInputFromSource(buildSource(tasks, 2));
    const zones = partitionExclusiveWorkZones(input);
    expect(zones).toHaveLength(2);
    const driverIdByZoneIndex = new Map<number, number>([
      [zones[0].zoneIndex, zones[1].driverId],
      [zones[1].zoneIndex, zones[0].driverId],
    ]);
    const hypotheses = generateLogisticsRoutingHypotheses(input, { driverIdByZoneIndex });
    expect(hypotheses).toHaveLength(3);
    for (const hypothesis of hypotheses) {
      for (const zone of zones) {
        const driverId = driverIdByZoneIndex.get(zone.zoneIndex);
        const route = hypothesis.solution.routes.find((entry) => entry.driverId === driverId);
        const stopIds = new Set(route?.stops.map((stop) => stop.taskId) ?? []);
        for (const taskId of zone.taskIds) {
          expect(stopIds.has(taskId)).toBe(true);
        }
      }
    }
  });

  it("starts every hypothesis from the driver start chosen by the user", () => {
    const tasks = [
      makeTask(1, 45.51, 9.19),
      makeTask(2, 45.508, 9.188),
      makeTask(3, 45.43, 9.17),
      makeTask(4, 45.432, 9.172),
    ];
    const input = buildRoutingProblemInputFromSource(buildSource(tasks, 2));
    const zones = partitionExclusiveWorkZones(input);
    expect(zones.length).toBeGreaterThan(0);
    const preferredStartByDriverId = new Map<number, number>();
    for (const zone of zones) {
      const startTaskId = [...zone.taskIds].sort((left, right) => right - left)[0];
      preferredStartByDriverId.set(zone.driverId, startTaskId);
    }
    const hypotheses = generateLogisticsRoutingHypotheses(input, { preferredStartByDriverId });
    expect(hypotheses).toHaveLength(3);
    for (const hypothesis of hypotheses) {
      for (const zone of zones) {
        const route = hypothesis.solution.routes.find((entry) => entry.driverId === zone.driverId);
        expect(route?.stops[0]?.taskId).toBe(preferredStartByDriverId.get(zone.driverId));
      }
    }
  });
});
