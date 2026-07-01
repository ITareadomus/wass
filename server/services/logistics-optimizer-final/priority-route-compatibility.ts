import { requiresDriverBeforeCleaner, type LogisticsTaskKind } from "../../../shared/logistics-task-kind";
import type { Minutes } from "./input-contract";

export type EoEarlyMode = "urgent" | "route_compatible" | "flexible";

export interface EoEarlyDecision {
  mode: EoEarlyMode;
  penaltyPerMin: number;
  reasons: string[];
}

export interface ResolveEoEarlyDecisionInput {
  priority: "EO" | "HP" | "LP" | null;
  logisticsTaskKind: LogisticsTaskKind | null;
  customerCheckinMin: Minutes | null;
  cleanerTaskStartMin: Minutes | null;
}

export function resolveEoEarlyDecision(input: ResolveEoEarlyDecisionInput): EoEarlyDecision | null {
  if (input.priority !== "EO") return null;

  const reasons: string[] = [];
  if (input.customerCheckinMin !== null) {
    reasons.push("EO_HAS_CHECKIN_DEADLINE");
  }
  if (requiresDriverBeforeCleaner(input.logisticsTaskKind) && input.cleanerTaskStartMin !== null) {
    reasons.push("EO_DRIVER_BEFORE_CLEANER_REQUIRED");
  }
  if (reasons.length > 0) {
    return { mode: "urgent", penaltyPerMin: 1, reasons };
  }

  if (input.logisticsTaskKind === "pick-up") {
    return {
      mode: "flexible",
      penaltyPerMin: 0,
      reasons: ["EO_PICKUP_NO_TIGHT_CHECKIN", "EO_EARLY_CAN_CREATE_ROUTE_ZIGZAG"],
    };
  }

  return {
    mode: "route_compatible",
    penaltyPerMin: 1,
    reasons: ["EO_EARLY_ROUTE_COMPATIBILITY_UNKNOWN"],
  };
}
