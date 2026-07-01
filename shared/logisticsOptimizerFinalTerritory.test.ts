import { describe, expect, it, afterEach } from "vitest";
import { LOGISTICS_SERVICE_DURATION_MIN } from "./logistics-scheduling-constraints";
import type {
  DriverNode,
  RoutingProblemInput,
  TaskNode,
} from "../server/services/logistics-optimizer-final/input-contract";
import { buildDailyTerritoryAssignment } from "../server/services/logistics-optimizer-final/groups/daily-territory-groups";
import { buildLocationNodes, buildTravelMatrixMin } from "../server/services/logistics-optimizer-final/travel-matrix";
import { buildVehicleTaskPenalties, resolveTerritoryMismatchPenalty } from "../server/services/logistics-optimizer-final/groups/territory-penalties";
import {
  HISTORICAL_TEMPLATE_PENALTY_CONFIG,
  TERRITORY_ALGO_CONFIG,
} from "../server/services/logistics-optimizer-final/groups/territory-config";
import {
  extractDriverOperationalCode,
  THREE_DRIVER_TERRITORY_PROFILES,
} from "../server/services/logistics-optimizer-final/groups/historical-territory-profiles";
import { matchTerritoriesToDrivers } from "../server/services/logistics-optimizer-final/groups/territory-driver-matching";
import { buildOrToolsPayload } from "../server/services/logistics-optimizer-final/solver/ortools/ortools-adapter";
import { buildTerritoriesGeoJson } from "../server/services/logistics-optimizer-final/groups/territory-geojson";

const originalDebugEnv = process.env.LOGISTICS_TERRITORY_DEBUG;
const originalPenaltiesEnv = process.env.LOGISTICS_TERRITORY_PENALTIES;

afterEach(() => {
  if (originalDebugEnv === undefined) {
    delete process.env.LOGISTICS_TERRITORY_DEBUG;
  } else {
    process.env.LOGISTICS_TERRITORY_DEBUG = originalDebugEnv;
  }
  if (originalPenaltiesEnv === undefined) {
    delete process.env.LOGISTICS_TERRITORY_PENALTIES;
  } else {
    process.env.LOGISTICS_TERRITORY_PENALTIES = originalPenaltiesEnv;
  }
});

function buildTask(taskId: number, lat: number, lng: number): TaskNode {
  return {
    taskId,
    logisticCode: taskId,
    nodeIndex: taskId,
    location: { lat, lng },
    priority: "EO",
    logisticsTaskKind: null,
    serviceDurationMin: LOGISTICS_SERVICE_DURATION_MIN,
    rawTimes: {
      checkoutDate: null,
      checkoutTime: null,
      checkinDate: null,
      checkinTime: null,
      cleanerStartTime: null,
      cleanerTaskStartTime: null,
    },
    hardWindow: {
      earliestStartMin: 600,
      latestStartMin: 900,
      latestEndMin: 960,
      reasons: [],
    },
    softWindows: [],
    groupingHints: {
      cleanerId: null,
      cleanerSequence: null,
      addressGroupId: null,
      sameLogisticCodeGroup: null,
    },
    eligibility: {
      schedulable: true,
      exclusionReasons: [],
    },
  };
}

function buildDrivers(count: number, operationalCodes?: string[]): DriverNode[] {
  return Array.from({ length: count }, (_, index) => ({
    id: 700 + index,
    startLocationNodeId: "depot",
    operationalCode: operationalCodes?.[index],
    workWindow: {
      startMin: 570,
      endMin: 1200,
      startSource: "default" as const,
      endSource: "default" as const,
    },
    selected: true as const,
  }));
}

function milanLikeTasks(): TaskNode[] {
  const centers = [
    THREE_DRIVER_TERRITORY_PROFILES[0].centroid,
    THREE_DRIVER_TERRITORY_PROFILES[1].centroid,
    THREE_DRIVER_TERRITORY_PROFILES[2].centroid,
  ];
  const tasks: TaskNode[] = [];
  let taskId = 1;
  for (const center of centers) {
    for (let index = 0; index < 14; index += 1) {
      const latOffset = ((index % 4) - 1.5) * 0.0015;
      const lngOffset = (Math.floor(index / 4) - 1.5) * 0.0015;
      tasks.push(buildTask(taskId, center.lat + latOffset, center.lng + lngOffset));
      taskId += 1;
    }
  }
  return tasks;
}

function travelMatrixForTasks(tasks: TaskNode[]): number[][] {
  return buildTravelMatrixMin(buildLocationNodes(tasks));
}

