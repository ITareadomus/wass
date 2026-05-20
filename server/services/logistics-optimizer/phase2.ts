import { estimateCarTravelMinutes } from "../logistics-timeline-utils";
import {
  buildLogisticsScheduleForDriver,
  toLogisticsScheduleTaskInput,
} from "./logistics-driver-schedule";
import { LogisticsTaskInputWithLock } from "./phase0";
import { LogisticsPhase1Result, LogisticsSelectedDriver, LogisticsTaskCandidate } from "./phase1";
import { LOGISTICS_SERVICE_DURATION_MIN } from "../../../shared/logistics-scheduling-constraints";
import { computeBagPolicy, requiresDriverBeforeCleaner } from "./bag-rule";
import {
  GroupingReasonJson,
  LogisticsPhase2DebugCollector,
  mapAssignmentsToDebugSchedule,
  type DriverAttemptJson,
  type GroupCreatedJson,
  type GroupDecisionJson,
  type UnassignedTaskDebugJson,
} from "./phase2-debug";

const LOGISTICS_TASK_DURATION_MIN = LOGISTICS_SERVICE_DURATION_MIN;
const GROUP_MAX_TASKS = 4;
const GROUP_NEARBY_THRESHOLD_MIN = 8;
const CLEANER_CLUSTER_MAX_STEP_TRAVEL_MIN = 10;
const CLEANER_CLUSTER_MAX_RADIUS_TRAVEL_MIN = 12;
const GEO_FALLBACK_MAX_STEP_TRAVEL_MIN = GROUP_NEARBY_THRESHOLD_MIN;
const GEO_FALLBACK_MAX_RADIUS_TRAVEL_MIN = 10;

/** Magazzino / punto di partenza autisti (Via Barrili 31, Milano). */
const LOGISTICS_DEPOT_LAT = 45.434029;
const LOGISTICS_DEPOT_LNG = 9.180008;

type LogisticsPhase2ReasonCode =
  | "CHECKIN_CHECKOUT_CONSTRAINT"
  | "CLEANER_TIME_CONSTRAINT"
  | "NO_DRIVER_FEASIBLE"
  | "NO_TASK_CANDIDATES";

interface LogisticsTaskForPhase2 extends LogisticsTaskCandidate {
  checkinDate: string | null;
  checkoutDate: string | null;
  checkinTime: string | null;
  checkoutTime: string | null;
  cleanerId: number | null;
  cleanerStartTime: string | null;
  cleanerTaskStartTime: string | null;
  cleanerSequence: number | null;
  bagPolicy: ReturnType<typeof computeBagPolicy>;
  premium: boolean;
  paxIn: number | null;
}

interface LogisticsTaskSchedule {
  taskId: number;
  logisticCode: number;
  startTime: string;
  endTime: string;
  travelMinutes: number;
  /** Minuti di attesa al checkout prima di iniziare il task (0 se nessuna attesa). */
  checkoutWaitMinutes: number;
  sequence: number;
  reasonCode: LogisticsPhase2ReasonCode | null;
}

interface DriverPhase2Plan {
  driverId: number;
  driverStartTime: string;
  totalTasks: number;
  totalTravelMinutes: number;
  totalServiceMinutes: number;
  assignments: LogisticsTaskSchedule[];
}

interface SpatialGroup {
  groupId: string;
  seedBandIndex: number;
  tasks: LogisticsTaskForPhase2[];
  origin?: "CLEANER_CLUSTER" | "GEOGRAPHIC_FALLBACK" | "SINGLETON_FALLBACK";
  cleanerId?: number | null;
  groupingReason?: GroupingReasonJson;
}

interface CleanerClusterLinkMetrics {
  compatible: boolean;
  stepTravelMin: number;
  centroidTravelMin: number;
  limits: {
    maxTasksPerCluster: number;
    stepTravelMaxMin: number;
    centroidRadiusMaxMin: number;
  };
  failedRules: string[];
}

interface LogisticsPhase2GroupingStats {
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
}

interface DriverState {
  driverId: number;
  driverIndex: number;
  driverStartMin: number;
  clockMin: number;
  lastLat: number | null;
  lastLng: number | null;
  totalTravelMinutes: number;
  assignedTasks: LogisticsTaskSchedule[];
  cleanerLastSequence: Map<number, number>;
}

interface FeasibilityFailure {
  reasonCode: LogisticsPhase2ReasonCode;
  taskId: number | null;
}

interface GroupSimulationResult {
  feasible: boolean;
  assignments: LogisticsTaskSchedule[];
  projectedClockMin: number;
  projectedLastLat: number | null;
  projectedLastLng: number | null;
  projectedCleanerLastSequence: Map<number, number>;
  travelMinutesDelta: number;
  score: number;
  failure: FeasibilityFailure | null;
}

interface PartialGroupSimulationChoice {
  assignedGroup: SpatialGroup;
  remainingGroup: SpatialGroup | null;
  state: DriverState;
  simulation: GroupSimulationResult;
}

export interface LogisticsPhase2UnassignedTask {
  taskId: number;
  logisticCode: number;
  reasonCode: LogisticsPhase2ReasonCode;
}

export interface LogisticsPhase2Result {
  canRun: boolean;
  phase: 2;
  workDate: string;
  groupsProcessed: number;
  groupsAssigned: number;
  groupsUnassigned: number;
  tasksAssigned: number;
  tasksUnassigned: number;
  driverPlans: DriverPhase2Plan[];
  unassignedTasks: LogisticsPhase2UnassignedTask[];
  debugDir?: string;
  validation: {
    noTaskCandidates: boolean;
    bagPolicyExcludedCount: number;
    bagPolicyExcludedTaskIds: number[];
    reasonCounts: Record<LogisticsPhase2ReasonCode, number>;
    groupingStats?: LogisticsPhase2GroupingStats;
  };
}

function parseMinutes(value: string | null | undefined, fallback: number): number {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return fallback;
  return Math.max(0, Math.min(23 * 60 + 59, hours * 60 + minutes));
}

