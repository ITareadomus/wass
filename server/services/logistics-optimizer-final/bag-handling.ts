import {
  resolveAutoLogisticsTaskKind,
  requiresDriverBeforeCleaner,
  type LogisticsTaskKind,
} from "../../../shared/logistics-task-kind";
import type { RuleResult } from "./business-rules";

export interface ComputeLogisticsTaskKindInput {
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

export function computeLogisticsTaskKind(
  input: ComputeLogisticsTaskKindInput
): Exclude<LogisticsTaskKind, "delivery"> | null {
  return resolveLogisticsTaskKindModeWithTrace({
    cleanerId: toFiniteNumber(input.cleanerId),
    cleanerSequence: toFiniteNumber(input.sequence),
    isPremium: input.premium === true,
    paxIn: toFiniteNumber(input.paxIn),
  }).value;
}

export function resolveLogisticsTaskKindModeWithTrace(params: {
  cleanerId: number | null;
  cleanerSequence: number | null;
  isPremium: boolean;
  paxIn: number | null;
}): RuleResult<Exclude<LogisticsTaskKind, "delivery"> | null> {
  const autoKind = resolveAutoLogisticsTaskKind({
    cleanerId: params.cleanerId,
    cleanerSequence: params.cleanerSequence,
    premium: params.isPremium,
    paxIn: params.paxIn,
  });

  if (autoKind === null) {
    return {
      value: null,
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

  if (autoKind === "pick-up") {
    return {
      value: "pick-up",
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
    value: "delivery/pick-up",
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

/** @deprecated Use `computeLogisticsTaskKind`. */
export const computeBagHandling = computeLogisticsTaskKind;

/** @deprecated Use `resolveLogisticsTaskKindModeWithTrace`. */
export const resolveBagHandlingModeWithTrace = resolveLogisticsTaskKindModeWithTrace;

/** @deprecated Use `requiresDriverBeforeCleaner` from shared/logistics-task-kind. */
export { requiresDriverBeforeCleaner };
