import type { BagHandling } from "./input-contract";
import type { RuleResult } from "./business-rules";

export interface ComputeBagHandlingInput {
  cleanerId?: number | null;
  sequence?: number | null;
  premium?: boolean | null;
  paxIn?: number | null;
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function isCleanerHasBag(params: {
  cleanerSequence: number | null;
  isPremium: boolean;
  paxIn: number | null;
}): boolean {
  return (
    params.cleanerSequence === 1 &&
    (!params.isPremium || (params.paxIn !== null && params.paxIn < 4))
  );
}

export function computeBagHandling(input: ComputeBagHandlingInput): BagHandling {
  const cleanerId = toFiniteNumber(input.cleanerId);
  const sequence = toFiniteNumber(input.sequence);
  const paxIn = toFiniteNumber(input.paxIn);
  const isPremium = input.premium === true;

  return resolveBagHandlingModeWithTrace({
    cleanerId,
    cleanerSequence: sequence,
    isPremium,
    paxIn,
  }).value;
}

export function resolveBagHandlingModeWithTrace(params: {
  cleanerId: number | null;
  cleanerSequence: number | null;
  isPremium: boolean;
  paxIn: number | null;
}): RuleResult<BagHandling> {
  if (params.cleanerId === null || params.cleanerSequence === null) {
    return {
      value: "NO_CLEANER_CONTEXT",
      trace: [
        {
          code: "NO_CLEANER_CONTEXT",
          value: {
            cleanerId: params.cleanerId,
            cleanerSequence: params.cleanerSequence,
          },
        },
      ],
    };
  }

  const cleanerHasBag = isCleanerHasBag({
    cleanerSequence: params.cleanerSequence,
    isPremium: params.isPremium,
    paxIn: params.paxIn,
  });

  if (cleanerHasBag) {
    return {
      value: "CLEANER_HAS_BAG",
      trace: [
        {
          code: "CLEANER_HAS_BAG_FLEXIBLE_PICKUP",
          value: {
            cleanerSequence: params.cleanerSequence,
            isPremium: params.isPremium,
            paxIn: params.paxIn,
          },
        },
      ],
    };
  }

  return {
    value: "DRIVER_BRINGS_BAG",
    trace: [
      {
        code: "DRIVER_BRINGS_BAG_REQUIRED",
        value: {
          cleanerSequence: params.cleanerSequence,
          isPremium: params.isPremium,
          paxIn: params.paxIn,
        },
      },
    ],
  };
}

export function requiresDriverBeforeCleaner(bagHandling: BagHandling): boolean {
  return bagHandling === "DRIVER_BRINGS_BAG";
}
