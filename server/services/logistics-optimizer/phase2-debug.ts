import fs from "fs/promises";
import path from "path";

export type LogisticsPhase2ReasonCode =
  | "CHECKIN_CHECKOUT_CONSTRAINT"
  | "CLEANER_TIME_CONSTRAINT"
  | "NO_DRIVER_FEASIBLE"
  | "NO_TASK_CANDIDATES";

export interface LogisticsPhase2GroupingStatsJson {
  cleanerClusters: number;
  geographicFallbackGroups: number;
  singletonFallbackTasks: number;
  fallbackTasks: number;
  initialGroupsProcessed?: number;
  queueGroupsProcessed?: number;
  partialGroupsAssigned?: number;
  groupsSplit?: number;
  recoveredMissingTaskCount?: number;
  duplicateGroupedTaskCount?: number;
  repairInsertedTasks?: number;
}

export type GroupingStrategy =
  | "CLEANER_CLUSTER"
  | "GEOGRAPHIC_FALLBACK"
  | "SINGLETON_BAG_PRIORITY"
  | "RECOVERY_SINGLETON"
  | "REPAIR_INSERTION";

export interface GroupingReasonJson {
  strategy: GroupingStrategy;
  summary: string;
  details: Record<string, unknown>;
}

export interface GroupCreatedJson {
  groupId: string;
  origin: string;
  seedBandIndex: number;
  cleanerId: number | null;
  taskIds: number[];
  logisticCodes: number[];
  queueSortKey: {
    earliestDeadlineMin: number;
    hasDriverBringsBag: boolean;
    originPriority: number;
    sizeScore: number;
  };
  groupingReason: GroupingReasonJson;
}

export interface LogisticsAssignmentScheduleJson {
  taskId: number;
  logisticCode: number;
  startTime: string;
  endTime: string;
  travelMinutes: number;
  checkoutWaitMinutes: number;
}

export function mapAssignmentsToDebugSchedule(
  assignments: Array<{
    taskId: number;
    logisticCode: number;
    startTime: string;
    endTime: string;
    travelMinutes: number;
    checkoutWaitMinutes: number;
  }>
): LogisticsAssignmentScheduleJson[] {
  return assignments.map((item) => ({
    taskId: item.taskId,
    logisticCode: item.logisticCode,
    startTime: item.startTime,
    endTime: item.endTime,
    travelMinutes: item.travelMinutes,
    checkoutWaitMinutes: item.checkoutWaitMinutes,
  }));
}

export interface DriverAttemptJson {
  driverId: number;
  feasible: boolean;
  score?: number;
  travelMinutesDelta?: number;
  projectedClockEnd?: string;
  failure?: {
    reasonCode: LogisticsPhase2ReasonCode;
    taskId: number | null;
    details?: Record<string, unknown>;
  };
}

export interface GroupDecisionJson {
  step: number;
  groupId: string;
  origin: string;
  taskIds: number[];
  logisticCodes: number[];
  groupingReason: GroupingReasonJson;
  outcome: "FULL_ASSIGNED" | "PARTIAL_ASSIGNED" | "REPAIR_ASSIGNED" | "REJECTED";
  why: string;
  winner?: {
    driverId: number;
    score: number;
    travelMinutesDelta: number;
    projectedClockEnd: string;
    taskOrder: number[];
    schedule: LogisticsAssignmentScheduleJson[];
  };
  partial?: {
    assignedTaskIds: number[];
    remainingGroupId: string | null;
    expectedRecoverableTasks?: number;
    assignedSize?: number;
    remainingFeasibleOnSomeDriver?: boolean;
  };
  driverAttempts: DriverAttemptJson[];
  perTaskReason?: Array<{
    taskId: number;
    logisticCode: number;
    reasonCode: LogisticsPhase2ReasonCode;
  }>;
}

export interface UnassignedTaskDebugJson {
  taskId: number;
  logisticCode: number;
  reasonCode: LogisticsPhase2ReasonCode;
  sourceGroupId?: string;
  driverFailures: Array<{
    driverId: number;
    reasonCode: LogisticsPhase2ReasonCode;
    taskId: number | null;
    details?: Record<string, unknown>;
  }>;
}