function buildInput(tasks: TaskNode[], drivers: DriverNode[]): RoutingProblemInput {
  const travelMatrixMin = travelMatrixForTasks(tasks);
  const territoryBuild = buildDailyTerritoryAssignment({
    tasks,
    drivers,
    travelMatrixMin,
    requiredDriverByTaskId: new Map(),
  });

  return {
    schemaVersion: "logistics-routing-input/v1",
    workDate: "2026-07-01",
    windowConfig: {
      source: "app_settings",
      workDate: "2026-07-01",
      priorityWindows: null,
      fallbackUsed: false,
    },
    depot: {
      nodeId: "depot",
      nodeIndex: 0,
      kind: "DEPOT",
      lat: 45.4642,
      lng: 9.19,
    },
    drivers,
    tasks,
    travelMatrixMin,
    serviceDurationMin: LOGISTICS_SERVICE_DURATION_MIN,
    hardConstraints: [],
    softConstraints: [],
    businessGroups: territoryBuild.groups,
    metadata: {
      generatedAt: "2026-07-01T00:00:00.000Z",
      totalLogisticsTasks: tasks.length,
      lockedTasksExcluded: 0,
      tasksExcludedNoCoordinatesCount: 0,
      tasksExcludedNoCoordinatesIds: [],
      noSelectedDrivers: false,
      excludedTasks: [],
      timelineAssignmentHints: [],
      timelineAssignmentHintsCount: 0,
      preAssignedRequiredCount: 0,
      skippedTimelineAssignmentHintsCount: 0,
      autoConvokedDriverIds: [],
      autoConvokedDriversCount: 0,
      autoConvokeMissingInDbDriverIds: [],
      autoConvokeMissingInDbDriversCount: 0,
      sameBuildingDriverLockCount: 0,
      skippedSameBuildingGroupsCount: 0,
      dailyTerritoryAssignment: territoryBuild.assignment,
      lockedAssignmentsSolverIntegration: "integrated_v4b",
      validation: { valid: true, errors: [], warnings: [] },
    },
  };
}