function toHHMM(totalMinutes: number): string {
  const bounded = Math.max(0, Math.min(23 * 60 + 59, Math.round(totalMinutes)));
  const h = Math.floor(bounded / 60);
  const m = bounded % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function normalizeYmd(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return raw.slice(0, 10);
}

function isDateCompatibleWithWorkDate(taskDate: string | null, workDate: string): boolean {
  if (!taskDate) return true;
  return normalizeYmd(taskDate) === normalizeYmd(workDate);
}

/**
 * Vincolo cleaner: solo DRIVER_BRINGS_BAG deve finire prima dell'inizio HK.
 * CLEANER_HAS_BAG / NORMAL_TASK: solo ritiro (checkout/check-in), non consegna borsone.
 */
function getCleanerViolation(task: LogisticsTaskForPhase2, taskEndMin: number): boolean {
  const cleanerReferenceTime = getCleanerDeadlineForBagDelivery(task);
  if (!cleanerReferenceTime) return false;
  const cleanerStartMin = parseMinutes(cleanerReferenceTime, 23 * 60 + 59);
  return taskEndMin >= cleanerStartMin;
}

function getCleanerDeadlineForBagDelivery(task: LogisticsTaskForPhase2): string | null {
  if (!requiresDriverBeforeCleaner(task.bagPolicy)) return null;
  return task.cleanerTaskStartTime ?? task.cleanerStartTime;
}

function buildPhase2Tasks(
  unlockedTaskData: LogisticsTaskInputWithLock[],
  taskCandidates: LogisticsTaskCandidate[]
): LogisticsTaskForPhase2[] {
  const byTaskId = new Map<number, LogisticsTaskInputWithLock>();
  unlockedTaskData.forEach((task) => byTaskId.set(task.taskId, task));

  return taskCandidates.map((candidate) => {
    const taskData = byTaskId.get(candidate.taskId);
    const bagPolicy = computeBagPolicy({
      cleanerId: taskData?.cleanerId ?? null,
      sequence: taskData?.cleanerSequence ?? null,
      premium: taskData?.premium === true,
      paxIn: taskData?.paxIn ?? null,
    });
    return {
      ...candidate,
      checkinDate: taskData?.checkinDate ?? null,
      checkoutDate: taskData?.checkoutDate ?? null,
      checkinTime: taskData?.checkinTime ?? null,
      checkoutTime: taskData?.checkoutTime ?? null,
      cleanerId: taskData?.cleanerId ?? null,
      cleanerStartTime: taskData?.cleanerStartTime ?? null,
      cleanerTaskStartTime: taskData?.cleanerTaskStartTime ?? null,
      cleanerSequence: taskData?.cleanerSequence ?? null,
      bagPolicy,
      premium: taskData?.premium === true,
      paxIn: taskData?.paxIn ?? null,
    };
  });
}

function filterTasksByBagRule(tasks: LogisticsTaskForPhase2[]): {
  included: LogisticsTaskForPhase2[];
  excludedTaskIds: number[];
} {
  // Sequence=1 tasks are always eligible; bag policy only influences ordering preference.
  return { included: tasks, excludedTaskIds: [] };
}

function getTaskDeadlineMin(task: LogisticsTaskForPhase2, workDate?: string): number {
  const deadlines: number[] = [];
  const cleanerDeadline = getCleanerDeadlineForBagDelivery(task);
  if (cleanerDeadline) {
    deadlines.push(parseMinutes(cleanerDeadline, 23 * 60 + 59));
  }
  const checkinApplies = !workDate || isDateCompatibleWithWorkDate(task.checkinDate, workDate);
  if (checkinApplies && task.checkinTime) {
    deadlines.push(parseMinutes(task.checkinTime, 23 * 60 + 59));
  }
  // Ritiro sporco: urgenza legata al checkout (dopo checkout), non all'inizio cleaner.
  if (!requiresDriverBeforeCleaner(task.bagPolicy)) {
    const checkoutApplies = !workDate || isDateCompatibleWithWorkDate(task.checkoutDate, workDate);
    if (checkoutApplies && task.checkoutTime) {
      deadlines.push(parseMinutes(task.checkoutTime, 23 * 60 + 59));
    }
  }
  return deadlines.length > 0 ? Math.min(...deadlines) : 23 * 60 + 59;
}

function getGroupCentroid(tasks: LogisticsTaskForPhase2[]): { lat: number; lng: number } {
  const avgLat = tasks.reduce((sum, task) => sum + task.lat, 0) / Math.max(1, tasks.length);
  const avgLng = tasks.reduce((sum, task) => sum + task.lng, 0) / Math.max(1, tasks.length);
  return { lat: avgLat, lng: avgLng };
}

function getNearestTravelToGroup(groupTasks: LogisticsTaskForPhase2[], candidate: LogisticsTaskForPhase2): number {
  let bestTravel = Number.POSITIVE_INFINITY;
  for (const task of groupTasks) {
    const travel = estimateCarTravelMinutes(
      { lat: task.lat, lng: task.lng },
      { lat: candidate.lat, lng: candidate.lng }
    );
    if (travel < bestTravel) {
      bestTravel = travel;
    }
  }
  return bestTravel;
}

function getPriorityRank(task: LogisticsTaskForPhase2): number {
  const raw = String(task.priority ?? "").toLowerCase();
  if (raw.includes("early")) return 0;
  if (raw.includes("high")) return 1;
  if (raw.includes("medium")) return 2;
  if (raw.includes("low")) return 3;
  return 4;
}

function isCleanerEligibleTask(task: LogisticsTaskForPhase2): boolean {
  return Number.isFinite(task.cleanerId) && Number.isFinite(task.cleanerSequence);
}

function buildBandIndexByTaskId(phase1: LogisticsPhase1Result): Map<number, number> {
  const bandIndexByTaskId = new Map<number, number>();
  for (const assignment of phase1.bandAssignments) {
    bandIndexByTaskId.set(assignment.taskId, assignment.assignedBandIndex);
  }
  return bandIndexByTaskId;
}

function getDominantBandIndex(tasks: LogisticsTaskForPhase2[], bandIndexByTaskId: Map<number, number>): number {
  const counts = new Map<number, number>();
  for (const task of tasks) {
    const bandIndex = bandIndexByTaskId.get(task.taskId);
    if (bandIndex == null) continue;
    counts.set(bandIndex, (counts.get(bandIndex) ?? 0) + 1);
  }
  if (counts.size === 0) return 0;
  let bestBand = 0;
  let bestCount = -1;
  for (const [bandIndex, count] of counts.entries()) {
    if (count > bestCount || (count === bestCount && bandIndex < bestBand)) {
      bestBand = bandIndex;
      bestCount = count;
    }
  }
  return bestBand;
}

function describeCleanerClusterLink(
  cluster: LogisticsTaskForPhase2[],
  candidate: LogisticsTaskForPhase2
): CleanerClusterLinkMetrics {
  const limits = {
    maxTasksPerCluster: GROUP_MAX_TASKS,
    stepTravelMaxMin: CLEANER_CLUSTER_MAX_STEP_TRAVEL_MIN,
    centroidRadiusMaxMin: CLEANER_CLUSTER_MAX_RADIUS_TRAVEL_MIN,
  };
  const failedRules: string[] = [];
  if (cluster.length >= GROUP_MAX_TASKS) {
    failedRules.push(`cluster_size>=${GROUP_MAX_TASKS}`);
    return {
      compatible: false,
      stepTravelMin: 0,
      centroidTravelMin: 0,
      limits,
      failedRules,
    };
  }
  const previousTask = cluster[cluster.length - 1];
  const stepTravelMin = estimateCarTravelMinutes(
    { lat: previousTask.lat, lng: previousTask.lng },
    { lat: candidate.lat, lng: candidate.lng }
  );
  if (stepTravelMin > CLEANER_CLUSTER_MAX_STEP_TRAVEL_MIN) {
    failedRules.push(`step_travel>${CLEANER_CLUSTER_MAX_STEP_TRAVEL_MIN}min`);
  }
  const centroid = getGroupCentroid(cluster);
  const centroidTravelMin = estimateCarTravelMinutes(
    { lat: centroid.lat, lng: centroid.lng },
    { lat: candidate.lat, lng: candidate.lng }
  );
  if (centroidTravelMin > CLEANER_CLUSTER_MAX_RADIUS_TRAVEL_MIN) {
    failedRules.push(`centroid_travel>${CLEANER_CLUSTER_MAX_RADIUS_TRAVEL_MIN}min`);
  }
  return {
    compatible: failedRules.length === 0,
    stepTravelMin,
    centroidTravelMin,
    limits,
    failedRules,
  };
}

function isCleanerClusterCompatible(
  cluster: LogisticsTaskForPhase2[],
  candidate: LogisticsTaskForPhase2
): boolean {
  return describeCleanerClusterLink(cluster, candidate).compatible;
}

function buildCleanerClusterGroupingReason(
  cleanerId: number,
  segment: LogisticsTaskForPhase2[],
  segmentIndex: number,
  splitBefore: CleanerClusterLinkMetrics | null,
  splitFromTaskId: number | null
): GroupingReasonJson {
  const consecutiveLinks: Record<string, unknown>[] = [];
  for (let i = 1; i < segment.length; i++) {
    const prefix = segment.slice(0, i);
    const metrics = describeCleanerClusterLink(prefix, segment[i]);
    consecutiveLinks.push({
      fromTaskId: segment[i - 1].taskId,
      toTaskId: segment[i].taskId,
      fromCleanerSequence: segment[i - 1].cleanerSequence,
      toCleanerSequence: segment[i].cleanerSequence,
      stepTravelMin: metrics.stepTravelMin,
      centroidTravelMin: metrics.centroidTravelMin,
      compatible: metrics.compatible,
      limits: metrics.limits,
    });
  }
  const splitNote = splitBefore
    ? {
        newSegmentBecause: splitBefore.failedRules.join(", ") || "incompatible_with_previous_task",
        afterTaskId: splitFromTaskId,
        metrics: {
          stepTravelMin: splitBefore.stepTravelMin,
          centroidTravelMin: splitBefore.centroidTravelMin,
          limits: splitBefore.limits,
        },
      }
    : null;

  return {
    strategy: "CLEANER_CLUSTER",
    summary:
      segment.length >= 2
        ? `Cleaner ${cleanerId}: ${segment.length} task HK consecutivi (sequenza + vicinanza entro soglia)`
        : `Cleaner ${cleanerId}: segmento singolo non clusterizzabile`,
    details: {
      cleanerId,
      segmentIndex,
      orderedBy: ["cleaner_sequence", "cleaner_task_start_time", "task_id"],
      limits: {
        maxTasksPerCluster: GROUP_MAX_TASKS,
        stepTravelMaxMin: CLEANER_CLUSTER_MAX_STEP_TRAVEL_MIN,
        centroidRadiusMaxMin: CLEANER_CLUSTER_MAX_RADIUS_TRAVEL_MIN,
      },
      members: segment.map((task) => ({
        taskId: task.taskId,
        logisticCode: task.logisticCode,
        cleanerSequence: task.cleanerSequence,
        bagPolicy: task.bagPolicy,
        lat: task.lat,
        lng: task.lng,
      })),
      consecutiveLinks,
      splitBefore: splitNote,
    },
  };
}

function buildGeoFallbackGroupingReason(
  seed: LogisticsTaskForPhase2,
  members: LogisticsTaskForPhase2[],
  additions: Record<string, unknown>[]
): GroupingReasonJson {
  return {
    strategy: "GEOGRAPHIC_FALLBACK",
    summary:
      members.length > 1
        ? `${members.length} task senza cluster cleaner: seed geografico + vicini entro soglia`
        : "Task geografico isolato (nessun vicino entro soglia)",
    details: {
      seedTaskId: seed.taskId,
      limits: {
        maxTasksPerGroup: GROUP_MAX_TASKS,
        stepTravelMaxMin: GEO_FALLBACK_MAX_STEP_TRAVEL_MIN,
        radiusMaxMin: GEO_FALLBACK_MAX_RADIUS_TRAVEL_MIN,
      },
      members: members.map((task) => ({
        taskId: task.taskId,
        logisticCode: task.logisticCode,
        lat: task.lat,
        lng: task.lng,
        priority: task.priority,
        bagPolicy: task.bagPolicy,
      })),
      additions,
    },
  };
}

function buildSingletonBagGroupingReason(task: LogisticsTaskForPhase2): GroupingReasonJson {
  return {
    strategy: "SINGLETON_BAG_PRIORITY",
    summary: "Seq.1 premium o pax_in>4: gruppo singleton prioritario (driver porta borsone)",
    details: {
      taskId: task.taskId,
      logisticCode: task.logisticCode,
      cleanerId: task.cleanerId,
      cleanerSequence: task.cleanerSequence,
      premium: task.premium,
      paxIn: task.paxIn,
      bagPolicy: task.bagPolicy,
    },
  };
}

function buildRecoverySingletonGroupingReason(task: LogisticsTaskForPhase2): GroupingReasonJson {
  return {
    strategy: "RECOVERY_SINGLETON",
    summary: "Task non presente in nessun gruppo iniziale: singleton di recupero",
    details: {
      taskId: task.taskId,
      logisticCode: task.logisticCode,
      cleanerId: task.cleanerId,
      cleanerSequence: task.cleanerSequence,
    },
  };
}

function compareFallbackSeedOrder(a: LogisticsTaskForPhase2, b: LogisticsTaskForPhase2, workDate: string): number {
  const deadlineDiff = getTaskDeadlineMin(a, workDate) - getTaskDeadlineMin(b, workDate);
  if (deadlineDiff !== 0) return deadlineDiff;

  const aBag = a.bagPolicy === "DRIVER_BRINGS_BAG" ? 0 : 1;
  const bBag = b.bagPolicy === "DRIVER_BRINGS_BAG" ? 0 : 1;
  if (aBag !== bBag) return aBag - bBag;

  const priorityDiff = getPriorityRank(a) - getPriorityRank(b);
  if (priorityDiff !== 0) return priorityDiff;
  return a.taskId - b.taskId;
}

function buildGeographicFallbackGroups(
  fallbackTasks: LogisticsTaskForPhase2[],
  bandIndexByTaskId: Map<number, number>,
  workDate: string
): SpatialGroup[] {
  if (fallbackTasks.length === 0) return [];
  const pending = [...fallbackTasks].sort((a, b) => compareFallbackSeedOrder(a, b, workDate));
  const groups: SpatialGroup[] = [];
  let groupCounter = 0;

  while (pending.length > 0) {
    const seed = pending.shift()!;
    const currentGroup: LogisticsTaskForPhase2[] = [seed];
    const additions: Record<string, unknown>[] = [];

    while (currentGroup.length < GROUP_MAX_TASKS && pending.length > 0) {
      const centroid = getGroupCentroid(currentGroup);
      let bestIdx = -1;
      let bestScore = Number.POSITIVE_INFINITY;
      let bestNearestTravel = 0;
      let bestCentroidTravel = 0;
      for (let i = 0; i < pending.length; i++) {
        const candidate = pending[i];
        const nearestTravel = getNearestTravelToGroup(currentGroup, candidate);
        if (nearestTravel > GEO_FALLBACK_MAX_STEP_TRAVEL_MIN) continue;

        const centroidTravel = estimateCarTravelMinutes(
          { lat: centroid.lat, lng: centroid.lng },
          { lat: candidate.lat, lng: candidate.lng }
        );
        if (centroidTravel > GEO_FALLBACK_MAX_RADIUS_TRAVEL_MIN) continue;

        const score = nearestTravel * 100 + centroidTravel * 10 + getTaskDeadlineMin(candidate, workDate) / 10000;
        if (score < bestScore) {
          bestScore = score;
          bestIdx = i;
          bestNearestTravel = nearestTravel;
          bestCentroidTravel = centroidTravel;
        }
      }

      if (bestIdx === -1) break;
      const added = pending.splice(bestIdx, 1)[0];
      additions.push({
        addedTaskId: added.taskId,
        logisticCode: added.logisticCode,
        nearestTravelMin: bestNearestTravel,
        centroidTravelMin: bestCentroidTravel,
        pickScore: bestScore,
        reason:
          "nearest_pending_task_under_step_and_centroid_limits",
        limits: {
          stepTravelMaxMin: GEO_FALLBACK_MAX_STEP_TRAVEL_MIN,
          radiusMaxMin: GEO_FALLBACK_MAX_RADIUS_TRAVEL_MIN,
        },
      });
      currentGroup.push(added);
    }

    groups.push({
      groupId: `geo-fallback-${groupCounter}`,
      seedBandIndex: getDominantBandIndex(currentGroup, bandIndexByTaskId),
      tasks: currentGroup,
      origin: "GEOGRAPHIC_FALLBACK",
      cleanerId: null,
      groupingReason: buildGeoFallbackGroupingReason(seed, currentGroup, additions),
    });
    groupCounter += 1;
  }

  return groups;
}

function getGroupSortKey(group: SpatialGroup, workDate: string): [number, number, number, number, string] {
  const earliestDeadline = Math.min(...group.tasks.map((task) => getTaskDeadlineMin(task, workDate)));
  const hasDriverBringsBag = group.tasks.some((task) => task.bagPolicy === "DRIVER_BRINGS_BAG") ? 0 : 1;
  const originPriority = group.origin === "CLEANER_CLUSTER"
    ? 0
    : group.origin === "GEOGRAPHIC_FALLBACK"
      ? 1
      : 2;
  const sizeScore = -group.tasks.length;
  return [earliestDeadline, hasDriverBringsBag, originPriority, sizeScore, group.groupId];
}

function compareGroups(a: SpatialGroup, b: SpatialGroup, workDate: string): number {
  const aKey = getGroupSortKey(a, workDate);
  const bKey = getGroupSortKey(b, workDate);
  for (let i = 0; i < aKey.length; i++) {
    if (aKey[i] < bKey[i]) return -1;
    if (aKey[i] > bKey[i]) return 1;
  }
  return 0;
}

function buildCleanerAwareGroups(
  tasks: LogisticsTaskForPhase2[],
  phase1: LogisticsPhase1Result,
  workDate: string
): { groups: SpatialGroup[]; groupingStats: LogisticsPhase2GroupingStats } {
  const bandIndexByTaskId = buildBandIndexByTaskId(phase1);
  const cleanerEligibleTasks: LogisticsTaskForPhase2[] = [];
  const fallbackTasks: LogisticsTaskForPhase2[] = [];
  for (const task of tasks) {
    if (isCleanerEligibleTask(task)) cleanerEligibleTasks.push(task);
    else fallbackTasks.push(task);
  }

  const tasksByCleanerId = new Map<number, LogisticsTaskForPhase2[]>();
  for (const task of cleanerEligibleTasks) {
    const cleanerId = Number(task.cleanerId);
    if (!tasksByCleanerId.has(cleanerId)) tasksByCleanerId.set(cleanerId, []);
    tasksByCleanerId.get(cleanerId)!.push(task);
  }

  const cleanerClusters: SpatialGroup[] = [];
  const singletonFallbackGroups: SpatialGroup[] = [];
  const cleanerIds = Array.from(tasksByCleanerId.keys()).sort((a, b) => a - b);

  for (const cleanerId of cleanerIds) {
    const orderedTasks = [...(tasksByCleanerId.get(cleanerId) ?? [])].sort((a, b) => {
      const sequenceDiff = Number(a.cleanerSequence) - Number(b.cleanerSequence);
      if (sequenceDiff !== 0) return sequenceDiff;
      const cleanerStartDiff =
        parseMinutes(a.cleanerTaskStartTime ?? null, 23 * 60 + 59) -
        parseMinutes(b.cleanerTaskStartTime ?? null, 23 * 60 + 59);
      if (cleanerStartDiff !== 0) return cleanerStartDiff;
      return a.taskId - b.taskId;
    });

    const segments: Array<{
      tasks: LogisticsTaskForPhase2[];
      segmentIndex: number;
      splitBefore: CleanerClusterLinkMetrics | null;
      splitFromTaskId: number | null;
    }> = [];
    let currentCluster: LogisticsTaskForPhase2[] = [];
    let nextSplitBefore: CleanerClusterLinkMetrics | null = null;
    let nextSplitFromTaskId: number | null = null;
    for (const task of orderedTasks) {
      if (currentCluster.length === 0) {
        currentCluster = [task];
        continue;
      }
      const linkMetrics = describeCleanerClusterLink(currentCluster, task);
      if (linkMetrics.compatible) {
        currentCluster.push(task);
      } else {
        segments.push({
          tasks: currentCluster,
          segmentIndex: segments.length,
          splitBefore: nextSplitBefore,
          splitFromTaskId: nextSplitFromTaskId,
        });
        nextSplitBefore = linkMetrics;
        nextSplitFromTaskId = task.taskId;
        currentCluster = [task];
      }
    }
    if (currentCluster.length > 0) {
      segments.push({
        tasks: currentCluster,
        segmentIndex: segments.length,
        splitBefore: nextSplitBefore,
        splitFromTaskId: nextSplitFromTaskId,
      });
    }

    let cleanerClusterCounter = 0;
    for (const segmentEntry of segments) {
      const segment = segmentEntry.tasks;
      if (segment.length >= 2) {
        cleanerClusters.push({
          groupId: `cleaner-${cleanerId}-cluster-${cleanerClusterCounter}`,
          seedBandIndex: getDominantBandIndex(segment, bandIndexByTaskId),
          tasks: segment,
          origin: "CLEANER_CLUSTER",
          cleanerId,
          groupingReason: buildCleanerClusterGroupingReason(
            cleanerId,
            segment,
            segmentEntry.segmentIndex,
            segmentEntry.splitBefore,
            segmentEntry.splitFromTaskId
          ),
        });
        cleanerClusterCounter += 1;
        continue;
      }
      const singletonTask = segment[0];
      if (!singletonTask) continue;
      if (singletonTask.bagPolicy === "DRIVER_BRINGS_BAG") {
        singletonFallbackGroups.push({
          groupId: `singleton-${singletonTask.taskId}`,
          seedBandIndex: getDominantBandIndex([singletonTask], bandIndexByTaskId),
          tasks: [singletonTask],
          origin: "SINGLETON_FALLBACK",
          cleanerId: singletonTask.cleanerId ?? null,
          groupingReason: buildSingletonBagGroupingReason(singletonTask),
        });
      } else {
        fallbackTasks.push(singletonTask);
      }
    }
  }

  const geographicFallbackGroups = buildGeographicFallbackGroups(fallbackTasks, bandIndexByTaskId, workDate);
  const groups = [...cleanerClusters, ...geographicFallbackGroups, ...singletonFallbackGroups]
    .sort((a, b) => compareGroups(a, b, workDate));
  return {
    groups,
    groupingStats: {
      cleanerClusters: cleanerClusters.length,
      geographicFallbackGroups: geographicFallbackGroups.length,
      singletonFallbackTasks: singletonFallbackGroups.length,
      fallbackTasks: fallbackTasks.length + singletonFallbackGroups.length,
    },
  };
}

function buildDriverStates(selectedDrivers: LogisticsSelectedDriver[]): DriverState[] {
  return selectedDrivers.map((driver, idx) => {
    const driverStartMin = parseMinutes(driver.startTime, 10 * 60);
    return {
      driverId: driver.id,
      driverIndex: idx,
      driverStartMin,
      clockMin: driverStartMin,
      lastLat: LOGISTICS_DEPOT_LAT,
      lastLng: LOGISTICS_DEPOT_LNG,
      totalTravelMinutes: 0,
      assignedTasks: [],
      cleanerLastSequence: new Map<number, number>(),
    };
  });
}

function getSequencePreferencePenalty(
  task: LogisticsTaskForPhase2,
  cleanerLastSequence: Map<number, number>
): number {
  if (task.cleanerId == null || task.cleanerSequence == null) return 0;
  const cleanerId = task.cleanerId;
  const currentLastSequence = cleanerLastSequence.get(cleanerId) ?? 0;
  const expectedNext = currentLastSequence + 1;

  if (task.cleanerSequence > expectedNext) {
    return (task.cleanerSequence - expectedNext) * 2;
  }
  if (task.cleanerSequence < expectedNext) {
    return (expectedNext - task.cleanerSequence) * 3;
  }
  return 0;
}

function sortGroupTasksForDriver(group: SpatialGroup, state: DriverState, workDate: string): LogisticsTaskForPhase2[] {
  const remaining = [...group.tasks];
  const ordered: LogisticsTaskForPhase2[] = [];
  let currentLat = state.lastLat;
  let currentLng = state.lastLng;
  const cleanerLastSequence = new Map<number, number>(state.cleanerLastSequence);
  let lastTask: LogisticsTaskForPhase2 | null = null;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let i = 0; i < remaining.length; i++) {
      const task = remaining[i];
      const travel = currentLat != null && currentLng != null
        ? estimateCarTravelMinutes({ lat: currentLat, lng: currentLng }, { lat: task.lat, lng: task.lng })
        : 0;
      const deadline = getTaskDeadlineMin(task, workDate);
      const sequencePenalty = getSequencePreferencePenalty(task, cleanerLastSequence);
      const keepConsecutiveCleanerBonus =
        lastTask != null &&
        lastTask.cleanerId != null &&
        lastTask.cleanerId === task.cleanerId &&
        lastTask.cleanerSequence != null &&
        task.cleanerSequence != null &&
        task.cleanerSequence === lastTask.cleanerSequence + 1
          ? -40
          : 0;

      const bagBonus = task.bagPolicy === "DRIVER_BRINGS_BAG" ? -2 : 0;
      let score: number;
      if (group.origin === "CLEANER_CLUSTER") {
        // Cleaner clusters prioritize sequence continuity but still consider travel.
        score = sequencePenalty * 120 + travel * 20 + deadline / 10000 + keepConsecutiveCleanerBonus + bagBonus;
      } else if (group.origin === "GEOGRAPHIC_FALLBACK") {
        // Geographic fallback remains travel-first with deadline and bag urgency as soft ties.
        score = travel * 100 + sequencePenalty * 10 + deadline / 10000 + bagBonus;
      } else {
        score = travel * 100 + sequencePenalty * 10 + deadline / 10000;
      }
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    ordered.push(next);
    if (next.cleanerId != null && next.cleanerSequence != null) {
      const previous = cleanerLastSequence.get(next.cleanerId) ?? 0;
      cleanerLastSequence.set(next.cleanerId, Math.max(previous, next.cleanerSequence));
    }
    currentLat = next.lat;
    currentLng = next.lng;
    lastTask = next;
  }

  return ordered;
}

