import { BarChart3 } from "lucide-react";
import type { TaskType as Task } from "@shared/schema";
import { resolveLogisticsTaskKind } from "@shared/logistics-task-kind";
import {
  LOGISTICS_PICKUP_BADGE_SKY_BG,
  logisticsKindBadgeClass,
} from "@/lib/logistics-task-kind-ui";
import { isTaskLocked } from "@/lib/taskValidation";
import {
  getHousekeepingTypeTier,
  isEquivalentStraordinariaTask,
  isNonWassInterventionTask,
} from "@/lib/housekeeping-intervention-type";
import { cn } from "@/lib/utils";

export interface AssignmentTaskStatistics {
  total: number;
  locked: number;
  unassigned: number;
  standard?: number;
  premium?: number;
  straordinarie?: number;
  altro?: number;
  puliziaUfficio?: number;
  earlyOut?: number;
  highPriority?: number;
  lowPriority?: number;
  pickUp?: number;
  deliveryPickUp?: number;
  delivery?: number;
}
export type AssignmentStatisticsVariant = "housekeeping" | "office" | "logistics";

type StatTone =
  | "blue"
  | "gray"
  | "grayLight"
  | "unassigned"
  | "green"
  | "yellow"
  | "red"
  | "sky"
  | "orange"
  | "lime"
  | "purple"
  | "deliveryPickUp";

interface StatItem {
  label: string;
  value: number;
  tone: StatTone;
  testId?: string;
  valueNote?: string;
}

const STAT_TONE_CLASS: Record<
  Exclude<StatTone, "deliveryPickUp">,
  { box: string; label: string; value: string }
> = {
  blue: {
    box: "bg-blue-100 dark:bg-blue-950/50 border-blue-300 dark:border-blue-700",
    label: "text-blue-700 dark:text-blue-300",
    value: "text-blue-800 dark:text-blue-200",
  },
  gray: {
    box: "bg-gray-100 dark:bg-gray-950/50 border-gray-300 dark:border-gray-700",
    label: "text-gray-700 dark:text-gray-300",
    value: "text-gray-800 dark:text-gray-200",
  },
  grayLight: {
    box: "bg-gray-50 dark:bg-gray-950/30 border-gray-200 dark:border-gray-800",
    label: "text-gray-600 dark:text-gray-400",
    value: "text-gray-700 dark:text-gray-300",
  },
  unassigned: {
    box: "bg-gray-300 dark:bg-gray-800/90 border-gray-500 dark:border-gray-600",
    label: "text-gray-900 dark:text-gray-100",
    value: "text-gray-950 dark:text-white",
  },
  green: {
    box: "bg-green-100 dark:bg-green-950/50 border-green-300 dark:border-green-700",
    label: "text-green-700 dark:text-green-300",
    value: "text-green-800 dark:text-green-200",
  },
  yellow: {
    box: "bg-yellow-100 dark:bg-yellow-950/50 border-yellow-300 dark:border-yellow-700",
    label: "text-yellow-700 dark:text-yellow-300",
    value: "text-yellow-800 dark:text-yellow-200",
  },
  red: {
    box: "bg-red-100 dark:bg-red-950/50 border-red-300 dark:border-red-700",
    label: "text-red-700 dark:text-red-300",
    value: "text-red-800 dark:text-red-200",
  },
  sky: {
    box: "bg-sky-100 dark:bg-sky-950/50 border-sky-300 dark:border-sky-700",
    label: "text-sky-700 dark:text-sky-300",
    value: "text-sky-800 dark:text-sky-200",
  },
  orange: {
    box: "bg-orange-100 dark:bg-orange-950/50 border-orange-300 dark:border-orange-700",
    label: "text-orange-700 dark:text-orange-300",
    value: "text-orange-800 dark:text-orange-200",
  },
  lime: {
    box: "bg-lime-100 dark:bg-lime-950/50 border-lime-300 dark:border-lime-700",
    label: "text-lime-700 dark:text-lime-300",
    value: "text-lime-800 dark:text-lime-200",
  },
  purple: {
    box: "bg-purple-100 dark:bg-purple-950/50 border-purple-300 dark:border-purple-700",
    label: "text-purple-700 dark:text-purple-300",
    value: "text-purple-800 dark:text-purple-200",
  },
};

