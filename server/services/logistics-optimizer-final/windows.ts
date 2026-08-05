import {
  isCheckinApplicableOnWorkDate,
  isCheckoutApplicableOnWorkDate,
  LOGISTICS_SERVICE_DURATION_MIN,
  parseHmToMinutes,
} from "../../../shared/logistics-scheduling-constraints";
import {
  requiresDriverBeforeCleaner,
  type LogisticsTaskKind,
} from "../../../shared/logistics-task-kind";
import type { PriorityWindows } from "../optimizer/priorityWindows";
import type {
  HardConstraintSpec,
  Minutes,
  TaskHardWindow,
  TaskSoftWindow,
} from "./input-contract";
import {
  resolveDriverBringsBagLatestStartMin,
  resolveEarliestServiceStartMin,
  type RuleTrace,
} from "./business-rules";
import { resolveEoEarlyDecision } from "./priority-route-compatibility";

export const DRIVER_BRINGS_BAG_TOLERANCE_REASON =
  "DRIVER_BRINGS_BAG_BEFORE_CLEANER_WITH_2_3_TOLERANCE" as const;

export interface BuildTaskWindowInput {
  taskId: number;
  priority: "EO" | "HP" | "LP" | null;
  logisticsTaskKind: LogisticsTaskKind | null;
  workDate: string;
  cleaningTime: number | null;
  checkoutDate: string | null;
  checkoutTime: string | null;
  checkinDate: string | null;
  checkinTime: string | null;
  cleanerStartTime: string | null;
  cleanerTaskStartTime: string | null;
  priorityWindows: PriorityWindows | null;
  /**
   * Fallback upper bound (minutes from midnight) used only when nothing else
   * (check-in, cleaner tolerance) constrains how late the task can end.
   * There is no implicit "end of day": the caller must derive this from the
   * actual work windows of the drivers available that day (e.g. the latest
   * configured driver end time), so a task is never capped tighter than what
   * every selected driver could actually work.
   */
  dayEndMin: Minutes;
}

export interface BuiltTaskWindow {
  hardWindow: TaskHardWindow;
  softWindows: TaskSoftWindow[];
  hardConstraints: HardConstraintSpec[];
  ruleTrace: RuleTrace[];
  sourceTimes: {
    customerCheckoutMin: Minutes | null;
    cleanerTaskStartMin: Minutes | null;
    customerCheckinMin: Minutes | null;
  };
}

export { resolveDriverBringsBagLatestStartMin } from "./business-rules";

function parseTime(value: unknown, fallback: Minutes | null = null): Minutes | null {
  return parseHmToMinutes(value, fallback);
}

function getCleanerTaskStartTime(input: BuildTaskWindowInput): string | null {
  if (!requiresDriverBeforeCleaner(input.logisticsTaskKind)) return null;
  return input.cleanerTaskStartTime ?? input.cleanerStartTime;
}

function addPriorityWindow(
  input: BuildTaskWindowInput,
  softWindows: TaskSoftWindow[],
  ruleTrace: RuleTrace[],
  context: {
    customerCheckinMin: Minutes | null;
    cleanerTaskStartMin: Minutes | null;
    latestStartMin: Minutes;
  }
): void {
  if (!input.priority || !input.priorityWindows) return;

  const window = input.priorityWindows[input.priority];
  if (!window) return;

  if (input.priority === "HP" || input.priority === "LP") {
    return;
  }

  if (input.priority === "EO" && window.endMin !== null) {
    const decision = resolveEoEarlyDecision({
      priority: input.priority,
      logisticsTaskKind: input.logisticsTaskKind,
      customerCheckinMin: context.customerCheckinMin,
      cleanerTaskStartMin: context.cleanerTaskStartMin,
      latestStartMin: context.latestStartMin,
    });
    if (!decision) return;

    if (decision.mode === "flexible") {
      ruleTrace.push({
        code: "EO_EARLY_FLEXIBLE_SUPPRESSED",
        value: {
          mode: decision.mode,
          reasons: decision.reasons,
        },
      });
      return;
    }

    softWindows.push({
      type: "preferred_start",
      startMin: window.startMin,
      endMin: window.endMin,
      penaltyPerMin: decision.penaltyPerMin,
      reason:
        decision.mode === "urgent"
          ? "EO_EARLY_URGENT_SOFT_PREFERENCE"
          : "EO_EARLY_IF_ROUTE_COMPATIBLE_SOFT_PREFERENCE",
    });
    ruleTrace.push({
      code: decision.mode === "urgent" ? "EO_EARLY_URGENT" : "EO_EARLY_ROUTE_COMPATIBLE",
      value: {
        mode: decision.mode,
        penaltyPerMin: decision.penaltyPerMin,
        reasons: decision.reasons,
      },
    });
  }
}

