import { requiresDriverBeforeCleaner, type LogisticsTaskKind } from "../../../shared/logistics-task-kind";
import type { Minutes } from "./input-contract";

export type EoEarlyMode = "urgent" | "route_compatible" | "flexible";

export interface EoEarlyDecision {
  mode: EoEarlyMode;
  penaltyPerMin: number;
  reasons: string[];
}

export const EO_EARLY_CONFIG = {
  tightCheckinLatestStartMin: 14 * 60,
  tightCheckinSlackFromDayStartMin: 180,
  defaultDayStartMin: 10 * 60,
} as const;

export interface ResolveEoEarlyDecisionInput {
  priority: "EO" | "HP" | "LP" | null;
  logisticsTaskKind: LogisticsTaskKind | null;
  customerCheckinMin: Minutes | null;
  cleanerTaskStartMin: Minutes | null;
  latestStartMin: Minutes | null;
}

export function hasTightCheckinDeadline(args: {
  customerCheckinMin: Minutes | null;
  latestStartMin: Minutes | null;
}): boolean {
  if (args.customerCheckinMin === null) return false;

  const effectiveLatestStart =
    args.latestStartMin ?? args.customerCheckinMin - 15;

  if (effectiveLatestStart <= EO_EARLY_CONFIG.tightCheckinLatestStartMin) {
    return true;
  }

  return (
    effectiveLatestStart - EO_EARLY_CONFIG.defaultDayStartMin <=
    EO_EARLY_CONFIG.tightCheckinSlackFromDayStartMin
  );
}

export function resolveEoEarlyDecision(input: ResolveEoEarlyDecisionInput): EoEarlyDecision | null {
  if (input.priority !== "EO") return null;

  const reasons: string[] = [];
  if (hasTightCheckinDeadline(input)) {
    reasons.push("EO_HAS_TIGHT_CHECKIN_DEADLINE");
  }
  if (requiresDriverBeforeCleaner(input.logisticsTaskKind) && input.cleanerTaskStartMin !== null) {
    reasons.push("EO_DRIVER_BEFORE_CLEANER_REQUIRED");
  }
  if (reasons.length > 0) {
    return { mode: "urgent", penaltyPerMin: 1, reasons };
  }

  if (input.customerCheckinMin !== null) {
    reasons.push("EO_HAS_LOOSE_CHECKIN_DEADLINE");
  }

  if (input.logisticsTaskKind === "pick-up" || input.customerCheckinMin !== null) {
    return {
      mode: "flexible",
      penaltyPerMin: 0,
      reasons: [
        ...reasons,
        input.logisticsTaskKind === "pick-up"
          ? "EO_PICKUP_NO_TIGHT_CHECKIN"
          : "EO_LOOSE_CHECKIN_NOT_URGENT",
        "EO_EARLY_CAN_CREATE_ROUTE_ZIGZAG",
      ],
    };
  }

  return {
    mode: "route_compatible",
    penaltyPerMin: 1,
    reasons: ["EO_EARLY_ROUTE_COMPATIBILITY_UNKNOWN"],
  };
}
