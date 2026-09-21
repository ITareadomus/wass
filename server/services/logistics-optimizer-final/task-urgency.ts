import { LOGISTICS_BAG_DELIVERY_CLEANING_TIME_RATIO } from "../../../shared/logistics-scheduling-constraints";
import { requiresDriverBeforeCleaner, type LogisticsTaskKind } from "../../../shared/logistics-task-kind";
import type { Minutes, TaskNode } from "./input-contract";
import { hasTightCheckinDeadline } from "./priority-route-compatibility";

/**
 * D&P urgency is about how scarce the bag window is, not "it is a D&P".
 * A 1-hour cleaning D&P has ~72 min of bag slack (120% of cleaning) and must not
 * lose that slot to a 6-hour D&P that could be done much later.
 */
export const TASK_URGENCY_CONFIG = {
  urgentDpCleaningTimeMaxMin: 90,
  looseDpCleaningTimeMinMin: 240,
  urgentWindowSlackMaxMin: 90,
  looseWindowSlackMinMin: 180,
  looseDpDeferSlackRatio: 0.4,
  looseDpEarlyPenaltyPerMin: 4,
  defaultDayStartMin: 10 * 60,
} as const;

export type LogisticsScheduleUrgency = "urgent" | "loose" | "normal";

export interface ClassifyLogisticsTaskUrgencyInput {
  priority?: "EO" | "HP" | "LP" | null;
  logisticsTaskKind: LogisticsTaskKind | null;
  premium?: boolean;
  straordinaria?: boolean;
  cleaningTimeMin?: Minutes | null;
  earliestStartMin?: Minutes | null;
  latestStartMin?: Minutes | null;
  customerCheckinMin?: Minutes | null;
  cleanerTaskStartMin?: Minutes | null;
}

export function isUrgentDpCleaningTime(cleaningTimeMin: Minutes | null | undefined): boolean {
  return (
    cleaningTimeMin != null &&
    Number.isFinite(cleaningTimeMin) &&
    cleaningTimeMin > 0 &&
    cleaningTimeMin <= TASK_URGENCY_CONFIG.urgentDpCleaningTimeMaxMin
  );
}

export function isLooseDpCleaningTime(cleaningTimeMin: Minutes | null | undefined): boolean {
  return (
    cleaningTimeMin != null &&
    Number.isFinite(cleaningTimeMin) &&
    cleaningTimeMin >= TASK_URGENCY_CONFIG.looseDpCleaningTimeMinMin
  );
}

export function windowSlackMin(args: {
  earliestStartMin?: Minutes | null;
  latestStartMin?: Minutes | null;
}): number | null {
  if (args.earliestStartMin == null || args.latestStartMin == null) return null;
  if (!Number.isFinite(args.earliestStartMin) || !Number.isFinite(args.latestStartMin)) {
    return null;
  }
  return args.latestStartMin - args.earliestStartMin;
}

export function classifyLogisticsTaskUrgency(
  input: ClassifyLogisticsTaskUrgencyInput
): LogisticsScheduleUrgency {
  if (input.premium === true || input.straordinaria === true) return "urgent";

  if (
    hasTightCheckinDeadline({
      customerCheckinMin: input.customerCheckinMin ?? null,
      latestStartMin: input.latestStartMin ?? null,
    })
  ) {
    return "urgent";
  }

  const isDp = requiresDriverBeforeCleaner(input.logisticsTaskKind);
  if (isDp) {
    if (isUrgentDpCleaningTime(input.cleaningTimeMin)) return "urgent";
    if (isLooseDpCleaningTime(input.cleaningTimeMin)) return "loose";

    const slack = windowSlackMin({
      earliestStartMin: Math.max(
        input.earliestStartMin ?? TASK_URGENCY_CONFIG.defaultDayStartMin,
        TASK_URGENCY_CONFIG.defaultDayStartMin
      ),
      latestStartMin: input.latestStartMin,
    });
    if (slack != null && slack <= TASK_URGENCY_CONFIG.urgentWindowSlackMaxMin) {
      return "urgent";
    }
    if (slack != null && slack >= TASK_URGENCY_CONFIG.looseWindowSlackMinMin) {
      return "loose";
    }
  }

  return "normal";
}

export function classifyTaskNodeUrgency(task: TaskNode): LogisticsScheduleUrgency {
  const cleanerTaskStartMin = task.debug?.sourceTimes?.cleanerTaskStartMin ?? null;
  const inferredCleaningTime =
    cleanerTaskStartMin != null && Number.isFinite(task.hardWindow.latestStartMin)
      ? Math.round((task.hardWindow.latestStartMin - cleanerTaskStartMin) / LOGISTICS_BAG_DELIVERY_CLEANING_TIME_RATIO)
      : null;

  return classifyLogisticsTaskUrgency({
    priority: task.priority,
    logisticsTaskKind: task.logisticsTaskKind,
    premium: task.premium,
    straordinaria: task.straordinaria,
    cleaningTimeMin: inferredCleaningTime,
    earliestStartMin: task.hardWindow.earliestStartMin,
    latestStartMin: task.hardWindow.latestStartMin,
    customerCheckinMin: task.debug?.sourceTimes?.customerCheckinMin ?? null,
    cleanerTaskStartMin,
  });
}

export function resolveLooseDpPreferredStartMin(args: {
  earliestStartMin: Minutes;
  latestStartMin: Minutes;
}): Minutes {
  const slack = Math.max(0, args.latestStartMin - args.earliestStartMin);
  const deferred = Math.round(args.earliestStartMin + slack * TASK_URGENCY_CONFIG.looseDpDeferSlackRatio);
  return Math.min(args.latestStartMin, Math.max(args.earliestStartMin, deferred));
}