export function isLogisticsOptimizerDebugEnabled(explicit?: boolean): boolean {
  if (explicit === true) return true;
  if (explicit === false) return false;
  const raw = String(process.env.LOGISTICS_OPTIMIZER_DEBUG ?? "").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no") return false;
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  // In development scrivi i JSON di default (disattiva con LOGISTICS_OPTIMIZER_DEBUG=0).
  return process.env.NODE_ENV !== "production";
}

export class LogisticsPhase2DebugCollector {
  readonly workDate: string;
  readonly runId: string;
  readonly startedAt: string;

  groupsCreated: GroupCreatedJson[] = [];
  groupDecisions: GroupDecisionJson[] = [];
  unassignedTasks: UnassignedTaskDebugJson[] = [];
  groupingStats: LogisticsPhase2GroupingStatsJson | null = null;
  summary: Record<string, number | string> = {};
  reasonCounts: Record<string, number> = {};

  constructor(workDate: string) {
    this.workDate = workDate;
    this.startedAt = new Date().toISOString();
    this.runId = this.startedAt.replace(/[:.]/g, "-");
  }

  recordGroupsCreated(
    groups: Array<{
      groupId: string;
      origin?: string;
      seedBandIndex: number;
      cleanerId?: number | null;
      tasks: Array<{ taskId: number; logisticCode: number }>;
      groupingReason: GroupingReasonJson;
      queueSortKey: GroupCreatedJson["queueSortKey"];
    }>
  ): void {
    this.groupsCreated = groups.map((group) => ({
      groupId: group.groupId,
      origin: group.origin ?? "UNKNOWN",
      seedBandIndex: group.seedBandIndex,
      cleanerId: group.cleanerId ?? null,
      taskIds: group.tasks.map((t) => t.taskId),
      logisticCodes: group.tasks.map((t) => t.logisticCode),
      queueSortKey: group.queueSortKey,
      groupingReason: group.groupingReason,
    }));
  }

  recordGroupDecision(decision: GroupDecisionJson): void {
    this.groupDecisions.push(decision);
  }

  recordUnassignedTasks(tasks: UnassignedTaskDebugJson[]): void {
    this.unassignedTasks = tasks;
  }

  setSummary(summary: Record<string, number | string>, reasonCounts?: Record<string, number>): void {
    this.summary = summary;
    if (reasonCounts) this.reasonCounts = reasonCounts;
  }

  setGroupingStats(stats: LogisticsPhase2GroupingStatsJson): void {
    this.groupingStats = stats;
  }
}

function debugRootDir(): string {
  return path.join(process.cwd(), "server", "debug", "logistics-optimizer");
}

export async function writeLogisticsPhase2DebugFiles(
  collector: LogisticsPhase2DebugCollector
): Promise<string> {
  const dir = path.join(debugRootDir(), collector.workDate, collector.runId);
  await fs.mkdir(dir, { recursive: true });

  const manifest = {
    workDate: collector.workDate,
    runId: collector.runId,
    startedAt: collector.startedAt,
    files: [
      "01-groups-created.json",
      "02-group-decisions.json",
      "03-unassigned-tasks.json",
      "04-summary.json",
      "05-final-timeline-validation.json",
    ],
  };

  await Promise.all([
    fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8"),
    fs.writeFile(
      path.join(dir, "01-groups-created.json"),
      JSON.stringify(
        {
          workDate: collector.workDate,
          runId: collector.runId,
          totalGroups: collector.groupsCreated.length,
          groupingStats: collector.groupingStats,
          groups: collector.groupsCreated,
        },
        null,
        2
      ),
      "utf8"
    ),
    fs.writeFile(
      path.join(dir, "02-group-decisions.json"),
      JSON.stringify(
        {
          workDate: collector.workDate,
          runId: collector.runId,
          decisions: collector.groupDecisions,
        },
        null,
        2
      ),
      "utf8"
    ),
    fs.writeFile(
      path.join(dir, "03-unassigned-tasks.json"),
      JSON.stringify(
        {
          workDate: collector.workDate,
          runId: collector.runId,
          total: collector.unassignedTasks.length,
          tasks: collector.unassignedTasks,
        },
        null,
        2
      ),
      "utf8"
    ),
    fs.writeFile(
      path.join(dir, "04-summary.json"),
      JSON.stringify(
        {
          workDate: collector.workDate,
          runId: collector.runId,
          ...collector.summary,
          reasonCounts: collector.reasonCounts,
        },
        null,
        2
      ),
      "utf8"
    ),
  ]);

  return dir;
}