function getReasonPriority(reasonCode: LogisticsPhase2ReasonCode): number {
  switch (reasonCode) {
    case "CHECKIN_CHECKOUT_CONSTRAINT":
      return 3;
    case "CLEANER_TIME_CONSTRAINT":
      return 2;
    case "NO_DRIVER_FEASIBLE":
      return 1;
    case "NO_TASK_CANDIDATES":
      return 0;
    default:
      return 0;
  }
}

function pickMoreUsefulFailure(
  current: FeasibilityFailure | null,
  candidate: FeasibilityFailure | null
): FeasibilityFailure | null {
  if (!candidate) return current;
  if (!current) return candidate;
  const currentPriority = getReasonPriority(current.reasonCode);
  const candidatePriority = getReasonPriority(candidate.reasonCode);
  if (candidatePriority > currentPriority) return candidate;
  if (candidatePriority < currentPriority) return current;
  if ((candidate.taskId ?? Number.MAX_SAFE_INTEGER) < (current.taskId ?? Number.MAX_SAFE_INTEGER)) return candidate;
  return current;
}

function getOrderSequencePenalty(orderedTasks: LogisticsTaskForPhase2[], state: DriverState): number {
  const cleanerLastSequence = new Map<number, number>(state.cleanerLastSequence);
  let penalty = 0;
  for (const task of orderedTasks) {
    if (task.cleanerId == null || task.cleanerSequence == null) continue;
    const expected = (cleanerLastSequence.get(task.cleanerId) ?? 0) + 1;
    if (task.cleanerSequence !== expected) {
      penalty += Math.abs(task.cleanerSequence - expected);
    }
    const previous = cleanerLastSequence.get(task.cleanerId) ?? 0;
    cleanerLastSequence.set(task.cleanerId, Math.max(previous, task.cleanerSequence));
  }
  return penalty;
}