export function computeAssignmentTaskStatisticsFromTasks(
  tasks: Task[],
  variant: AssignmentStatisticsVariant,
  operationNames?: Record<number, string>
): AssignmentTaskStatistics {
  const unlockedTasks = tasks.filter((task) => !isTaskLocked(task));
  const lockedCount = tasks.length - unlockedTasks.length;
  const unassignedTasks = tasks.filter(
    (task) => !(task as { assignedCleaner?: unknown }).assignedCleaner && !isTaskLocked(task)
  );

  let standard = 0;
  let premium = 0;
  let straordinarie = 0;
  let altro = 0;

  for (const task of unlockedTasks) {
    const tier = getHousekeepingTypeTier(task, operationNames);
    if (tier === "straordinaria") straordinarie += 1;
    else if (tier === "premium") premium += 1;
    else if (tier === "altro") altro += 1;
    else standard += 1;
  }

  let earlyOut = 0;
  let highPriority = 0;
  let lowPriority = 0;
  for (const task of unlockedTasks) {
    const priority = String(task.priority || "").toLowerCase();
    if (priority === "early-out") earlyOut += 1;
    else if (priority === "high") highPriority += 1;
    else lowPriority += 1;
  }

  const base: AssignmentTaskStatistics = {
    total: unlockedTasks.length,
    locked: lockedCount,
    unassigned: unassignedTasks.length,
    standard,
    premium,
    straordinarie,
    altro,
    earlyOut,
    highPriority,
    lowPriority,
  };

  if (variant === "office") {
    return {
      ...base,
      puliziaUfficio: unlockedTasks.filter((task) =>
        isNonWassInterventionTask(task, operationNames)
      ).length,
    };
  }

  if (variant === "logistics") {
    let pickUp = 0;
    let deliveryPickUp = 0;
    let delivery = 0;
    let logisticsAltro = 0;

    for (const task of unlockedTasks) {
      const taskAny = task as Record<string, unknown>;
      const kind = resolveLogisticsTaskKind({
        logisticsTaskKind:
          (taskAny.logistics_task_kind as string | null | undefined) ?? null,
        logisticsTaskKindSource:
          (taskAny.logistics_task_kind_source as string | null | undefined) ?? null,
        cleanerId:
          (taskAny.cleaner_id as number | null | undefined) ??
          ((task as { assignedCleaner?: number | null }).assignedCleaner ?? null),
        cleanerSequence:
          (taskAny.cleaner_sequence as number | null | undefined) ??
          (taskAny.sequence as number | null | undefined) ??
          null,
        premium: task.premium,
        paxIn: (taskAny.pax_in as number | null | undefined) ?? null,
      });

      if (kind === "pick-up") pickUp += 1;
      else if (kind === "delivery/pick-up") deliveryPickUp += 1;
      else if (kind === "delivery") delivery += 1;
      else logisticsAltro += 1;
    }

    return {
      total: unlockedTasks.length,
      locked: lockedCount,
      unassigned: unassignedTasks.length,
      pickUp,
      deliveryPickUp,
      delivery,
      altro: logisticsAltro,
    };
  }

  return base;
}

