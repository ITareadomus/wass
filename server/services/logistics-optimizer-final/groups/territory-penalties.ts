import type { DriverId, RoutingProblemInput, TaskId } from "../input-contract";
import { haversineMeters } from "./geo-utils";
import { TERRITORY_ALGO_CONFIG, type TerritoryPenaltyConfig } from "./territory-config";

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
  const requiredDriver = requiredDriverByTaskId(input);

  for (const task of input.tasks) {
    const territoryIndex = territoryIndexByTaskId.get(task.taskId);
    if (territoryIndex === undefined) continue;

    const territory = territoryByIndex.get(territoryIndex);
    if (!territory) continue;

    const preferredDriverId = requiredDriver.get(task.taskId) ?? preferredDriverByTaskId.get(task.taskId);
    if (preferredDriverId === undefined) continue;

    const preferredVehicleIndex = driverIdToVehicleIndex.get(preferredDriverId);
    if (preferredVehicleIndex === undefined) continue;

    const distanceFromCentroid = haversineMeters(
      task.location.lat,
      task.location.lng,
      territory.centroid.lat,
      territory.centroid.lng
    );
    const ratio = distanceFromCentroid / Math.max(territory.penaltyRadiusMeters, 1);
    const penalty = resolveTerritoryMismatchPenalty(ratio, penaltyConfig);

    for (let vehicleIndex = 0; vehicleIndex < vehicleCount; vehicleIndex += 1) {
      penalties[vehicleIndex][task.nodeIndex] =
        vehicleIndex === preferredVehicleIndex ? 0 : penalty;
    }
  }

  return penalties;
}