function permuteTasks(tasks: LogisticsTaskForPhase2[]): LogisticsTaskForPhase2[][] {
  if (tasks.length <= 1) return [tasks];
  const result: LogisticsTaskForPhase2[][] = [];
  for (let i = 0; i < tasks.length; i++) {
    const head = tasks[i];
    const tail = [...tasks.slice(0, i), ...tasks.slice(i + 1)];
    for (const permutation of permuteTasks(tail)) {
      result.push([head, ...permutation]);
    }
  }
  return result;
}

function dedupeOrderCandidates(candidates: LogisticsTaskForPhase2[][]): LogisticsTaskForPhase2[][] {
  const seen = new Set<string>();
  const unique: LogisticsTaskForPhase2[][] = [];
  for (const candidate of candidates) {
    const key = candidate.map((task) => task.taskId).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

function buildOrderCandidates(
  group: SpatialGroup,
  state: DriverState,
  workDate: string
): LogisticsTaskForPhase2[][] {
  const candidates: LogisticsTaskForPhase2[][] = [];
  candidates.push(sortGroupTasksForDriver(group, state, workDate));

  if (group.origin === "CLEANER_CLUSTER") {
    candidates.push(
      [...group.tasks].sort((a, b) => {
        const sequenceDiff = Number(a.cleanerSequence ?? 9999) - Number(b.cleanerSequence ?? 9999);
        if (sequenceDiff !== 0) return sequenceDiff;
        const deadlineDiff = getTaskDeadlineMin(a, workDate) - getTaskDeadlineMin(b, workDate);
        if (deadlineDiff !== 0) return deadlineDiff;
        return a.taskId - b.taskId;
      })
    );
  }

  candidates.push(...permuteTasks(group.tasks));
  return dedupeOrderCandidates(candidates);
}

function simulateOrderedTasksForDriver(
  group: SpatialGroup,
  orderedTasks: LogisticsTaskForPhase2[],
  state: DriverState,
  workDate: string,
  taskById: Map<number, LogisticsTaskForPhase2>
): GroupSimulationResult {
  const projectedCleanerLastSequence = new Map<number, number>(state.cleanerLastSequence);
  const infeasibleResult = (reasonCode: LogisticsPhase2ReasonCode, taskId: number | null): GroupSimulationResult => ({
    feasible: false,
    assignments: [],
    projectedClockMin: state.clockMin,
    projectedLastLat: state.lastLat,
    projectedLastLng: state.lastLng,
    projectedCleanerLastSequence: new Map<number, number>(state.cleanerLastSequence),
    travelMinutesDelta: 0,
    score: Number.NEGATIVE_INFINITY,
    failure: { reasonCode, taskId },
  });

  const existingOrdered = [...state.assignedTasks]
    .sort((a, b) => a.sequence - b.sequence)
    .map((assignment) => taskById.get(assignment.taskId))
    .filter((task): task is LogisticsTaskForPhase2 => task != null);

  const fullOrdered = [...existingOrdered, ...orderedTasks];
  const built = buildLogisticsScheduleForDriver({
    tasks: fullOrdered.map(toLogisticsScheduleTaskInput),
    driverStartMin: state.driverStartMin,
    workDate,
  });

  const candidateIds = new Set(orderedTasks.map((task) => task.taskId));

  if (built.violations.checkin.length > 0) {
    const fail =
      built.violations.checkin.find((row) => candidateIds.has(row.taskId)) ?? built.violations.checkin[0];
    return infeasibleResult("CHECKIN_CHECKOUT_CONSTRAINT", fail?.taskId ?? null);
  }

  if (built.violations.checkoutWaitExceeded.length > 0) {
    const fail =
      built.violations.checkoutWaitExceeded.find((row) => candidateIds.has(row.taskId)) ??
      built.violations.checkoutWaitExceeded[0];
    return infeasibleResult("CHECKIN_CHECKOUT_CONSTRAINT", fail?.taskId ?? null);
  }

  const schedule: LogisticsTaskSchedule[] = [];
  let travelDelta = 0;
  let checkoutWaitMinutesDelta = 0;

  for (let i = 0; i < orderedTasks.length; i++) {
    const task = orderedTasks[i];
    const row = built.tasks.find((scheduled) => scheduled.taskId === task.taskId);
    if (!row) {
      return infeasibleResult("CHECKIN_CHECKOUT_CONSTRAINT", task.taskId);
    }

    if (getCleanerViolation(task, row.endMin)) {
      return infeasibleResult("CLEANER_TIME_CONSTRAINT", task.taskId);
    }

    schedule.push({
      taskId: task.taskId,
      logisticCode: task.logisticCode,
      startTime: row.startTime,
      endTime: row.endTime,
      travelMinutes: row.travelMinutes,
      checkoutWaitMinutes: row.checkoutWaitMinutes,
      sequence: row.sequence,
      reasonCode: null,
    });

    travelDelta += row.travelMinutes;
    checkoutWaitMinutesDelta += row.checkoutWaitMinutes;

    if (task.cleanerId != null && task.cleanerSequence != null) {
      const previous = projectedCleanerLastSequence.get(task.cleanerId) ?? 0;
      projectedCleanerLastSequence.set(task.cleanerId, Math.max(previous, task.cleanerSequence));
    }
  }

  const projectedTaskCount = state.assignedTasks.length + schedule.length;
  const projectedLoadMin = projectedTaskCount * LOGISTICS_TASK_DURATION_MIN;
  const fairnessPenalty = projectedLoadMin * 0.3 + projectedTaskCount * 2.5;
  const bandPenalty = Math.abs(group.seedBandIndex - state.driverIndex) * 3;
  const orderSequencePenalty = group.origin === "CLEANER_CLUSTER"
    ? getOrderSequencePenalty(orderedTasks, state) * 6
    : 0;

  const hasDriverBringsBag = group.tasks.some((task) => task.bagPolicy === "DRIVER_BRINGS_BAG");
  const cleanerContinuityBonus = group.tasks.reduce((sum, task) => {
    if (task.cleanerId == null || task.cleanerSequence == null) return sum;
    const previousSequence = state.cleanerLastSequence.get(task.cleanerId);
    if (previousSequence == null) return sum;
    return task.cleanerSequence === previousSequence + 1 ? sum + 4 : sum;
  }, 0);
  const cleanerClusterBonus = group.origin === "CLEANER_CLUSTER" ? 5 : 0;
  const centroid = getGroupCentroid(group.tasks);
  const fallbackCompactnessPenalty = group.origin === "GEOGRAPHIC_FALLBACK"
    ? Math.max(
      0,
      Math.round(
        group.tasks.reduce((sum, task) => {
          const travel = estimateCarTravelMinutes(
            { lat: centroid.lat, lng: centroid.lng },
            { lat: task.lat, lng: task.lng }
          );
          return sum + travel;
        }, 0) / Math.max(1, group.tasks.length) - 4
      )
    )
    : 0;
  const driverBringsBagUrgencyBonus = hasDriverBringsBag ? 3 : 0;
  const waitPenalty = checkoutWaitMinutesDelta * 0.5;
  const score =
    1000 -
    travelDelta -
    waitPenalty -
    fairnessPenalty -
    bandPenalty -
    orderSequencePenalty +
    cleanerContinuityBonus +
    cleanerClusterBonus +
    driverBringsBagUrgencyBonus -
    fallbackCompactnessPenalty;

  const lastRow = built.tasks[built.tasks.length - 1];

  return {
    feasible: true,
    assignments: schedule,
    projectedClockMin: lastRow?.endMin ?? state.clockMin,
    projectedLastLat: built.lastLat,
    projectedLastLng: built.lastLng,
    projectedCleanerLastSequence,
    travelMinutesDelta: travelDelta,
    score,
    failure: null,
  };
}

function simulateGroupForDriver(
  group: SpatialGroup,
  state: DriverState,
  workDate: string,
  taskById: Map<number, LogisticsTaskForPhase2>
): GroupSimulationResult {
  const orderCandidates = buildOrderCandidates(group, state, workDate);
  let bestSimulation: GroupSimulationResult | null = null;
  let bestFailure: FeasibilityFailure | null = null;

  for (const orderedTasks of orderCandidates) {
    const simulation = simulateOrderedTasksForDriver(group, orderedTasks, state, workDate, taskById);
    if (!simulation.feasible) {
      bestFailure = pickMoreUsefulFailure(bestFailure, simulation.failure);
      continue;
    }
    if (!bestSimulation || simulation.score > bestSimulation.score) {
      bestSimulation = simulation;
    }
  }

  if (bestSimulation) return bestSimulation;
  return {
    feasible: false,
    assignments: [],
    projectedClockMin: state.clockMin,
    projectedLastLat: state.lastLat,
    projectedLastLng: state.lastLng,
    projectedCleanerLastSequence: new Map<number, number>(state.cleanerLastSequence),
    travelMinutesDelta: 0,
    score: Number.NEGATIVE_INFINITY,
    failure: bestFailure ?? {
      reasonCode: "NO_DRIVER_FEASIBLE",
      taskId: null,
    },
  };
}

function incrementReasonCount(
  reasonCounts: Record<LogisticsPhase2ReasonCode, number>,
  reasonCode: LogisticsPhase2ReasonCode
): void {
  reasonCounts[reasonCode] += 1;
}

function applySimulationToDriverState(state: DriverState, simulation: GroupSimulationResult): void {
  state.assignedTasks.push(...simulation.assignments);
  state.clockMin = simulation.projectedClockMin;
  state.lastLat = simulation.projectedLastLat;
  state.lastLng = simulation.projectedLastLng;
  state.cleanerLastSequence = simulation.projectedCleanerLastSequence;
  state.totalTravelMinutes += simulation.travelMinutesDelta;
}

function projectDriverStatesAfterChoice(
  choice: PartialGroupSimulationChoice,
  driverStates: DriverState[]
): DriverState[] {
  return driverStates.map((state) => {
    if (state !== choice.state) return state;
    return {
      ...state,
      clockMin: choice.simulation.projectedClockMin,
      lastLat: choice.simulation.projectedLastLat,
      lastLng: choice.simulation.projectedLastLng,
      totalTravelMinutes: state.totalTravelMinutes + choice.simulation.travelMinutesDelta,
      assignedTasks: [...state.assignedTasks, ...choice.simulation.assignments],
      cleanerLastSequence: new Map(choice.simulation.projectedCleanerLastSequence),
    };
  });
}

function buildTaskSubsetsByDescendingSize(tasks: LogisticsTaskForPhase2[]): LogisticsTaskForPhase2[][] {
  const subsets: LogisticsTaskForPhase2[][] = [];
  const totalMasks = 1 << tasks.length;
  for (let mask = 1; mask < totalMasks; mask++) {
    const subset: LogisticsTaskForPhase2[] = [];
    for (let bit = 0; bit < tasks.length; bit++) {
      if ((mask & (1 << bit)) !== 0) subset.push(tasks[bit]);
    }
    subsets.push(subset);
  }
  subsets.sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    const aKey = a.map((task) => task.taskId).join("-");
    const bKey = b.map((task) => task.taskId).join("-");
    return aKey.localeCompare(bKey);
  });
  return subsets;
}

