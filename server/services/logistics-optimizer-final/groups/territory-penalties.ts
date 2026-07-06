import type { DriverId, RoutingProblemInput, TaskId } from "../input-contract";
import { haversineMeters } from "./geo-utils";
import { TERRITORY_ALGO_CONFIG, type TerritoryPenaltyConfig } from "./territory-config";
import type { HistoricalTerritoryKey } from "./historical-territory-profiles";

const NON_ADJACENT_TERRITORY_PENALTY_MIN = 90;
const FOREIGN_TERRITORY_DISTANCE_PENALTY_MIN = 90;
const FAR_FOREIGN_TERRITORY_DISTANCE_PENALTY_MIN = 180;
const FOREIGN_TERRITORY_DISTANCE_RATIO = 1.3;
const FAR_FOREIGN_TERRITORY_DISTANCE_RATIO = 1.6;

const HISTORICAL_TERRITORY_ADJACENCY: Record<HistoricalTerritoryKey, HistoricalTerritoryKey[]> = {
  north: ["center_south_east", "center_south_west"],
  center_south_east: ["north"],
  center_south_west: ["north"],
};

export function resolveTerritoryMismatchPenalty(
  ratio: number,
  penaltyConfig: TerritoryPenaltyConfig = TERRITORY_ALGO_CONFIG
): number {
  if (ratio <= TERRITORY_ALGO_CONFIG.coreRadiusRatio) {
    return penaltyConfig.coreMismatchPenaltyMin;
  }
  if (ratio <= TERRITORY_ALGO_CONFIG.borderRadiusRatio) {
    return penaltyConfig.normalMismatchPenaltyMin;
  }
  return penaltyConfig.borderMismatchPenaltyMin;
}

function requiredDriverByTaskId(input: RoutingProblemInput): Map<TaskId, DriverId> {
  const required = new Map<TaskId, DriverId>();
  for (const constraint of input.hardConstraints) {
    if (constraint.type === "REQUIRED_DRIVER_TASK") {
      required.set(constraint.taskId, constraint.driverId);
    }
  }
  return required;
}

function taskTerritoryRatio(args: {
  taskLat: number;
  taskLng: number;
  territory: {
    centroid: { lat: number; lng: number };
    penaltyRadiusMeters: number;
  };
}): number {
  const distanceFromCentroid = haversineMeters(
    args.taskLat,
    args.taskLng,
    args.territory.centroid.lat,
    args.territory.centroid.lng
  );
  return distanceFromCentroid / Math.max(args.territory.penaltyRadiusMeters, 1);
}

function territoryKeysAdjacent(
  preferredKey: HistoricalTerritoryKey | undefined,
  candidateKey: HistoricalTerritoryKey | undefined
): boolean {
  if (!preferredKey || !candidateKey) return true;
  if (preferredKey === candidateKey) return true;
  return HISTORICAL_TERRITORY_ADJACENCY[preferredKey]?.includes(candidateKey) ?? true;
}

function resolveForeignDriverTerritoryPenalty(args: {
  preferredTerritoryKey?: HistoricalTerritoryKey;
  candidateTerritoryKey?: HistoricalTerritoryKey;
  candidateTerritoryRatio: number;
  historicalTemplate: boolean;
}): number {
  if (!args.historicalTemplate) return 0;

  let penalty = 0;
  if (!territoryKeysAdjacent(args.preferredTerritoryKey, args.candidateTerritoryKey)) {
    penalty += NON_ADJACENT_TERRITORY_PENALTY_MIN;
  }

  if (args.candidateTerritoryRatio > FAR_FOREIGN_TERRITORY_DISTANCE_RATIO) {
    penalty += FAR_FOREIGN_TERRITORY_DISTANCE_PENALTY_MIN;
  } else if (args.candidateTerritoryRatio > FOREIGN_TERRITORY_DISTANCE_RATIO) {
    penalty += FOREIGN_TERRITORY_DISTANCE_PENALTY_MIN;
  }

  return penalty;
}

export function buildVehicleTaskPenalties(args: {
  input: RoutingProblemInput;
  driverIdToVehicleIndex: Map<DriverId, number>;
}): number[][] | undefined {
  const { input, driverIdToVehicleIndex } = args;
  const assignment = input.metadata.dailyTerritoryAssignment;
  if (!assignment?.routingPenaltiesEnabled || assignment.territories.length === 0) {
    return undefined;
  }

  const penaltyConfig = assignment.penaltyConfig ?? TERRITORY_ALGO_CONFIG;
  const vehicleCount = input.drivers.length;
  const nodeCount = input.travelMatrixMin.length;
  const penalties = Array.from({ length: vehicleCount }, () => Array(nodeCount).fill(0));
  const territoryByIndex = new Map(assignment.territories.map((territory) => [territory.territoryIndex, territory]));
  const territoryIndexByTaskId = new Map(
    assignment.taskTerritoryIndex.map((entry) => [entry.taskId, entry.territoryIndex])
  );
  const preferredDriverByTaskId = new Map(
    assignment.taskPreferredDriverId.map((entry) => [entry.taskId, entry.driverId])
  );
  const territoryByDriverId = new Map(
    assignment.territories.map((territory) => [territory.assignedDriverId, territory])
  );
  const requiredDriver = requiredDriverByTaskId(input);
  const historicalTemplate = assignment.territoryMode === "historical_template_3_drivers";

  for (const task of input.tasks) {
    const territoryIndex = territoryIndexByTaskId.get(task.taskId);
    if (territoryIndex === undefined) continue;

    const territory = territoryByIndex.get(territoryIndex);
    if (!territory) continue;

    const preferredDriverId = requiredDriver.get(task.taskId) ?? preferredDriverByTaskId.get(task.taskId);
    if (preferredDriverId === undefined) continue;

    const preferredVehicleIndex = driverIdToVehicleIndex.get(preferredDriverId);
    if (preferredVehicleIndex === undefined) continue;

    const ratio = taskTerritoryRatio({
      taskLat: task.location.lat,
      taskLng: task.location.lng,
      territory,
    });
    const penalty = resolveTerritoryMismatchPenalty(ratio, penaltyConfig);

    for (let vehicleIndex = 0; vehicleIndex < vehicleCount; vehicleIndex += 1) {
      if (vehicleIndex === preferredVehicleIndex) {
        penalties[vehicleIndex][task.nodeIndex] = 0;
        continue;
      }

      const candidateDriver = input.drivers[vehicleIndex];
      const candidateTerritory = territoryByDriverId.get(candidateDriver.id);
      const candidateTerritoryRatio = candidateTerritory
        ? taskTerritoryRatio({
            taskLat: task.location.lat,
            taskLng: task.location.lng,
            territory: candidateTerritory,
          })
        : 0;
      const foreignTerritoryPenalty = resolveForeignDriverTerritoryPenalty({
        preferredTerritoryKey: territory.territoryKey,
        candidateTerritoryKey: candidateTerritory?.territoryKey,
        candidateTerritoryRatio,
        historicalTemplate,
      });

      penalties[vehicleIndex][task.nodeIndex] = penalty + foreignTerritoryPenalty;
    }
  }

  return penalties;
}
