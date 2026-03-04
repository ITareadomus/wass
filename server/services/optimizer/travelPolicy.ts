/**
 * Centralised travel-quality policy for Phase 4 recovery when an existing
 * timeline is present (both merge mode and wave assignments).
 *
 * The thresholds mirror Phase 1 grouping (15 → 25 min) so that tasks
 * inserted during recovery obey the same geographic constraints
 * as the normal optimizer pipeline.
 *
 * When `travelPolicy` is NOT provided (fresh optimizer, no timeline), Phase 4
 * falls back to its legacy deltaTravel / getRelaxConstraints checks.
 */

export interface TravelPolicy {
  idealNearbyMin: number;
  fallbackNearbyMin: number;
  maxLegMin: number;
  hardCapMin: number;
}

export const DEFAULT_TRAVEL_POLICY: TravelPolicy = {
  idealNearbyMin: 15,
  fallbackNearbyMin: 20,
  maxLegMin: 25,
  hardCapMin: 30,
};

export interface WaveLevelConstraints {
  maxNewLegLimit: number;
  allowLateness: boolean;
}

export function getWaveLevelConstraints(
  level: number,
  policy: TravelPolicy
): WaveLevelConstraints {
  switch (level) {
    case 0:
      return { maxNewLegLimit: policy.idealNearbyMin, allowLateness: false };
    case 1:
      return { maxNewLegLimit: policy.fallbackNearbyMin, allowLateness: true };
    case 2:
      return { maxNewLegLimit: policy.maxLegMin, allowLateness: true };
    default:
      return { maxNewLegLimit: policy.hardCapMin, allowLateness: true };
  }
}