function estimateRecoverableTaskCount(
  group: SpatialGroup | null,
  driverStates: DriverState[],
  workDate: string,
  taskById: Map<number, LogisticsTaskForPhase2>,
  depth = 0
): number {
  if (!group) return 0;

  for (const state of driverStates) {
    const simulation = simulateGroupForDriver(group, state, workDate, taskById);
    if (simulation.feasible) {
      return group.tasks.length;
    }
  }

  if (group.tasks.length <= 1 || depth >= 2) {
    return 0;
  }

  let best = 0;
  const subsets = buildTaskSubsetsByDescendingSize(group.tasks)
    .filter((subset) => subset.length < group.tasks.length);

  for (const subset of subsets) {
    const subsetGroup: SpatialGroup = {
      ...group,
      groupId: `${group.groupId}-estimate-${subset.map((task) => task.taskId).join("-")}`,
      tasks: subset,
      origin: subset.length === 1 ? "SINGLETON_FALLBACK" : group.origin,
    };

    for (const state of driverStates) {
      const simulation = simulateGroupForDriver(subsetGroup, state, workDate, taskById);
      if (!simulation.feasible) continue;

      const selectedTaskIds = new Set(subset.map((task) => task.taskId));
      const remainingTasks = group.tasks.filter((task) => !selectedTaskIds.has(task.taskId));
      const remainingGroup: SpatialGroup | null = remainingTasks.length > 0
        ? {
          ...group,
          groupId: `${group.groupId}-estimate-remaining-${remainingTasks.map((task) => task.taskId).join("-")}`,
          tasks: remainingTasks,
          origin: remainingTasks.length === 1 ? "SINGLETON_FALLBACK" : group.origin,
        }
        : null;

      const projectedChoice: PartialGroupSimulationChoice = {
        assignedGroup: subsetGroup,
        remainingGroup,
        state,
        simulation,
      };

      const projectedStates = projectDriverStatesAfterChoice(projectedChoice, driverStates);
      const recoverable =
        subset.length +
        estimateRecoverableTaskCount(remainingGroup, projectedStates, workDate, taskById, depth + 1);

      if (recoverable > best) {
        best = recoverable;
      }
    }
  }

  return best;
}

