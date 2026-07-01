export const TERRITORY_ALGO_CONFIG = {
  territoryCountMode: "drivers" as const,
  minTasksPerTerritory: 4,
  balanceToleranceTasks: 2,
  maxIterations: 30,
  penaltyRadiusPercentile: 0.9,
  coreMismatchPenaltyMin: 90,
  normalMismatchPenaltyMin: 55,
  borderMismatchPenaltyMin: 20,
  coreRadiusRatio: 0.65,
  borderRadiusRatio: 0.9,
  requiredDriverTerritoryBiasMin: 800,
  historicalDriverTerritoryBiasMin: 1000,
};

export const HISTORICAL_TEMPLATE_PENALTY_CONFIG = {
  coreMismatchPenaltyMin: 120,
  normalMismatchPenaltyMin: 70,
  borderMismatchPenaltyMin: 20,
};

export type TerritoryMode = "historical_template_3_drivers" | "dynamic_clustering";

export type TerritoryPenaltyConfig = {
  coreMismatchPenaltyMin: number;
  normalMismatchPenaltyMin: number;
  borderMismatchPenaltyMin: number;
};

function parseEnvBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes") return true;
  if (value === "0" || value === "false" || value === "no") return false;
  return undefined;
}

export function resolveTerritoryFlags(): {
  debugTerritoriesEnabled: boolean;
  routingPenaltiesEnabled: boolean;
} {
  const debugEnv = parseEnvBool(process.env.LOGISTICS_TERRITORY_DEBUG);
  const penaltiesEnv = parseEnvBool(process.env.LOGISTICS_TERRITORY_PENALTIES);
  const routingPenaltiesEnabled = penaltiesEnv ?? true;

  return {
    debugTerritoriesEnabled: debugEnv ?? true,
    routingPenaltiesEnabled,
  };
}

export function resolveTerritoryCapacity(
  taskCount: number,
  driverCount: number
): { target: number; min: number; max: number } {
  if (driverCount <= 0) {
    return { target: taskCount, min: taskCount, max: taskCount };
  }

  const target = Math.ceil(taskCount / driverCount);
  const feasibleMin = Math.floor(taskCount / driverCount);
  const preferredMin = Math.max(
    TERRITORY_ALGO_CONFIG.minTasksPerTerritory,
    target - TERRITORY_ALGO_CONFIG.balanceToleranceTasks
  );
  const min = Math.min(preferredMin, feasibleMin);
  const max = target + TERRITORY_ALGO_CONFIG.balanceToleranceTasks;
  return { target, min: Math.min(min, taskCount), max: Math.min(max, taskCount) };
}