export function buildTaskWindow(input: BuildTaskWindowInput): BuiltTaskWindow {
  const earliestStartCandidates: Minutes[] = [0];
  const latestStartCandidates: Minutes[] = [input.dayEndMin - LOGISTICS_SERVICE_DURATION_MIN];
  const latestEndCandidates: Minutes[] = [input.dayEndMin];
  const reasons: string[] = [];
  const softWindows: TaskSoftWindow[] = [];
  const hardConstraints: HardConstraintSpec[] = [];
  const ruleTrace: RuleTrace[] = [];
  let customerCheckoutMin: Minutes | null = null;
  let cleanerTaskStartMin: Minutes | null = null;
  let customerCheckinMin: Minutes | null = null;

  if (isCheckoutApplicableOnWorkDate(input.checkoutTime, input.checkoutDate, input.workDate)) {
    const checkoutMin = parseTime(input.checkoutTime, null);
    if (checkoutMin !== null) {
      customerCheckoutMin = checkoutMin;
    }
  }

  // Solver-facing rule: logistics service cannot start before customer checkout.
  // Pre-checkout waiting is intentionally not modeled anymore.
  const earliestStartRule = resolveEarliestServiceStartMin({
    customerCheckoutMin,
    priority: input.priority,
    priorityWindows: input.priorityWindows,
  });
  earliestStartCandidates.push(earliestStartRule.value);
  reasons.push(...earliestStartRule.trace.map((trace) => trace.code));
  ruleTrace.push(...earliestStartRule.trace);

  if (isCheckinApplicableOnWorkDate(input.checkinDate, input.workDate) && input.checkinTime) {
    const checkinMin = parseTime(input.checkinTime, null);
    if (checkinMin !== null) {
      customerCheckinMin = checkinMin;
      latestEndCandidates.push(checkinMin);
      latestStartCandidates.push(checkinMin - LOGISTICS_SERVICE_DURATION_MIN);
      reasons.push("CHECKIN_DEADLINE");
      ruleTrace.push({
        code: "CUSTOMER_CHECKIN_DEADLINE",
        value: checkinMin,
      });
    }
  }

  const cleanerTaskStartTime = getCleanerTaskStartTime(input);
  if (cleanerTaskStartTime) {
    cleanerTaskStartMin = parseTime(cleanerTaskStartTime, null);
    if (cleanerTaskStartMin !== null) {
      const cleaningTimeMin = Number.isFinite(Number(input.cleaningTime))
        ? Number(input.cleaningTime)
        : null;
      const latestAllowedStart = resolveDriverBringsBagLatestStartMin({
        cleanerTaskStartMin,
        cleaningTimeMin,
      });
      latestStartCandidates.push(latestAllowedStart.value);
      latestEndCandidates.push(latestAllowedStart.value + LOGISTICS_SERVICE_DURATION_MIN);
      reasons.push(...latestAllowedStart.trace.map((trace) => trace.code));
      ruleTrace.push(...latestAllowedStart.trace);
    }
  }

  const earliestStartMin = Math.max(...earliestStartCandidates);
  const latestStartMin = Math.min(...latestStartCandidates);

  addPriorityWindow(input, softWindows, ruleTrace, {
    customerCheckinMin,
    cleanerTaskStartMin,
    latestStartMin,
  });
  const latestEndMin = Math.min(...latestEndCandidates);
  const hardWindow: TaskHardWindow = {
    earliestStartMin,
    latestStartMin,
    latestEndMin,
    reasons,
  };

  hardConstraints.unshift({
    type: "TASK_TIME_WINDOW",
    taskId: input.taskId,
    earliestStartMin,
    latestStartMin,
    latestEndMin,
    sourceRules: reasons,
  });

  hardConstraints.push({
    type: "TASK_REQUIRED",
    taskId: input.taskId,
  });

  return {
    hardWindow,
    softWindows,
    hardConstraints,
    ruleTrace,
    sourceTimes: {
      customerCheckoutMin,
      cleanerTaskStartMin,
      customerCheckinMin,
    },
  };
}
