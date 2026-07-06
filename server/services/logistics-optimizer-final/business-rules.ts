import type { Priority, PriorityWindows } from "../optimizer/priorityWindows";
import type { Minutes } from "./input-contract";
import { LOGISTICS_DEFAULT_BAG_DELIVERY_TOLERANCE_MIN } from "./constants";

export type RuleCode =
  | "CUSTOMER_CHECKOUT_MIGRATED"
  | "EO_NO_HARD_LOWER_BOUND"
  | "HP_CONFIGURED_START"
  | "LP_CONFIGURED_START"
  | "PRIORITY_WINDOWS_UNAVAILABLE"
  | "DRIVER_BRINGS_BAG_BEFORE_CLEANER_WITH_2_3_TOLERANCE"
  | "DRIVER_BRINGS_BAG_DEFAULT_TOLERANCE"
  | "CLEANER_HAS_BAG_FLEXIBLE_PICKUP"
  | "DRIVER_BRINGS_BAG_REQUIRED"
  | "NO_CLEANER_CONTEXT"
  | "MANUAL_LOGISTICS_TASK_KIND"
  | "CUSTOMER_CHECKIN_DEADLINE"
  | "EO_EARLY_URGENT"
  | "EO_EARLY_ROUTE_COMPATIBLE"
  | "EO_EARLY_FLEXIBLE_SUPPRESSED";

export interface RuleTrace {
  code: RuleCode;
  value?: unknown;
  message?: string;
}

export interface RuleResult<T> {
  value: T;
  trace: RuleTrace[];
}

export function resolveEarliestServiceStartMin(params: {
  customerCheckoutMin: Minutes | null;
  priority: Priority | null;
  priorityWindows: PriorityWindows | null;
}): RuleResult<Minutes> {
  if (params.customerCheckoutMin !== null) {
    return {
      value: params.customerCheckoutMin,
      trace: [
        {
          code: "CUSTOMER_CHECKOUT_MIGRATED",
          value: params.customerCheckoutMin,
        },
      ],
    };
  }

  if (params.priority === "EO") {
    return {
      value: 0,
      trace: [
        {
          code: "EO_NO_HARD_LOWER_BOUND",
          value: 0,
        },
      ],
    };
  }

  if ((params.priority === "HP" || params.priority === "LP") && !params.priorityWindows) {
    return {
      value: 0,
      trace: [
        {
          code: "PRIORITY_WINDOWS_UNAVAILABLE",
          value: {
            priority: params.priority,
            fallbackStartMin: 0,
          },
        },
      ],
    };
  }

  if ((params.priority === "HP" || params.priority === "LP") && params.priorityWindows) {
    const configuredStart = params.priorityWindows[params.priority].startMin;
    return {
      value: configuredStart,
      trace: [
        {
          code: `${params.priority}_CONFIGURED_START`,
          value: configuredStart,
        },
      ],
    };
  }

  return {
    value: 0,
    trace: [],
  };
}

export function resolveDriverBringsBagLatestStartMin(params: {
  cleanerTaskStartMin: Minutes;
  cleaningTimeMin: Minutes | null;
}): RuleResult<Minutes> {
  const validCleaningTime =
    params.cleaningTimeMin !== null && Number.isFinite(params.cleaningTimeMin)
      ? params.cleaningTimeMin
      : null;
  const hasValidCleaningTime =
    validCleaningTime !== null && validCleaningTime > 0;

  const toleranceMin = hasValidCleaningTime
    ? Math.ceil(validCleaningTime * 2 / 3)
    : LOGISTICS_DEFAULT_BAG_DELIVERY_TOLERANCE_MIN;
  const latestStartMin = params.cleanerTaskStartMin + toleranceMin;

  return {
    value: latestStartMin,
    trace: [
      {
        code: hasValidCleaningTime
          ? "DRIVER_BRINGS_BAG_BEFORE_CLEANER_WITH_2_3_TOLERANCE"
          : "DRIVER_BRINGS_BAG_DEFAULT_TOLERANCE",
        value: {
          cleanerTaskStartMin: params.cleanerTaskStartMin,
          cleaningTimeMin: params.cleaningTimeMin,
          toleranceMin,
          latestStartMin,
        },
      },
    ],
  };
}