function buildAssignmentStatItems(
  variant: AssignmentStatisticsVariant,
  stats: AssignmentTaskStatistics
): StatItem[] {
  const totalItem: StatItem = {
    label: "Totale",
    value: stats.total,
    tone: "blue",
    testId: "stats-total",
    valueNote: `/ ${stats.locked} bloccati`,
  };

  const common: StatItem[] = [
    totalItem,
    {
      label: "Non Assegnate",
      value: stats.unassigned,
      tone: "unassigned",
      testId: "stats-unassigned",
    },
  ];

  const altroItem: StatItem = {
    label: "Altro",
    value: stats.altro ?? 0,
    tone: "grayLight",
    testId: "stats-altro",
  };

  if (variant === "office") {
    return [
      ...common,
      {
        label: "Pulizia Ufficio",
        value: stats.puliziaUfficio ?? 0,
        tone: "sky",
        testId: "stats-pulizia-ufficio",
      },
      {
        label: "Pulizia Ufficio Straordinaria",
        value: stats.straordinarie ?? 0,
        tone: "red",
        testId: "stats-pulizia-ufficio-straordinaria",
      },
    ];
  }

  if (variant === "logistics") {
    return [
      totalItem,
      {
        label: "Non Assegnati",
        value: stats.unassigned,
        tone: "unassigned",
        testId: "stats-unassigned",
      },
      {
        label: "Pick-up",
        value: stats.pickUp ?? 0,
        tone: "sky",
        testId: "stats-pick-up",
      },
      {
        label: "D&P",
        value: stats.deliveryPickUp ?? 0,
        tone: "deliveryPickUp",
        testId: "stats-delivery-pick-up",
      },
      {
        label: "Delivery",
        value: stats.delivery ?? 0,
        tone: "purple",
        testId: "stats-delivery",
      },
      altroItem,
    ];
  }

  return [
    ...common,
    {
      label: "Standard",
      value: stats.standard ?? 0,
      tone: "green",
      testId: "stats-standard",
    },
    {
      label: "Premium",
      value: stats.premium ?? 0,
      tone: "yellow",
      testId: "stats-premium",
    },
    {
      label: "Straordinarie",
      value: stats.straordinarie ?? 0,
      tone: "red",
      testId: "stats-straordinarie",
    },
    altroItem,
  ];
}

function StatValue({ item, tone }: { item: StatItem; tone: { label: string; value: string } }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className={cn("text-2xl font-bold", tone.value)} data-testid={item.testId}>
        {item.value}
      </span>
      {item.valueNote ? (
        <span className={cn("text-xs font-medium", tone.label)}>{item.valueNote}</span>
      ) : null}
    </div>
  );
}

function StatCard({ item }: { item: StatItem }) {
  if (item.tone === "deliveryPickUp") {
    return (
      <div
        className={cn(
          "relative overflow-hidden rounded-lg border-2 p-3",
          LOGISTICS_PICKUP_BADGE_SKY_BG,
          logisticsKindBadgeClass("delivery/pick-up")
        )}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-purple-100 dark:bg-purple-950 [clip-path:polygon(0_0,100%_0,0_100%)]"
        />
        <div className="relative z-[1]">
          <div className="mb-1 text-xs font-medium">{item.label}</div>
          <div className="text-2xl font-bold" data-testid={item.testId}>
            {item.value}
          </div>
        </div>
      </div>
    );
  }

  const tone = STAT_TONE_CLASS[item.tone];
  return (
    <div className={cn("rounded-lg border-2 p-3", tone.box)}>
      <div className={cn("mb-1 text-xs font-medium", tone.label)}>{item.label}</div>
      <StatValue item={item} tone={tone} />
    </div>
  );
}

interface AssignmentTaskStatisticsPanelProps {
  variant: AssignmentStatisticsVariant;
  stats: AssignmentTaskStatistics;
}

export default function AssignmentTaskStatisticsPanel({
  variant,
  stats,
}: AssignmentTaskStatisticsPanelProps) {
  const items = buildAssignmentStatItems(variant, stats);

  return (
    <div className="flex flex-col">
      <div className="border-b border-border px-4 py-3">
        <h3 className="flex items-center font-semibold text-foreground">
          <BarChart3 className="mr-2 h-5 w-5 text-custom-blue" />
          Statistiche Task
        </h3>
      </div>
      <div className="p-4">
        <div className="grid grid-cols-2 gap-3 content-start">
          {items.map((item) => (
            <StatCard key={item.testId ?? item.label} item={item} />
          ))}
        </div>
      </div>
    </div>
  );
}

// Re-export for callers that still filter manually
export { isEquivalentStraordinariaTask, isNonWassInterventionTask };
