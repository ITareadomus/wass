import type { DriverId, DriverNode, TaskId } from "../input-contract";
import { TERRITORY_ALGO_CONFIG } from "./territory-config";
import type { HistoricalTerritoryKey } from "./historical-territory-profiles";

export interface TerritoryForDriverMatching {
  territoryIndex: number;
  taskIds: TaskId[];
  hubNodeIndex: number;
  territoryKey?: HistoricalTerritoryKey;
  preferredHistoricalDriverCode?: string;
}

export interface TerritoryDriverAssignment {
  territoryIndex: number;
  assignedDriverId: DriverId;
  cost: number;
}

function travelFromDepotToHub(travelMatrixMin: number[][], hubNodeIndex: number): number {
  const travel = travelMatrixMin[0]?.[hubNodeIndex];
  return Number.isFinite(travel) ? travel : 0;
}

function historicalDriverMismatch(
  driver: DriverNode,
  preferredHistoricalDriverCode?: string
): number {
  if (!preferredHistoricalDriverCode || !driver.operationalCode) {
    return 0;
  }
  return driver.operationalCode.toUpperCase() === preferredHistoricalDriverCode.toUpperCase() ? 0 : 1;
}

function territoryDriverCost(args: {
  territory: TerritoryForDriverMatching;
  driver: DriverNode;
  travelMatrixMin: number[][];
  requiredDriverByTaskId: Map<TaskId, DriverId>;
  useHistoricalDriverBias: boolean;
}): number {
  const { territory, driver, travelMatrixMin, requiredDriverByTaskId, useHistoricalDriverBias } = args;
  const requiredMismatchCount = territory.taskIds.reduce((count, taskId) => {
    const requiredDriverId = requiredDriverByTaskId.get(taskId);
    return requiredDriverId !== undefined && requiredDriverId !== driver.id ? count + 1 : count;
  }, 0);

  const historicalMismatch = useHistoricalDriverBias
    ? historicalDriverMismatch(driver, territory.preferredHistoricalDriverCode)
    : 0;

  return (
    travelFromDepotToHub(travelMatrixMin, territory.hubNodeIndex) +
    requiredMismatchCount * TERRITORY_ALGO_CONFIG.requiredDriverTerritoryBiasMin +
    historicalMismatch * TERRITORY_ALGO_CONFIG.historicalDriverTerritoryBiasMin
  );
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += 1) {
    const current = items[index];
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const permutation of permutations(rest)) {
      result.push([current, ...permutation]);
    }
  }
  return result;
}

export function matchTerritoriesToDrivers(args: {
  territories: TerritoryForDriverMatching[];
  drivers: DriverNode[];
  travelMatrixMin: number[][];
  requiredDriverByTaskId: Map<TaskId, DriverId>;
  useHistoricalDriverBias?: boolean;
}): TerritoryDriverAssignment[] {
  const { territories, travelMatrixMin, requiredDriverByTaskId } = args;
  const useHistoricalDriverBias = args.useHistoricalDriverBias ?? false;
  const drivers = [...args.drivers].sort((left, right) => left.id - right.id);

  if (territories.length === 0 || drivers.length === 0) {
    return [];
  }

  const candidateDrivers = drivers.slice(0, territories.length);
  let bestAssignment: TerritoryDriverAssignment[] = [];
  let bestCost = Number.POSITIVE_INFINITY;

  for (const driverPermutation of permutations(candidateDrivers)) {
    const assignment = territories.map((territory, index) => {
      const driver = driverPermutation[index];
      return {
        territoryIndex: territory.territoryIndex,
        assignedDriverId: driver.id,
        cost: territoryDriverCost({
          territory,
          driver,
          travelMatrixMin,
          requiredDriverByTaskId,
          useHistoricalDriverBias,
        }),
      };
    });

    const totalCost = assignment.reduce((sum, item) => sum + item.cost, 0);
    if (totalCost < bestCost) {
      bestCost = totalCost;
      bestAssignment = assignment;
    }
  }

  return bestAssignment;
}
