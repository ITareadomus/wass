import type { RoutingProblemInput, TaskNode } from "../input-contract";

const EARTH_RADIUS_M = 6371000;

type GeoJsonFeature = {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: {
    type: "Point" | "Polygon";
    coordinates: unknown;
  };
};

function circlePolygon(
  center: { lat: number; lng: number },
  radiusMeters: number,
  steps = 64
): number[][][] {
  const latRad = (center.lat * Math.PI) / 180;
  const lngRad = (center.lng * Math.PI) / 180;
  const angularDistance = radiusMeters / EARTH_RADIUS_M;
  const coordinates: number[][] = [];

  for (let step = 0; step <= steps; step += 1) {
    const bearing = (2 * Math.PI * step) / steps;
    const pointLat = Math.asin(
      Math.sin(latRad) * Math.cos(angularDistance) +
        Math.cos(latRad) * Math.sin(angularDistance) * Math.cos(bearing)
    );
    const pointLng =
      lngRad +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latRad),
        Math.cos(angularDistance) - Math.sin(latRad) * Math.sin(pointLat)
      );
    coordinates.push([(pointLng * 180) / Math.PI, (pointLat * 180) / Math.PI]);
  }

  return [coordinates];
}

function taskFeature(
  task: TaskNode,
  territoryId: string,
  territoryIndex: number,
  options?: {
    color?: string;
    assignmentSource?: string;
    preferredDriverId?: number;
  }
): GeoJsonFeature {
  return {
    type: "Feature",
    properties: {
      kind: "task",
      taskId: task.taskId,
      territoryId,
      territoryIndex,
      priority: task.priority,
      color: options?.color,
      assignmentSource: options?.assignmentSource,
      preferredDriverId: options?.preferredDriverId,
    },
    geometry: {
      type: "Point",
      coordinates: [task.location.lng, task.location.lat],
    },
  };
}

export function buildTerritoriesGeoJson(input: RoutingProblemInput): {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
} | null {
  const assignment = input.metadata.dailyTerritoryAssignment;
  if (!assignment || assignment.territories.length === 0) {
    return null;
  }

  const territoryByTaskId = new Map(
    assignment.taskTerritoryIndex.map((entry) => [entry.taskId, entry.territoryIndex])
  );
  const assignmentSourceByTaskId = new Map(
    assignment.taskAssignmentDetails?.map((entry) => [entry.taskId, entry.assignmentSource]) ?? []
  );
  const preferredDriverByTaskId = new Map(
    assignment.taskPreferredDriverId.map((entry) => [entry.taskId, entry.driverId])
  );
  const features: GeoJsonFeature[] = [];

  for (const territory of assignment.territories) {
    const historicalCentroid = territory.historicalCentroid ?? territory.centroid;
    const historicalPenaltyRadius =
      territory.historicalPenaltyRadiusMeters ?? territory.penaltyRadiusMeters;

    if (assignment.territoryMode === "historical_template_3_drivers") {
      features.push({
        type: "Feature",
        properties: {
          kind: "historical-territory-penalty-radius",
          territoryId: territory.territoryId,
          territoryIndex: territory.territoryIndex,
          territoryKey: territory.territoryKey,
          assignedDriverId: territory.assignedDriverId,
          radiusMeters: historicalPenaltyRadius,
          color: territory.suggestedColor,
        },
        geometry: {
          type: "Polygon",
          coordinates: circlePolygon(historicalCentroid, historicalPenaltyRadius),
        },
      });
    }

    features.push({
      type: "Feature",
      properties: {
        kind: "territory-radius",
        territoryId: territory.territoryId,
        territoryIndex: territory.territoryIndex,
        territoryKey: territory.territoryKey,
        assignedDriverId: territory.assignedDriverId,
        radiusMeters: territory.radiusMeters,
        penaltyRadiusMeters: territory.penaltyRadiusMeters,
        color: territory.suggestedColor,
        taskCount: territory.taskIds.length,
        territoryMode: assignment.territoryMode,
      },
      geometry: {
        type: "Polygon",
        coordinates: circlePolygon(territory.centroid, territory.radiusMeters),
      },
    });

    features.push({
      type: "Feature",
      properties: {
        kind: "territory-penalty-radius",
        territoryId: territory.territoryId,
        territoryIndex: territory.territoryIndex,
        territoryKey: territory.territoryKey,
        assignedDriverId: territory.assignedDriverId,
        radiusMeters: territory.penaltyRadiusMeters,
        color: territory.suggestedColor,
      },
      geometry: {
        type: "Polygon",
        coordinates: circlePolygon(territory.centroid, territory.penaltyRadiusMeters),
      },
    });

    features.push({
      type: "Feature",
      properties: {
        kind: "territory-centroid",
        territoryId: territory.territoryId,
        territoryIndex: territory.territoryIndex,
        territoryKey: territory.territoryKey,
        assignedDriverId: territory.assignedDriverId,
        color: territory.suggestedColor,
      },
      geometry: {
        type: "Point",
        coordinates: [territory.centroid.lng, territory.centroid.lat],
      },
    });
  }

  for (const task of input.tasks) {
    const territoryIndex = territoryByTaskId.get(task.taskId);
    if (territoryIndex === undefined) continue;
    const territory = assignment.territories.find((item) => item.territoryIndex === territoryIndex);
    features.push(
      taskFeature(task, territory?.territoryId ?? `daily-territory:${territoryIndex}`, territoryIndex, {
        color: territory?.suggestedColor,
        assignmentSource: assignmentSourceByTaskId.get(task.taskId),
        preferredDriverId: preferredDriverByTaskId.get(task.taskId),
      })
    );
  }

  return {
    type: "FeatureCollection",
    features,
  };
}

export function enrichTerritoriesGeoJsonWithSolution(
  geoJson: NonNullable<ReturnType<typeof buildTerritoriesGeoJson>>,
  input: RoutingProblemInput,
  solution: { routes: Array<{ driverId: number; stops: Array<{ taskId: number }> }> }
): typeof geoJson {
  const preferredDriverByTaskId = new Map(
    input.metadata.dailyTerritoryAssignment?.taskPreferredDriverId.map((entry) => [
      entry.taskId,
      entry.driverId,
    ]) ?? []
  );
  const actualDriverByTaskId = new Map<number, number>();
  for (const route of solution.routes) {
    for (const stop of route.stops) {
      actualDriverByTaskId.set(stop.taskId, route.driverId);
    }
  }

  return {
    ...geoJson,
    features: geoJson.features.map((feature) => {
      if (feature.properties.kind !== "task") return feature;
      const taskId = Number(feature.properties.taskId);
      const preferredDriverId = preferredDriverByTaskId.get(taskId);
      const actualDriverId = actualDriverByTaskId.get(taskId);
      if (preferredDriverId === undefined || actualDriverId === undefined) {
        return feature;
      }
      if (preferredDriverId === actualDriverId) {
        return feature;
      }
      return {
        ...feature,
        properties: {
          ...feature.properties,
          solverOutsideTerritory: true,
          actualDriverId,
          preferredDriverId,
        },
      };
    }),
  };
}