interface PartialChoiceRanking {
  expectedRecoverableTasks: number;
  assignedSize: number;
  remainingFeasibleOnSomeDriver: boolean;
  remainingScoreEstimate: number;
  score: number;
  travelMinutesDelta: number;
  tieBreaker: string;
}

function getPartialChoiceRanking(
  choice: PartialGroupSimulationChoice,
  driverStates: DriverState[],
  workDate: string,
  taskById: Map<number, LogisticsTaskForPhase2>
): PartialChoiceRanking {
  let remainingFeasibleOnSomeDriver = false;
  let remainingScoreEstimate = Number.NEGATIVE_INFINITY;
  const projectedDriverStates = projectDriverStatesAfterChoice(choice, driverStates);
  if (choice.remainingGroup) {
    for (const state of projectedDriverStates) {
      const remainingSimulation = simulateGroupForDriver(choice.remainingGroup, state, workDate, taskById);
      if (remainingSimulation.feasible) {
        remainingFeasibleOnSomeDriver = true;
        if (remainingSimulation.score > remainingScoreEstimate) {
          remainingScoreEstimate = remainingSimulation.score;
        }
      }
    }
  } else {
    remainingFeasibleOnSomeDriver = true;
    remainingScoreEstimate = 0;
  }
  const remainingRecoverableTasks = estimateRecoverableTaskCount(
    choice.remainingGroup,
    projectedDriverStates,
    workDate,
    taskById
  );
  const expectedRecoverableTasks =
    choice.assignedGroup.tasks.length + remainingRecoverableTasks;
  return {
    expectedRecoverableTasks,
    assignedSize: choice.assignedGroup.tasks.length,
    remainingFeasibleOnSomeDriver,
    remainingScoreEstimate,
    score: choice.simulation.score,
    travelMinutesDelta: choice.simulation.travelMinutesDelta,
    tieBreaker: choice.assignedGroup.groupId,
  };
}

function isBetterPartialRanking(candidate: PartialChoiceRanking, current: PartialChoiceRanking): boolean {
  if (candidate.expectedRecoverableTasks !== current.expectedRecoverableTasks) {
    return candidate.expectedRecoverableTasks > current.expectedRecoverableTasks;
  }
  if (candidate.assignedSize !== current.assignedSize) {
    return candidate.assignedSize > current.assignedSize;
  }
  if (candidate.remainingFeasibleOnSomeDriver !== current.remainingFeasibleOnSomeDriver) {
    return candidate.remainingFeasibleOnSomeDriver;
  }
  if (candidate.remainingScoreEstimate !== current.remainingScoreEstimate) {
    return candidate.remainingScoreEstimate > current.remainingScoreEstimate;
  }
  if (candidate.score !== current.score) {
    return candidate.score > current.score;
  }
  if (candidate.travelMinutesDelta !== current.travelMinutesDelta) {
    return candidate.travelMinutesDelta < current.travelMinutesDelta;
  }
  return candidate.tieBreaker < current.tieBreaker;
}

function getBestSingletonFailureReason(
  task: LogisticsTaskForPhase2,
  sourceGroup: SpatialGroup,
  driverStates: DriverState[],
  workDate: string,
  taskById: Map<number, LogisticsTaskForPhase2>
): LogisticsPhase2ReasonCode {
  const singletonGroup: SpatialGroup = {
    ...sourceGroup,
    groupId: `${sourceGroup.groupId}-reason-${task.taskId}`,
    tasks: [task],
    origin: "SINGLETON_FALLBACK",
  };

  let bestFailure: FeasibilityFailure | null = null;

  for (const state of driverStates) {
    const simulation = simulateGroupForDriver(singletonGroup, state, workDate, taskById);
    if (simulation.feasible) {
      return "NO_DRIVER_FEASIBLE";
    }
    bestFailure = pickMoreUsefulFailure(bestFailure, simulation.failure);
  }

  return bestFailure?.reasonCode ?? "NO_DRIVER_FEASIBLE";
}

