/**
 * Centralised travel-quality policy for Phase 4 recovery when an existing
 * timeline is present (both merge mode and wave assignments).
 *
 * Semantica unica: 15 = ideale, 25 = fallback/max leg (allineato a Phase 1 fallbackSeedMaxMin),
 * 30 = hard cap. Phase 1 usa nearbySeedMaxMin=15 e fallbackSeedMaxMin=25.
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
  fallbackNearbyMin: 25,
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