describe("daily territory assignment", () => {
  it("uses historical templates for a 42 task / 3 driver Milan-like day", () => {
    const tasks = milanLikeTasks();
    const result = buildDailyTerritoryAssignment({
      tasks,
      drivers: buildDrivers(3, ["ADP03", "ADP01", "ADP02"]),
      travelMatrixMin: travelMatrixForTasks(tasks),
      requiredDriverByTaskId: new Map(),
    });

    expect(result.groups).toHaveLength(3);
    expect(result.assignment?.territoryMode).toBe("historical_template_3_drivers");
    expect(result.groups.every((group) => group.source === "historical_territory_template")).toBe(true);
    expect(result.groups.map((group) => group.taskIds.length).sort((a, b) => a - b)).toEqual([
      14,
      14,
      14,
    ]);
    expect(result.assignment?.profiles).toHaveLength(3);
    expect(result.assignment?.profiles?.map((profile) => profile.territoryKey).sort()).toEqual([
      "center_south_east",
      "center_south_west",
      "north",
    ]);
  });

  it("falls back to dynamic clustering when driver count is not 3", () => {
    const tasks = milanLikeTasks();
    const result = buildDailyTerritoryAssignment({
      tasks,
      drivers: buildDrivers(2),
      travelMatrixMin: travelMatrixForTasks(tasks),
      requiredDriverByTaskId: new Map(),
    });

    expect(result.assignment?.territoryMode).toBe("dynamic_clustering");
    expect(result.groups.every((group) => group.source === "balanced_geo_cluster")).toBe(true);
  });

  it("uses an outlier-safe penalty radius in dynamic clustering", () => {
    const tasks = [
      ...Array.from({ length: 10 }, (_, index) =>
        buildTask(index + 1, 45.46 + index * 0.0001, 9.18 + index * 0.0001)
      ),
      buildTask(11, 45.5, 9.25),
    ];
    const result = buildDailyTerritoryAssignment({
      tasks,
      drivers: buildDrivers(1),
      travelMatrixMin: travelMatrixForTasks(tasks),
      requiredDriverByTaskId: new Map(),
    });

    expect(result.groups[0].radiusMeters).toBeGreaterThan(result.groups[0].penaltyRadiusMeters);
  });

  it("prefers historical driver codes when matching territories", () => {
    const tasks = milanLikeTasks();
    const travelMatrixMin = travelMatrixForTasks(tasks);
    const result = buildDailyTerritoryAssignment({
      tasks,
      drivers: buildDrivers(3, ["ADP03", "ADP01", "ADP02"]),
      travelMatrixMin,
      requiredDriverByTaskId: new Map(),
    });

    const northTerritory = result.assignment?.territories.find(
      (territory) => territory.territoryKey === "north"
    );
    expect(northTerritory?.assignedDriverId).toBe(700);
  });

  it("extracts ADP operational codes from driver labels", () => {
    expect(
      extractDriverOperationalCode({ name: "ADP03 GR792SN", lastname: "Rossi", alias: null })
    ).toBe("ADP03");
    expect(extractDriverOperationalCode({ name: "Mario", lastname: "ADP01 GT408NZ" })).toBe("ADP01");
  });

  it("applies historical driver bias during matching", () => {
    const assignment = matchTerritoriesToDrivers({
      territories: [
        {
          territoryIndex: 0,
          taskIds: [1, 2],
          hubNodeIndex: 1,
          preferredHistoricalDriverCode: "ADP03",
        },
      ],
      drivers: [
        {
          id: 701,
          startLocationNodeId: "depot",
          operationalCode: "ADP03",
          workWindow: { startMin: 570, endMin: 1200, startSource: "default", endSource: "default" },
          selected: true,
        },
        {
          id: 702,
          startLocationNodeId: "depot",
          operationalCode: "ADP01",
          workWindow: { startMin: 570, endMin: 1200, startSource: "default", endSource: "default" },
          selected: true,
        },
      ],
      travelMatrixMin: [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
      requiredDriverByTaskId: new Map(),
      useHistoricalDriverBias: true,
    });

    expect(assignment[0]?.assignedDriverId).toBe(701);
  });

  it("keeps territory penalties out of the payload when PENALTIES=0", () => {
    process.env.LOGISTICS_TERRITORY_PENALTIES = "0";
    const input = buildInput(milanLikeTasks(), buildDrivers(3, ["ADP03", "ADP01", "ADP02"]));
    const payload = buildOrToolsPayload(input).payload;

    expect(payload.vehicleTaskPenalties).toBeUndefined();
  });

  it("builds vehicle task penalties when enabled", () => {
    process.env.LOGISTICS_TERRITORY_PENALTIES = "1";
    const input = buildInput(milanLikeTasks(), buildDrivers(3, ["ADP03", "ADP01", "ADP02"]));
    const { maps } = buildOrToolsPayload(input);
    const penalties = buildVehicleTaskPenalties({
      input,
      driverIdToVehicleIndex: maps.driverIdToVehicleIndex,
    });

    expect(penalties).toBeDefined();
    expect(penalties).toHaveLength(input.drivers.length);
    expect(penalties?.[0]).toHaveLength(input.travelMatrixMin.length);
  });

  it("uses explicit core, normal, and border penalties", () => {
    expect(resolveTerritoryMismatchPenalty(0.5)).toBe(TERRITORY_ALGO_CONFIG.coreMismatchPenaltyMin);
    expect(resolveTerritoryMismatchPenalty(0.8)).toBe(TERRITORY_ALGO_CONFIG.normalMismatchPenaltyMin);
    expect(resolveTerritoryMismatchPenalty(1.1)).toBe(TERRITORY_ALGO_CONFIG.borderMismatchPenaltyMin);
  });

  it("uses stronger penalties for historical templates", () => {
    expect(resolveTerritoryMismatchPenalty(0.5, HISTORICAL_TEMPLATE_PENALTY_CONFIG)).toBe(120);
    expect(resolveTerritoryMismatchPenalty(0.8, HISTORICAL_TEMPLATE_PENALTY_CONFIG)).toBe(70);
    expect(resolveTerritoryMismatchPenalty(1.1, HISTORICAL_TEMPLATE_PENALTY_CONFIG)).toBe(20);
  });

  it("exports territories as GeoJSON with historical circles", () => {
    const input = buildInput(milanLikeTasks(), buildDrivers(3, ["ADP03", "ADP01", "ADP02"]));
    const geoJson = buildTerritoriesGeoJson(input);

    expect(geoJson?.type).toBe("FeatureCollection");
    expect(geoJson?.features.some((feature) => feature.properties.kind === "territory-radius")).toBe(true);
    expect(
      geoJson?.features.some((feature) => feature.properties.kind === "historical-territory-penalty-radius")
    ).toBe(true);
    expect(geoJson?.features.some((feature) => feature.properties.kind === "task")).toBe(true);
  });
});