function findBestPartialGroupAssignment(
  group: SpatialGroup,
  driverStates: DriverState[],
  workDate: string,
  taskById: Map<number, LogisticsTaskForPhase2>
): PartialGroupSimulationChoice | null {
  if (group.tasks.length <= 1) return null;
  const subsets = buildTaskSubsetsByDescendingSize(group.tasks).filter((subset) => subset.length < group.tasks.length);

  let currentSize: number | null = null;
  let bestChoice: PartialGroupSimulationChoice | null = null;
  let bestRanking: PartialChoiceRanking | null = null;

  for (const subset of subsets) {
    if (
      currentSize !== null &&
      subset.length < currentSize &&
      bestChoice &&
      bestRanking?.remainingFeasibleOnSomeDriver
    ) {
      // Chiude solo se il miglior subset alla dimensione precedente lascia un remaining assegnabile.
      return bestChoice;
    }
    currentSize = subset.length;

    const subsetGroup: SpatialGroup = {
      ...group,
      groupId: `${group.groupId}-partial-${subset.map((task) => task.taskId).join("-")}`,
      tasks: subset,
      origin: subset.length === 1 ? "SINGLETON_FALLBACK" : group.origin,
    };

    for (const state of driverStates) {
      const simulation = simulateGroupForDriver(subsetGroup, state, workDate, taskById);
      if (!simulation.feasible) continue;
      const selectedTaskIds = new Set(subset.map((task) => task.taskId));
      const remainingTasks = group.tasks.filter((task) => !selectedTaskIds.has(task.taskId));
      const remainingGroup: SpatialGroup | null = remainingTasks.length > 0
        ? {
          ...group,
          groupId: `${group.groupId}-remaining-${remainingTasks.map((task) => task.taskId).join("-")}`,
          tasks: remainingTasks,
          origin: remainingTasks.length === 1 ? "SINGLETON_FALLBACK" : group.origin,
        }
        : null;

      const choice: PartialGroupSimulationChoice = {
        assignedGroup: subsetGroup,
        remainingGroup,
        state,
        simulation,
      };
      const ranking = getPartialChoiceRanking(choice, driverStates, workDate, taskById);

      if (!bestRanking || isBetterPartialRanking(ranking, bestRanking)) {
        bestChoice = choice;
        bestRanking = ranking;
      }
    }
  }

  return bestChoice;
}

function defaultGroupingReason(origin: string | undefined): GroupingReasonJson {
  return {
    strategy: "RECOVERY_SINGLETON",
    summary: `Gruppo ${origin ?? "UNKNOWN"} senza metadati di raggruppamento`,
    details: { origin: origin ?? "UNKNOWN" },
  };
}

function buildQueueSortKeyForGroup(group: SpatialGroup, workDate: string): GroupCreatedJson["queueSortKey"] {
  const key = getGroupSortKey(group, workDate);
  return {
    earliestDeadlineMin: key[0],
    hasDriverBringsBag: key[1] === 0,
    originPriority: key[2],
    sizeScore: key[3],
  };
}

function buildDriverAttemptsForGroup(
  group: SpatialGroup,
  driverStates: DriverState[],
  workDate: string,
  taskById: Map<number, LogisticsTaskForPhase2>
): {
  attempts: DriverAttemptJson[];
  bestState: DriverState | null;
  bestSimulation: GroupSimulationResult | null;
  bestFailureByTaskId: Map<number, FeasibilityFailure>;
} {
  let bestState: DriverState | null = null;
  let bestSimulation: GroupSimulationResult | null = null;
  const bestFailureByTaskId = new Map<number, FeasibilityFailure>();
  const attempts: DriverAttemptJson[] = [];

  for (const state of driverStates) {
    const simulation = simulateGroupForDriver(group, state, workDate, taskById);
    attempts.push({
      driverId: state.driverId,
      feasible: simulation.feasible,
      score: simulation.feasible ? simulation.score : undefined,
      travelMinutesDelta: simulation.feasible ? simulation.travelMinutesDelta : undefined,
      projectedClockEnd: simulation.feasible ? toHHMM(simulation.projectedClockMin) : undefined,
      failure: simulation.feasible
        ? undefined
        : simulation.failure
          ? {
              reasonCode: simulation.failure.reasonCode,
              taskId: simulation.failure.taskId,
            }
          : undefined,
    });
    if (!simulation.feasible) {
      const failure = simulation.failure;
      if (failure?.taskId != null) {
        const prev = bestFailureByTaskId.get(failure.taskId);
        const merged = pickMoreUsefulFailure(prev ?? null, failure);
        if (merged) bestFailureByTaskId.set(failure.taskId, merged);
      }
      continue;
    }
    if (!bestSimulation || simulation.score > bestSimulation.score) {
      bestSimulation = simulation;
      bestState = state;
    }
  }

  return { attempts, bestState, bestSimulation, bestFailureByTaskId };
}

export async function runLogisticsPhase2(
  workDate: string,
  unlockedTaskData: LogisticsTaskInputWithLock[],
  phase1: LogisticsPhase1Result,
  debugCollector?: LogisticsPhase2DebugCollector | null
): Promise<LogisticsPhase2Result> {
  const reasonCounts: Record<LogisticsPhase2ReasonCode, number> = {
    CHECKIN_CHECKOUT_CONSTRAINT: 0,
    CLEANER_TIME_CONSTRAINT: 0,
    NO_DRIVER_FEASIBLE: 0,
    NO_TASK_CANDIDATES: 0,
  };

  const phase2Tasks = buildPhase2Tasks(unlockedTaskData, phase1.taskCandidates);
  const filteredByBagRule = filterTasksByBagRule(phase2Tasks);
  const bagPolicyExcludedTaskIds = filteredByBagRule.excludedTaskIds;
  const schedulableTasks = filteredByBagRule.included;
  const taskById = new Map(schedulableTasks.map((task) => [task.taskId, task]));

  if (schedulableTasks.length === 0) {
    reasonCounts.NO_TASK_CANDIDATES = 1;
    return {
      canRun: true,
      phase: 2,
      workDate,
      groupsProcessed: 0,
      groupsAssigned: 0,
      groupsUnassigned: 0,
      tasksAssigned: 0,
      tasksUnassigned: 0,
      driverPlans: phase1.selectedDrivers.map((driver) => ({
        driverId: driver.id,
        driverStartTime: driver.startTime,
        totalTasks: 0,
        totalTravelMinutes: 0,
        totalServiceMinutes: 0,
        assignments: [],
      })),
      unassignedTasks: [],
      validation: {
        noTaskCandidates: true,
        bagPolicyExcludedCount: bagPolicyExcludedTaskIds.length,
        bagPolicyExcludedTaskIds,
        reasonCounts,
        groupingStats: {
          cleanerClusters: 0,
          geographicFallbackGroups: 0,
          singletonFallbackTasks: 0,
          fallbackTasks: 0,
        },
      },
    };
  }

  const grouped = buildCleanerAwareGroups(schedulableTasks, phase1, workDate);
  const groupedTaskSeen = new Set<number>();
  const deduplicatedGroups: SpatialGroup[] = [];
  let duplicateTaskCount = 0;

  for (const group of grouped.groups) {
    const uniqueTasks: LogisticsTaskForPhase2[] = [];
    for (const task of group.tasks) {
      if (groupedTaskSeen.has(task.taskId)) {
        duplicateTaskCount += 1;
        continue;
      }
      groupedTaskSeen.add(task.taskId);
      uniqueTasks.push(task);
    }
    if (uniqueTasks.length > 0) {
      deduplicatedGroups.push({
        ...group,
        tasks: uniqueTasks,
      });
    }
  }

  const bandIndexByTaskId = buildBandIndexByTaskId(phase1);
  const missingTasks = schedulableTasks.filter((task) => !groupedTaskSeen.has(task.taskId));
  for (const task of missingTasks) {
    deduplicatedGroups.push({
      groupId: `recovery-${task.taskId}`,
      seedBandIndex: getDominantBandIndex([task], bandIndexByTaskId),
      tasks: [task],
      origin: "SINGLETON_FALLBACK",
      cleanerId: task.cleanerId ?? null,
      groupingReason: buildRecoverySingletonGroupingReason(task),
    });
  }
  const groups = deduplicatedGroups.sort((a, b) => compareGroups(a, b, workDate));

  if (debugCollector) {
    debugCollector.recordGroupsCreated(
      groups.map((group) => ({
        groupId: group.groupId,
        origin: group.origin,
        seedBandIndex: group.seedBandIndex,
        cleanerId: group.cleanerId ?? null,
        tasks: group.tasks.map((task) => ({
          taskId: task.taskId,
          logisticCode: task.logisticCode,
        })),
        groupingReason: group.groupingReason ?? defaultGroupingReason(group.origin),
        queueSortKey: buildQueueSortKeyForGroup(group, workDate),
      }))
    );
    debugCollector.setGroupingStats({
      cleanerClusters: grouped.groupingStats.cleanerClusters,
      geographicFallbackGroups: grouped.groupingStats.geographicFallbackGroups,
      singletonFallbackTasks: grouped.groupingStats.singletonFallbackTasks,
      fallbackTasks: grouped.groupingStats.fallbackTasks,
      recoveredMissingTaskCount: missingTasks.length,
      duplicateGroupedTaskCount: duplicateTaskCount,
    });
  }
  const driverStates = buildDriverStates(phase1.selectedDrivers);
  const unassignedTasks: LogisticsPhase2UnassignedTask[] = [];
  let groupsAssigned = 0;
  let groupsUnassigned = 0;
  let tasksAssigned = 0;

  const pendingGroups: SpatialGroup[] = [...groups];
  const initialGroupIds = new Set(groups.map((group) => group.groupId));
  let groupsProcessed = 0;
  let initialGroupsProcessed = 0;
  let queueGroupsProcessed = 0;
  let partialGroupsAssigned = 0;
  let groupsSplit = 0;
  const debugUnassignedDetails: UnassignedTaskDebugJson[] = [];
  while (pendingGroups.length > 0) {
    const group = pendingGroups.shift()!;
    groupsProcessed += 1;
    if (initialGroupIds.has(group.groupId)) {
      initialGroupsProcessed += 1;
    } else {
      queueGroupsProcessed += 1;
    }

    const groupingReason = group.groupingReason ?? defaultGroupingReason(group.origin);
    const { attempts, bestState, bestSimulation, bestFailureByTaskId } = buildDriverAttemptsForGroup(
      group,
      driverStates,
      workDate,
      taskById
    );

    if (bestState && bestSimulation) {
      applySimulationToDriverState(bestState, bestSimulation);
      groupsAssigned += 1;
      tasksAssigned += bestSimulation.assignments.length;
      if (debugCollector) {
        const decision: GroupDecisionJson = {
          step: groupsProcessed,
          groupId: group.groupId,
          origin: group.origin ?? "UNKNOWN",
          taskIds: group.tasks.map((task) => task.taskId),
          logisticCodes: group.tasks.map((task) => task.logisticCode),
          groupingReason,
          outcome: "FULL_ASSIGNED",
          why: "highest_score_among_feasible_drivers",
          winner: {
            driverId: bestState.driverId,
            score: bestSimulation.score,
            travelMinutesDelta: bestSimulation.travelMinutesDelta,
            projectedClockEnd: toHHMM(bestSimulation.projectedClockMin),
            taskOrder: bestSimulation.assignments.map((item) => item.taskId),
            schedule: mapAssignmentsToDebugSchedule(bestSimulation.assignments),
          },
          driverAttempts: attempts,
        };
        debugCollector.recordGroupDecision(decision);
      }
      continue;
    }

    const partialChoice = findBestPartialGroupAssignment(group, driverStates, workDate, taskById);
    if (partialChoice) {
      applySimulationToDriverState(partialChoice.state, partialChoice.simulation);
      groupsAssigned += 1;
      partialGroupsAssigned += 1;
      tasksAssigned += partialChoice.simulation.assignments.length;
      if (partialChoice.remainingGroup) {
        groupsSplit += 1;
        pendingGroups.unshift(partialChoice.remainingGroup);
      }
      if (debugCollector) {
        const partialRanking = getPartialChoiceRanking(partialChoice, driverStates, workDate);
        const decision: GroupDecisionJson = {
          step: groupsProcessed,
          groupId: group.groupId,
          origin: group.origin ?? "UNKNOWN",
          taskIds: group.tasks.map((task) => task.taskId),
          logisticCodes: group.tasks.map((task) => task.logisticCode),
          groupingReason,
          outcome: "PARTIAL_ASSIGNED",
          why: "no_full_feasible_assignment; best_partial_subset_selected",
          winner: {
            driverId: partialChoice.state.driverId,
            score: partialChoice.simulation.score,
            travelMinutesDelta: partialChoice.simulation.travelMinutesDelta,
            projectedClockEnd: toHHMM(partialChoice.simulation.projectedClockMin),
            taskOrder: partialChoice.simulation.assignments.map((item) => item.taskId),
            schedule: mapAssignmentsToDebugSchedule(partialChoice.simulation.assignments),
          },
          partial: {
            assignedTaskIds: partialChoice.assignedGroup.tasks.map((task) => task.taskId),
            remainingGroupId: partialChoice.remainingGroup?.groupId ?? null,
            expectedRecoverableTasks: partialRanking.expectedRecoverableTasks,
            assignedSize: partialRanking.assignedSize,
            remainingFeasibleOnSomeDriver: partialRanking.remainingFeasibleOnSomeDriver,
          },
          driverAttempts: attempts,
        };
        debugCollector.recordGroupDecision(decision);
      }
      continue;
    }

    groupsUnassigned += 1;
    const perTaskReason: GroupDecisionJson["perTaskReason"] = [];
    for (const task of group.tasks) {
      const taskSpecific = bestFailureByTaskId.get(task.taskId);
      const reasonCode =
        taskSpecific?.reasonCode ??
        getBestSingletonFailureReason(task, group, driverStates, workDate, taskById);
      incrementReasonCount(reasonCounts, reasonCode);
      unassignedTasks.push({
        taskId: task.taskId,
        logisticCode: task.logisticCode,
        reasonCode,
      });
      perTaskReason.push({
        taskId: task.taskId,
        logisticCode: task.logisticCode,
        reasonCode,
      });
      debugUnassignedDetails.push({
        taskId: task.taskId,
        logisticCode: task.logisticCode,
        reasonCode,
        sourceGroupId: group.groupId,
        driverFailures: attempts
          .filter((item) => !item.feasible && item.failure)
          .map((item) => ({
            driverId: item.driverId,
            reasonCode: item.failure!.reasonCode,
            taskId: item.failure!.taskId,
          })),
      });
    }
    if (debugCollector) {
      debugCollector.recordGroupDecision({
        step: groupsProcessed,
        groupId: group.groupId,
        origin: group.origin ?? "UNKNOWN",
        taskIds: group.tasks.map((task) => task.taskId),
        logisticCodes: group.tasks.map((task) => task.logisticCode),
        groupingReason,
        outcome: "REJECTED",
        why: "no_feasible_full_or_partial_assignment_for_any_driver",
        driverAttempts: attempts,
        perTaskReason,
      });
    }
  }

  const driverPlans: DriverPhase2Plan[] = driverStates.map((state) => ({
    driverId: state.driverId,
    driverStartTime: toHHMM(state.driverStartMin),
    totalTasks: state.assignedTasks.length,
    totalTravelMinutes: state.totalTravelMinutes,
    totalServiceMinutes: state.assignedTasks.length * LOGISTICS_TASK_DURATION_MIN,
    assignments: state.assignedTasks.sort((a, b) => a.sequence - b.sequence),
  }));

  for (const task of schedulableTasks) {
    const assigned = driverPlans.some((plan) => plan.assignments.some((item) => item.taskId === task.taskId));
    if (!assigned && !unassignedTasks.some((item) => item.taskId === task.taskId)) {
      incrementReasonCount(reasonCounts, "NO_DRIVER_FEASIBLE");
      unassignedTasks.push({
        taskId: task.taskId,
        logisticCode: task.logisticCode,
        reasonCode: "NO_DRIVER_FEASIBLE",
      });
      debugUnassignedDetails.push({
        taskId: task.taskId,
        logisticCode: task.logisticCode,
        reasonCode: "NO_DRIVER_FEASIBLE",
        driverFailures: [],
      });
    }
  }

  let debugDir: string | undefined;
  if (debugCollector) {
    debugCollector.setGroupingStats({
      ...(debugCollector.groupingStats ?? {
        cleanerClusters: grouped.groupingStats.cleanerClusters,
        geographicFallbackGroups: grouped.groupingStats.geographicFallbackGroups,
        singletonFallbackTasks: grouped.groupingStats.singletonFallbackTasks,
        fallbackTasks: grouped.groupingStats.fallbackTasks,
      }),
      initialGroupsProcessed,
      queueGroupsProcessed,
      partialGroupsAssigned,
      groupsSplit,
      recoveredMissingTaskCount: missingTasks.length,
      duplicateGroupedTaskCount: duplicateTaskCount,
    });
    debugCollector.recordUnassignedTasks(debugUnassignedDetails);
    debugCollector.setSummary(
      {
        groupsProcessed,
        groupsAssigned,
        groupsUnassigned,
        tasksAssigned,
        tasksUnassigned: unassignedTasks.length,
      },
      reasonCounts
    );
    const { writeLogisticsPhase2DebugFiles } = await import("./phase2-debug");
    debugDir = await writeLogisticsPhase2DebugFiles(debugCollector);
    console.log(`📋 Logistics optimizer debug scritto in: ${debugDir}`);
  }

  return {
    canRun: true,
    phase: 2,
    workDate,
    groupsProcessed,
    groupsAssigned,
    groupsUnassigned,
    tasksAssigned,
    tasksUnassigned: unassignedTasks.length,
    driverPlans,
    unassignedTasks,
    debugDir,
    validation: {
      noTaskCandidates: false,
      bagPolicyExcludedCount: bagPolicyExcludedTaskIds.length,
      bagPolicyExcludedTaskIds,
      reasonCounts,
      groupingStats: {
        cleanerClusters: grouped.groupingStats.cleanerClusters,
        geographicFallbackGroups: grouped.groupingStats.geographicFallbackGroups,
        singletonFallbackTasks: grouped.groupingStats.singletonFallbackTasks,
        fallbackTasks: grouped.groupingStats.fallbackTasks,
        initialGroupsProcessed,
        queueGroupsProcessed,
        partialGroupsAssigned,
        groupsSplit,
        recoveredMissingTaskCount: missingTasks.length,
        duplicateGroupedTaskCount: duplicateTaskCount,
      },
    },
  };
}

