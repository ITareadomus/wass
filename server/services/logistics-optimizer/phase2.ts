import { estimateCarTravelMinutes } from "../logistics-timeline-utils";
import {
  buildLogisticsScheduleForDriver,
  toLogisticsScheduleTaskInput,
} from "./logistics-driver-schedule";
import {
  loadPriorityStartWindows,
  mapPriorityType,
  priorityPenalty,
  type Priority,
  type PriorityWindows,
} from "../optimizer/priorityWindows";
import { LogisticsTaskInputWithLock } from "./phase0";
import { LogisticsPhase1Result, LogisticsSelectedDriver, LogisticsTaskCandidate } from "./phase1";
import {
  LOGISTICS_SERVICE_DURATION_MIN,
  LOGISTICS_MAX_CHECKOUT_WAIT_MIN,
  isCheckinApplicableOnWorkDate,
  isCheckoutApplicableOnWorkDate,
} from "../../../shared/logistics-scheduling-constraints";
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
const BAG_DELIVERY_DURATION_RATIO_TOLERANCE = 2 / 3;
const BAG_DELIVERY_FALLBACK_TOLERANCE_MIN = 30;
const GROUP_MAX_TASKS = 4;
const GROUP_NEARBY_THRESHOLD_MIN = 8;
const CLEANER_CLUSTER_MAX_STEP_TRAVEL_MIN = 10;
const CLEANER_CLUSTER_MAX_RADIUS_TRAVEL_MIN = 12;
const GEO_FALLBACK_MAX_STEP_TRAVEL_MIN = GROUP_NEARBY_THRESHOLD_MIN;
const GEO_FALLBACK_MAX_RADIUS_TRAVEL_MIN = 10;

/**
 * Strong-location clustering: pre-aggrega prima del geo-fallback i task che sono
 * sostanzialmente sullo stesso indirizzo, così da non spezzarli in route diverse.
 *
 * Un task è "stessa location" di un altro se:
 *  - stesso logisticCode (codice ADAM), oppure
 *  - travel stimato <= STRONG_LOCATION_TRAVEL_MAX_MIN (essenzialmente stesso punto).
 *
 * NEARBY_TASKS_TRAVEL_MAX_MIN è la soglia "media" (5 min) usata come bonus extra di
 * vicinanza nello scoring quando i task non sono identici ma molto vicini.
 *
 * MAX_STRONG_CLUSTER_SIZE limita la dimensione del cluster (cap soft per non creare
 * route troppo grandi); cluster più grandi vengono spezzati per deadline.
 */
const NEARBY_TASKS_TRAVEL_MAX_MIN = 5;
const STRONG_LOCATION_TRAVEL_MAX_MIN = 1;
const MAX_STRONG_CLUSTER_SIZE = 4;
const SAME_LOCATION_CONTINUITY_BONUS_PER_PAIR = 8;
const SAME_LOCATION_CROSS_DRIVER_SPLIT_PENALTY = 40;
const NEARBY_CONTINUITY_BONUS_PER_PAIR = 2;
const ASSIGNED_TASK_WEIGHT = 100;
const CLEANER_SEQUENCE_BREAK_PENALTY = 5;
const COMPETITIVE_TOP_N_LOOKAHEAD = 15;
const MAX_CANDIDATES_PER_TASK = 6;
const MAX_NEARBY_CANDIDATES_PER_TASK = 3;
const VERY_NEAR_PAIR_TRAVEL_MAX_MIN = 3;

/**
 * Step 4.7-bis — Candidate Fragmentation Penalty (Fix C).
 *
 * Penalizza un candidato che lascia "fuori" un fragmentation partner ancora
 * schedulabile. Rispetto alla 4.7 originale i parametri sono molto più stretti
 * per evitare di punire candidati per ogni task entro 5 min (a Milano centro
 * questo causava `fragmentationPenaltyTotal` esplosa):
 *
 * - very-near solo entro 3 min (era 5);
 * - very-near penalty 35 (era 70);
 * - cap per candidato MAX_PER_CANDIDATE = 80 → no penalità totali a 800+;
 * - very-near richiede una coppia "protetta" (mutual-nearest + feasibile),
 *   non scatta su qualunque task entro 3 min.
 *
 * Same-location resta forte (150): è il segnale corretto per non spezzare
 * 1744A/B o cluster su un addressId condiviso.
 */
const SAME_LOCATION_FRAGMENTATION_PENALTY = 150;
const SAME_LOGISTIC_CODE_FRAGMENTATION_PENALTY = 150;
const VERY_NEAR_FRAGMENTATION_MAX_TRAVEL_MIN = 3;
const VERY_NEAR_FRAGMENTATION_PENALTY = 35;
const VERY_NEAR_FRAGMENTATION_MAX_PER_CANDIDATE = 80;

/**
 * Step 4.7-bis — Route Linearity Penalty: gap weights (Fix B).
 *
 * Per stessa-address la penalty viene calcolata su `positionsByAddress` e SOLO
 * sulle coppie consecutive nell'array di posizioni (così un blocco contiguo
 * [549,761,975] tutti su 1637 paga 0). Per very-near (NON same-address) la
 * coppia (i, j) paga solo se non esiste un intermedio k anch'esso very-near a
 * taskA — evita doppi conteggi a cascata.
 */
const SAME_LOCATION_GAP_STOP_WEIGHT = 25;
const SAME_LOCATION_GAP_MIN_WEIGHT = 0.5;
const SAME_LOCATION_GAP_GRACE_MIN = 30;
const VERY_NEAR_GAP_STOP_WEIGHT = 6;
const VERY_NEAR_GAP_MIN_WEIGHT = 0.2;
const VERY_NEAR_GAP_GRACE_MIN = 45;
const VERY_NEAR_GAP_MAX_TRAVEL_MIN = 3;

/**
 * Step 4.7-bis — Nearest-Neighbor Waste (mantenuta come "smoke detector").
 */
const NEAREST_NEIGHBOR_WASTE_WEIGHT = 2;
const NEAREST_NEIGHBOR_WASTE_IGNORE_BELOW_MIN = 3;

/**
 * Step 4.7-bis — Return-to-Area (Fix D: DISABILITATA).
 *
 * Su città dense (Milano) scatta troppo spesso su pattern operativamente
 * leciti (attese check-in, micro-deviazioni) e duplica `very_near_gap`. La
 * teniamo ferma a 0 finché non vediamo, dai debug, pattern realmente non
 * catturati dal gap penalty.
 */
const RETURN_TO_AREA_ENABLED = false;
const RETURN_TO_AREA_MAX_TRAVEL_MIN = 5;
const RETURN_TO_AREA_WEIGHT = 8;

/**
 * Step 4.7-bis — Linearity penalty: bonus massimo concesso al delta negativo
 * (Fix A). Una insertion che migliora la route esistente (linearity post <
 * linearity pre) ottiene credito, ma cappato per evitare "fix mania" — il
 * planner non deve preferire patchare route brutte rispetto a costruire route
 * compatte.
 */
const ROUTE_LINEARITY_MAX_BONUS = 30;

/**
 * Slack penalty: penalizza route in cui un task resta troppo vicino al limite hard
 * (check-in, checkout wait, cleaner tolerance). Permette di preferire soluzioni
 * "robuste" rispetto a quelle che consumano tutto il margine al primo task.
 *
 * Threshold = margine sotto il quale parte la penalty (minuti).
 * Weight    = quanto pesa ogni minuto sotto threshold.
 */
const SLACK_THRESHOLD_MIN = 15;
const SLACK_CHECKIN_WEIGHT = 1.0;
const SLACK_CLEANER_WEIGHT = 1.0;
const SLACK_CHECKOUT_WAIT_WEIGHT = 0.3;

/** Magazzino / punto di partenza autisti (Via Barrili 31, Milano). */
const LOGISTICS_DEPOT_LAT = 45.434029;
const LOGISTICS_DEPOT_LNG = 9.180008;

type LogisticsPhase2ReasonCode =
  | "CHECKIN_CHECKOUT_CONSTRAINT"
  | "CLEANER_TIME_CONSTRAINT"
  | "NO_DRIVER_FEASIBLE"
  | "NO_TASK_CANDIDATES"
  | "TRULY_IMPOSSIBLE"
  | "ROUTE_CAPACITY_OR_ORDERING_CONFLICT";

interface LogisticsTaskForPhase2 extends LogisticsTaskCandidate {
  checkinDate: string | null;
  checkoutDate: string | null;
  checkinTime: string | null;
  checkoutTime: string | null;
  cleaningTime: number | null;
  cleanerId: number | null;
  cleanerStartTime: string | null;
  cleanerTaskStartTime: string | null;
  cleanerSequence: number | null;
  bagPolicy: ReturnType<typeof computeBagPolicy>;
  priorityType: Priority | null;
  premium: boolean;
  paxIn: number | null;
  /**
   * Identificativo del cluster "stesso indirizzo" calcolato globalmente sui task
   * schedulabili: due task con lo stesso addressId sono considerati alla stessa
   * location (stesso logisticCode o coordinate praticamente identiche).
   * null = nessun altro task condivide la location.
   */
  addressId: number | null;
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
  origin?:
    | "CLEANER_CLUSTER"
    | "GEOGRAPHIC_FALLBACK"
    | "SINGLETON_FALLBACK"
    | "STRONG_LOCATION_CLUSTER";
  cleanerId?: number | null;
  groupingReason?: GroupingReasonJson;
}

type CandidateType = "CLEANER_SEQUENCE" | "SAME_LOCATION" | "NEARBY_MICRO" | "SINGLETON";

interface CompetitiveCandidate {
  id: string;
  type: CandidateType;
  group: SpatialGroup;
  taskIds: number[];
  assignedTaskCount: number;
  preScore: number;
  priorityRank: number;
  compactnessScore: number;
  cleanerSequenceScore: number;
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
  competitiveGroupingEnabled?: boolean;
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
  strongLocationClusters?: number;
  strongLocationClusterTasks?: number;
  addressGroupsDetected?: number;
  competitiveCandidatesGenerated?: number;
  competitiveCandidatesSelectedByType?: Record<string, number>;
  cleanerClusterBeatenBySameLocationCount?: number;
  sameLocationBeatenByCleanerClusterCount?: number;
  sameLocationSplitAcceptedCount?: number;
  sameLocationSplitAcceptedReasons?: string[];
  candidateOverlapInvalidationCount?: number;
  avgReturnToSameAddressAfterSplitMin?: number;
  selectedCandidateScoreGapP50?: number;
  selectedCandidateScoreGapP90?: number;
  sameLocationReturnEvents?: Array<{
    addressId: number;
    logisticCode: number | null;
    taskIds: number[];
    driverIds: number[];
    sequencePositions: number[];
    minutesBetweenVisits: number;
    reason: string;
  }>;
  // Step 4.7-bis — Fragmentation + Route Linearity KPI
  fragmentationPenaltyTotal?: number;
  fragmentationPenaltyAvgPerCandidate?: number;
  fragmentationCandidatesWithPenalty?: number;
  fragmentationCandidatesCapped?: number;
  fragmentationProtectedNearPairTotal?: number;
  fragmentationEventCount?: number;
  routeLinearityDeltaTotal?: number;
  routeLinearityDeltaAppliedTotal?: number;
  routeLinearityDeltaBonusAppliedCount?: number;
  routeLinearityEventCount?: number;
}

interface LogisticsPhase2PerformanceStats {
  scheduleBuildCount: number;
  scheduleBuildElapsedMs: number;
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
  details?: Record<string, unknown>;
}

interface GroupSimulationResult {
  feasible: boolean;
  /** Schedule rows of the NEW tasks added by this group (used by debug/logging). */
  assignments: LogisticsTaskSchedule[];
  /** Full schedule of the driver route after applying this group (existing + new, reordered). */
  fullRouteAssignments: LogisticsTaskSchedule[];
  /** Position in the existing ordered route where the new block was inserted (0 = front, len = append). */
  insertIndex: number;
  /** Total travel minutes of the full simulated route. */
  fullRouteTravelMinutes: number;
  projectedClockMin: number;
  projectedLastLat: number | null;
  projectedLastLng: number | null;
  projectedCleanerLastSequence: Map<number, number>;
  /** fullRouteTravelMinutes - state.totalTravelMinutes (can be negative when insertion shortens the route). */
  travelMinutesDelta: number;
  score: number;
  failure: FeasibilityFailure | null;
  /**
   * Step 4.7-bis (Fix A) — Route Linearity DELTA actually subtracted from
   * `score` (after `before` baseline + bonus cap). Can be negative if the
   * insertion improved the existing route shape.
   */
  routeLinearityBefore?: number;
  routeLinearityAfter?: number;
  routeLinearityDelta?: number;
  routeLinearityDeltaApplied?: number;
  routeLinearitySameOrNearGapPenalty?: number;
  routeLinearityNearestNeighborWastePenalty?: number;
  routeLinearityReturnToAreaPenalty?: number;
  routeLinearityEvents?: RouteLinearityEvent[];
}

interface SimulationOptions {
  /**
   * When true, the new block of tasks is tried at every position of the existing route
   * (best-insertion). When false (default) the block is only appended at the end —
   * cheaper, used by look-ahead/heuristic estimators.
   */
  allowInsertion?: boolean;
  /**
   * Step 4.7-bis — travel matrix precomputata sui task schedulabili. Usata
   * dalle route linearity / fragmentation per evitare N×N
   * `estimateCarTravelMinutes` a ogni simulazione. Se assente, gli helper
   * fallano sulla stima live.
   */
  travelMatrix?: TravelMatrix;
}

/**
 * Step 4.7-bis — Travel matrix simmetrica (taskIdA, taskIdB) -> travelMin,
 * costruita una sola volta in `runLogisticsPhase2`.
 */
type TravelMatrix = Map<string, number>;

interface FragmentationEvent {
  candidateId: string;
  taskId: number;
  otherTaskId: number;
  reason: "same_location" | "same_logistic_code" | "very_near";
  travelMin?: number;
  penalty: number;
}

interface FragmentationResult {
  penalty: number;
  rawPenalty: number;
  cappedByMax: boolean;
  events: FragmentationEvent[];
  protectedNearPairCount: number;
}

interface RouteLinearityEvent {
  driverId?: number;
  taskIdA: number;
  taskIdB: number;
  reason:
    | "same_location_gap"
    | "very_near_gap"
    | "nearest_neighbor_waste"
    | "return_to_area";
  gapStops?: number;
  gapMinutes?: number;
  travelMin?: number;
  penalty: number;
}

interface RouteLinearityResult {
  totalPenalty: number;
  sameOrNearGapPenalty: number;
  nearestNeighborWastePenalty: number;
  returnToAreaPenalty: number;
  events: RouteLinearityEvent[];
}

interface PartialGroupSimulationChoice {
  assignedGroup: SpatialGroup;
  remainingGroup: SpatialGroup | null;
  state: DriverState;
  simulation: GroupSimulationResult;
}

interface RepairRouteSimulationResult {
  feasible: boolean;
  assignments: LogisticsTaskSchedule[];
  projectedClockMin: number;
  projectedLastLat: number | null;
  projectedLastLng: number | null;
  projectedCleanerLastSequence: Map<number, number>;
  totalTravelMinutes: number;
  insertedTaskSchedule: LogisticsTaskSchedule | null;
  failure: FeasibilityFailure | null;
}

interface RepairInsertionCandidate {
  state: DriverState;
  simulation: RepairRouteSimulationResult;
  insertIndex: number;
  cost: number;
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
    performanceStats?: LogisticsPhase2PerformanceStats;
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

function buildScheduleWithMetrics(
  args: Parameters<typeof buildLogisticsScheduleForDriver>[0],
  performanceStats: LogisticsPhase2PerformanceStats
): ReturnType<typeof buildLogisticsScheduleForDriver> {
  const startedAt = Date.now();
  const built = buildLogisticsScheduleForDriver(args);
  performanceStats.scheduleBuildCount += 1;
  performanceStats.scheduleBuildElapsedMs += Math.max(0, Date.now() - startedAt);
  return built;
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

function resolveBagDeliveryToleranceMin(task: LogisticsTaskForPhase2): number {
  const taskDurationMin = Number(task.cleaningTime);
  if (Number.isFinite(taskDurationMin) && taskDurationMin > 0) {
    return Math.ceil(taskDurationMin * BAG_DELIVERY_DURATION_RATIO_TOLERANCE);
  }
  return BAG_DELIVERY_FALLBACK_TOLERANCE_MIN;
}

/**
 * Vincolo cleaner:
 * - NORMAL_TASK / DRIVER_BRINGS_BAG: il task logistico può iniziare entro una tolleranza
 *   rispetto all'inizio HK (2/3 durata task, fallback 30').
 * - CLEANER_HAS_BAG: solo ritiro sporco (deadline su checkout), senza consegna borsone.
 */
function getCleanerViolation(task: LogisticsTaskForPhase2, taskStartMin: number): boolean {
  const cleanerReferenceTime = getCleanerDeadlineForBagDelivery(task);
  if (!cleanerReferenceTime) return false;
  const cleanerStartMin = parseMinutes(cleanerReferenceTime, 23 * 60 + 59);
  const toleranceMin = resolveBagDeliveryToleranceMin(task);
  return taskStartMin > cleanerStartMin + toleranceMin;
}

function getCleanerFailureDetails(
  task: LogisticsTaskForPhase2,
  row: { startTime: string; endTime: string; startMin: number } | null
): Record<string, unknown> | undefined {
  const cleanerReferenceTime = getCleanerDeadlineForBagDelivery(task);
  if (!cleanerReferenceTime || !row) return undefined;
  const cleanerReferenceMin = parseMinutes(cleanerReferenceTime, 23 * 60 + 59);
  const toleranceMin = resolveBagDeliveryToleranceMin(task);
  const latestAllowedStartMin = cleanerReferenceMin + toleranceMin;
  return {
    reason: "CLEANER_TIME_CONSTRAINT",
    cleanerReferenceTime,
    toleranceMin,
    latestAllowedStartTime: toHHMM(latestAllowedStartMin),
    simulatedStart: row.startTime,
    simulatedEnd: row.endTime,
    overflowMin: Math.max(0, row.startMin - latestAllowedStartMin),
  };
}

function getCleanerDeadlineForBagDelivery(task: LogisticsTaskForPhase2): string | null {
  if (!requiresDriverBeforeCleaner(task.bagPolicy)) return null;
  return task.cleanerTaskStartTime ?? task.cleanerStartTime;
}

/**
 * Penalità di "fragilità" per un singolo task all'interno della route simulata.
 * Per ogni vincolo hard attivo sul task (check-in nel workDate, checkout wait,
 * cleaner tolerance con borsone) misura il margine residuo e penalizza linearmente
 * la quota sotto soglia (capped a `SLACK_THRESHOLD_MIN`).
 *
 * Restituisce 0 se il task non ha vincoli applicabili o se tutti i margini sono >= soglia.
 */
function computeTaskSlackPenalty(
  task: LogisticsTaskForPhase2,
  row: { startMin: number; endMin: number; checkoutWaitMinutes: number },
  workDate: string
): number {
  let penalty = 0;

  // Check-in: il task deve finire prima del check-in. Margine = checkin - end.
  if (isCheckinApplicableOnWorkDate(task.checkinDate, workDate) && task.checkinTime) {
    const checkinMin = parseMinutes(task.checkinTime, 23 * 60 + 59);
    const margin = checkinMin - row.endMin;
    if (margin < SLACK_THRESHOLD_MIN) {
      const deficit = Math.max(0, Math.min(SLACK_THRESHOLD_MIN, SLACK_THRESHOLD_MIN - margin));
      penalty += deficit * SLACK_CHECKIN_WEIGHT;
    }
  }

  // Checkout wait: il driver non può attendere oltre LOGISTICS_MAX_CHECKOUT_WAIT_MIN.
  // Margine = max_wait - actual_wait.
  if (isCheckoutApplicableOnWorkDate(task.checkoutTime, task.checkoutDate, workDate)) {
    const margin = LOGISTICS_MAX_CHECKOUT_WAIT_MIN - row.checkoutWaitMinutes;
    if (margin < SLACK_THRESHOLD_MIN) {
      const deficit = Math.max(0, Math.min(SLACK_THRESHOLD_MIN, SLACK_THRESHOLD_MIN - margin));
      penalty += deficit * SLACK_CHECKOUT_WAIT_WEIGHT;
    }
  }

  // Cleaner tolerance (solo se il driver deve arrivare prima del cleaner).
  // Margine = (cleanerRef + tolerance) - start: il borsone è disponibile
  // quando il driver arriva, non quando termina i 15 minuti di servizio.
  const cleanerReferenceTime = getCleanerDeadlineForBagDelivery(task);
  if (cleanerReferenceTime) {
    const cleanerMin = parseMinutes(cleanerReferenceTime, 23 * 60 + 59);
    const toleranceMin = resolveBagDeliveryToleranceMin(task);
    const latestAllowed = cleanerMin + toleranceMin;
    const margin = latestAllowed - row.startMin;
    if (margin < SLACK_THRESHOLD_MIN) {
      const deficit = Math.max(0, Math.min(SLACK_THRESHOLD_MIN, SLACK_THRESHOLD_MIN - margin));
      penalty += deficit * SLACK_CLEANER_WEIGHT;
    }
  }

  return penalty;
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
      cleaningTime: taskData?.cleaningTime ?? null,
      cleanerId: taskData?.cleanerId ?? null,
      cleanerStartTime: taskData?.cleanerStartTime ?? null,
      cleanerTaskStartTime: taskData?.cleanerTaskStartTime ?? null,
      cleanerSequence: taskData?.cleanerSequence ?? null,
      bagPolicy,
      priorityType: mapPriorityType(candidate.priority),
      premium: taskData?.premium === true,
      paxIn: taskData?.paxIn ?? null,
      addressId: null,
    };
  });
}

/**
 * Due task condividono la stessa "address" se:
 *  - hanno lo stesso logisticCode (codice ADAM), oppure
 *  - sono praticamente alla stessa posizione (travel <= STRONG_LOCATION_TRAVEL_MAX_MIN).
 */
function areTasksAtSameAddress(a: LogisticsTaskForPhase2, b: LogisticsTaskForPhase2): boolean {
  if (
    Number.isFinite(a.logisticCode) &&
    Number.isFinite(b.logisticCode) &&
    a.logisticCode > 0 &&
    b.logisticCode > 0 &&
    a.logisticCode === b.logisticCode
  ) {
    return true;
  }
  const travel = estimateCarTravelMinutes(
    { lat: a.lat, lng: a.lng },
    { lat: b.lat, lng: b.lng }
  );
  return travel <= STRONG_LOCATION_TRAVEL_MAX_MIN;
}

/**
 * Versione "nearby" (più rilassata) per il bonus di scoring: due task sono vicini se
 * il travel stimato è entro NEARBY_TASKS_TRAVEL_MAX_MIN. Non implica stessa address.
 */
function areTasksNearby(a: LogisticsTaskForPhase2, b: LogisticsTaskForPhase2): boolean {
  if (areTasksAtSameAddress(a, b)) return true;
  const travel = estimateCarTravelMinutes(
    { lat: a.lat, lng: a.lng },
    { lat: b.lat, lng: b.lng }
  );
  return travel <= NEARBY_TASKS_TRAVEL_MAX_MIN;
}

// ============================================================================
// Step 4.7-bis — Travel matrix + location helpers
// ============================================================================

/** Chiave canonica simmetrica per la travel matrix. */
function travelMatrixKey(taskIdA: number, taskIdB: number): string {
  return taskIdA < taskIdB ? `${taskIdA}|${taskIdB}` : `${taskIdB}|${taskIdA}`;
}

/**
 * Precomputa la travel matrix simmetrica O(N²/2) sui task schedulabili in
 * una singola passata. Le helper di fragmentation / route linearity sono
 * O(N²) per simulazione: senza matrix farebbero N² stime live ogni round.
 */
function buildTravelMatrix(tasks: LogisticsTaskForPhase2[]): TravelMatrix {
  const matrix: TravelMatrix = new Map();
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const t = estimateCarTravelMinutes(
        { lat: tasks[i].lat, lng: tasks[i].lng },
        { lat: tasks[j].lat, lng: tasks[j].lng }
      );
      matrix.set(travelMatrixKey(tasks[i].taskId, tasks[j].taskId), t);
    }
  }
  return matrix;
}

function getTravelMinBetweenTasks(
  a: LogisticsTaskForPhase2,
  b: LogisticsTaskForPhase2,
  travelMatrix?: TravelMatrix
): number {
  if (a.taskId === b.taskId) return 0;
  if (travelMatrix) {
    const cached = travelMatrix.get(travelMatrixKey(a.taskId, b.taskId));
    if (cached != null) return cached;
  }
  return estimateCarTravelMinutes(
    { lat: a.lat, lng: a.lng },
    { lat: b.lat, lng: b.lng }
  );
}

/**
 * Step 4.7-bis — due task condividono la stessa "strong location" se il
 * cluster address-id globale (popolato da populateAddressIds, che fonde già
 * logisticCode + coordinate praticamente identiche) coincide.
 */
function haveSameStrongLocation(
  a: LogisticsTaskForPhase2,
  b: LogisticsTaskForPhase2
): boolean {
  if (a.taskId === b.taskId) return false;
  if (a.addressId == null || b.addressId == null) return false;
  return a.addressId === b.addressId;
}

/**
 * Step 4.7-bis — due task sono "very near" se NON sono già same-address e il
 * travel è entro la soglia. L'esclusione esplicita delle strong-location
 * evita doppi conteggi a cavallo tra le due dimensioni.
 */
function areVeryNearTasks(
  a: LogisticsTaskForPhase2,
  b: LogisticsTaskForPhase2,
  travelMatrix?: TravelMatrix,
  maxMin: number = VERY_NEAR_FRAGMENTATION_MAX_TRAVEL_MIN
): boolean {
  if (a.taskId === b.taskId) return false;
  if (haveSameStrongLocation(a, b)) return false;
  return getTravelMinBetweenTasks(a, b, travelMatrix) <= maxMin;
}

// ============================================================================
// Step 4.7-bis (Fix C) — Mutual-nearest helper.
//
// Una coppia (A, B) è "mutual-nearest" se:
//  - B è il task PIÙ VICINO ad A nel pool dei `eligibleTasks` (escludendo A),
//  - A è il task PIÙ VICINO a B nel pool dei `eligibleTasks` (escludendo B).
//
// Senza questo filtro, very-near fragmentation scattava su ogni task entro
// VERY_NEAR_FRAGMENTATION_MAX_TRAVEL_MIN min, esplodendo in città dense
// (Milano: tipicamente 5-10 partner per task). Con mutual-nearest la coppia
// è "naturalmente legata" e merita protezione.
// ============================================================================

function getNearestTaskWithin(
  task: LogisticsTaskForPhase2,
  pool: LogisticsTaskForPhase2[],
  maxMin: number,
  travelMatrix?: TravelMatrix,
  excludeTaskId?: number
): LogisticsTaskForPhase2 | null {
  let best: LogisticsTaskForPhase2 | null = null;
  let bestTravel = Number.POSITIVE_INFINITY;
  for (const candidate of pool) {
    if (candidate.taskId === task.taskId) continue;
    if (excludeTaskId != null && candidate.taskId === excludeTaskId) continue;
    if (haveSameStrongLocation(task, candidate)) continue;
    const travel = getTravelMinBetweenTasks(task, candidate, travelMatrix);
    if (travel > maxMin) continue;
    if (travel < bestTravel) {
      bestTravel = travel;
      best = candidate;
    }
  }
  return best;
}

function isMutualNearestPair(
  a: LogisticsTaskForPhase2,
  b: LogisticsTaskForPhase2,
  eligibleTasks: LogisticsTaskForPhase2[],
  maxMin: number,
  travelMatrix?: TravelMatrix
): boolean {
  const nearestOfA = getNearestTaskWithin(a, eligibleTasks, maxMin, travelMatrix);
  if (!nearestOfA || nearestOfA.taskId !== b.taskId) return false;
  const nearestOfB = getNearestTaskWithin(b, eligibleTasks, maxMin, travelMatrix);
  if (!nearestOfB || nearestOfB.taskId !== a.taskId) return false;
  return true;
}

// ============================================================================
// Step 4.7-bis (Fix C) — Candidate Fragmentation Penalty.
//
// Punisce un candidato che lascia "fuori" un fragmentation partner ancora
// schedulabile.
//
// Same-location: penalità forte (150) → un cluster su stesso addressId NON
// deve essere spezzato (caso 1744A/B).
// Very-near: penalità BLANDA (35) e solo se la coppia è PROTETTA:
//   - travel <= 3 min
//   - mutual-nearest sul pool dei feasible partner
//
// In più: cap MAX_PER_CANDIDATE = 80 sulla penalty very-near totale, così un
// cluster da 4 con 3 partner ciascuno non paga 4×3×35 = 420.
//
// Dedup per coppia (un partner contato 1 volta anche se sta vicino a più
// task del candidato).
// ============================================================================

function calculateCandidateFragmentationPenalty(args: {
  candidate: CompetitiveCandidate;
  remainingTasks: LogisticsTaskForPhase2[];
  taskById: Map<number, LogisticsTaskForPhase2>;
  travelMatrix?: TravelMatrix;
  feasibleTaskIds?: Set<number>;
}): FragmentationResult {
  const candidateTaskIds = new Set(args.candidate.taskIds);
  let sameLocationPenalty = 0;
  let veryNearPenalty = 0;
  const events: FragmentationEvent[] = [];
  const seenPairs = new Set<string>();
  let protectedNearPairCount = 0;

  // Pool dei partner valutabili: task non nel candidato + ancora feasibili.
  const partnerPool = args.remainingTasks.filter((other) => {
    if (candidateTaskIds.has(other.taskId)) return false;
    if (args.feasibleTaskIds && !args.feasibleTaskIds.has(other.taskId)) return false;
    return true;
  });

  // Pool per la mutual-nearest: include anche i task del candidato così che
  // il "nearest" di un partner possa essere un task dentro al candidato (è
  // proprio questo che lo rende "protetto" per quel candidato).
  const mutualPool = args.remainingTasks.filter((task) => {
    if (args.feasibleTaskIds && !args.feasibleTaskIds.has(task.taskId)) return false;
    return true;
  });

  for (const taskId of args.candidate.taskIds) {
    const task = args.taskById.get(taskId);
    if (!task) continue;

    for (const other of partnerPool) {
      if (other.taskId === task.taskId) continue;

      const pairKey =
        task.taskId < other.taskId
          ? `${task.taskId}|${other.taskId}`
          : `${other.taskId}|${task.taskId}`;
      if (seenPairs.has(pairKey)) continue;

      if (haveSameStrongLocation(task, other)) {
        seenPairs.add(pairKey);
        const sameLogisticCode =
          Number.isFinite(task.logisticCode) &&
          Number.isFinite(other.logisticCode) &&
          task.logisticCode > 0 &&
          task.logisticCode === other.logisticCode;
        const pairPenalty = sameLogisticCode
          ? SAME_LOGISTIC_CODE_FRAGMENTATION_PENALTY
          : SAME_LOCATION_FRAGMENTATION_PENALTY;
        sameLocationPenalty += pairPenalty;
        events.push({
          candidateId: args.candidate.id,
          taskId: task.taskId,
          otherTaskId: other.taskId,
          reason: sameLogisticCode ? "same_logistic_code" : "same_location",
          penalty: pairPenalty,
        });
        continue;
      }

      // Very-near: applica solo se la coppia è PROTETTA (mutual-nearest).
      if (!areVeryNearTasks(task, other, args.travelMatrix, VERY_NEAR_FRAGMENTATION_MAX_TRAVEL_MIN)) {
        continue;
      }
      if (
        !isMutualNearestPair(
          task,
          other,
          mutualPool,
          VERY_NEAR_FRAGMENTATION_MAX_TRAVEL_MIN,
          args.travelMatrix
        )
      ) {
        continue;
      }

      seenPairs.add(pairKey);
      protectedNearPairCount += 1;
      veryNearPenalty += VERY_NEAR_FRAGMENTATION_PENALTY;
      events.push({
        candidateId: args.candidate.id,
        taskId: task.taskId,
        otherTaskId: other.taskId,
        reason: "very_near",
        travelMin: getTravelMinBetweenTasks(task, other, args.travelMatrix),
        penalty: VERY_NEAR_FRAGMENTATION_PENALTY,
      });
    }
  }

  // Cap separato sulla sola componente very-near: same-location rimane senza
  // cap perché è il segnale forte che NON vogliamo attenuare.
  const veryNearCapped = Math.min(veryNearPenalty, VERY_NEAR_FRAGMENTATION_MAX_PER_CANDIDATE);
  const rawPenalty = sameLocationPenalty + veryNearPenalty;
  const penalty = sameLocationPenalty + veryNearCapped;

  return {
    penalty,
    rawPenalty,
    cappedByMax: veryNearPenalty > VERY_NEAR_FRAGMENTATION_MAX_PER_CANDIDATE,
    events,
    protectedNearPairCount,
  };
}

// ============================================================================
// Step 4.7-bis (Fix B) — Route Linearity: Same-or-Near Gap Penalty.
//
// Same-address: usa `positionsByAddress` e penalizza SOLO le posizioni
// consecutive nell'array (no false positive su blocchi contigui 1637 1637 1637).
//
// Very-near (non same-address): per ogni task A, penalizza la coppia (A, B)
// solo se NON esiste un intermedio K (i<k<j) che sia ANCH'ESSO very-near a A.
// In pratica: si paga solo il "salto al prossimo very-near", non ogni coppia.
// ============================================================================

function calculateSameOrNearGapPenalty(
  route: LogisticsTaskSchedule[],
  taskById: Map<number, LogisticsTaskForPhase2>,
  travelMatrix?: TravelMatrix
): { penalty: number; events: RouteLinearityEvent[] } {
  let penalty = 0;
  const events: RouteLinearityEvent[] = [];

  // ---- Same-address (positions approach: contiguous blocks pay 0) -----------
  const positionsByAddress = new Map<number, number[]>();
  for (let i = 0; i < route.length; i++) {
    const task = taskById.get(route[i].taskId);
    if (!task || task.addressId == null) continue;
    if (!positionsByAddress.has(task.addressId)) positionsByAddress.set(task.addressId, []);
    positionsByAddress.get(task.addressId)!.push(i);
  }

  for (const positions of positionsByAddress.values()) {
    if (positions.length < 2) continue;
    for (let k = 1; k < positions.length; k++) {
      const idxPrev = positions[k - 1];
      const idxCur = positions[k];
      const gapStops = idxCur - idxPrev - 1;
      if (gapStops <= 0) continue; // blocco contiguo = 0 penalty

      const startCur = parseMinutes(route[idxCur].startTime, 0);
      const endPrev = parseMinutes(route[idxPrev].endTime, 0);
      const gapMinutes = Math.max(0, startCur - endPrev);

      let pairPenalty = gapStops * SAME_LOCATION_GAP_STOP_WEIGHT;
      if (gapMinutes > SAME_LOCATION_GAP_GRACE_MIN) {
        pairPenalty += (gapMinutes - SAME_LOCATION_GAP_GRACE_MIN) * SAME_LOCATION_GAP_MIN_WEIGHT;
      }
      penalty += pairPenalty;
      events.push({
        taskIdA: route[idxPrev].taskId,
        taskIdB: route[idxCur].taskId,
        reason: "same_location_gap",
        gapStops,
        gapMinutes,
        penalty: pairPenalty,
      });
    }
  }

  // ---- Very-near (skip se esiste un intermedio anch'esso very-near) --------
  for (let i = 0; i < route.length; i++) {
    const taskA = taskById.get(route[i].taskId);
    if (!taskA) continue;

    for (let j = i + 1; j < route.length; j++) {
      const taskB = taskById.get(route[j].taskId);
      if (!taskB) continue;
      const gapStops = j - i - 1;
      if (gapStops <= 0) continue;
      if (haveSameStrongLocation(taskA, taskB)) continue; // già coperta sopra
      if (!areVeryNearTasks(taskA, taskB, travelMatrix, VERY_NEAR_GAP_MAX_TRAVEL_MIN)) continue;

      // Salta se esiste un intermedio K che è anch'esso very-near di A: vuol
      // dire che (A, B) non è il "prossimo very-near", quindi non va contato.
      let hasIntermediateVeryNear = false;
      for (let k = i + 1; k < j; k++) {
        const taskK = taskById.get(route[k].taskId);
        if (!taskK) continue;
        if (areVeryNearTasks(taskA, taskK, travelMatrix, VERY_NEAR_GAP_MAX_TRAVEL_MIN)) {
          hasIntermediateVeryNear = true;
          break;
        }
      }
      if (hasIntermediateVeryNear) continue;

      const startB = parseMinutes(route[j].startTime, 0);
      const endA = parseMinutes(route[i].endTime, 0);
      const gapMinutes = Math.max(0, startB - endA);

      let pairPenalty = gapStops * VERY_NEAR_GAP_STOP_WEIGHT;
      if (gapMinutes > VERY_NEAR_GAP_GRACE_MIN) {
        pairPenalty += (gapMinutes - VERY_NEAR_GAP_GRACE_MIN) * VERY_NEAR_GAP_MIN_WEIGHT;
      }
      penalty += pairPenalty;
      events.push({
        taskIdA: taskA.taskId,
        taskIdB: taskB.taskId,
        reason: "very_near_gap",
        gapStops,
        gapMinutes,
        travelMin: getTravelMinBetweenTasks(taskA, taskB, travelMatrix),
        penalty: pairPenalty,
      });
    }
  }

  return { penalty, events };
}

/**
 * Step 4.7-bis — Nearest-Neighbor Waste (smoke detector).
 *
 * Per ciascuna transizione i→i+1, se nella route futura esiste un task
 * ancora più vicino al corrente di quello effettivamente scelto, registra
 * la differenza come "occasione persa". Penalty bassa (×2) perché il
 * best-insertion già tende a evitare questi pattern.
 */
function calculateNearestNeighborWastePenalty(
  route: LogisticsTaskSchedule[],
  taskById: Map<number, LogisticsTaskForPhase2>,
  travelMatrix?: TravelMatrix
): { penalty: number; events: RouteLinearityEvent[] } {
  let penalty = 0;
  const events: RouteLinearityEvent[] = [];

  for (let i = 0; i < route.length - 1; i++) {
    const current = taskById.get(route[i].taskId);
    const next = taskById.get(route[i + 1].taskId);
    if (!current || !next) continue;

    const actualTravel = getTravelMinBetweenTasks(current, next, travelMatrix);
    let nearestFutureTravel: number | null = null;
    let nearestFutureTaskId: number | null = null;

    for (let j = i + 2; j < route.length; j++) {
      const future = taskById.get(route[j].taskId);
      if (!future) continue;
      const t = getTravelMinBetweenTasks(current, future, travelMatrix);
      if (nearestFutureTravel == null || t < nearestFutureTravel) {
        nearestFutureTravel = t;
        nearestFutureTaskId = future.taskId;
      }
    }

    if (nearestFutureTravel == null) continue;
    if (nearestFutureTravel > NEAREST_NEIGHBOR_WASTE_IGNORE_BELOW_MIN) continue;

    const waste = actualTravel - nearestFutureTravel;
    if (waste <= 0) continue;

    const pairPenalty = waste * NEAREST_NEIGHBOR_WASTE_WEIGHT;
    penalty += pairPenalty;
    events.push({
      taskIdA: current.taskId,
      taskIdB: nearestFutureTaskId ?? next.taskId,
      reason: "nearest_neighbor_waste",
      gapStops: 1,
      travelMin: nearestFutureTravel,
      penalty: pairPenalty,
    });
  }

  return { penalty, events };
}

/**
 * Step 4.7-bis (Fix D) — Return-to-Area: DISABILITATA via RETURN_TO_AREA_ENABLED=false.
 *
 * In città dense scattava troppo spesso su pattern leciti (attese check-in) e
 * duplicava `very_near_gap`. La logica resta presente per riattivazione futura.
 */
function calculateReturnToAreaPenalty(
  route: LogisticsTaskSchedule[],
  taskById: Map<number, LogisticsTaskForPhase2>,
  travelMatrix?: TravelMatrix
): { penalty: number; events: RouteLinearityEvent[] } {
  if (!RETURN_TO_AREA_ENABLED) return { penalty: 0, events: [] };

  let penalty = 0;
  const events: RouteLinearityEvent[] = [];
  for (let j = 2; j < route.length; j++) {
    const current = taskById.get(route[j].taskId);
    if (!current) continue;
    for (let i = 0; i < j - 1; i++) {
      const previous = taskById.get(route[i].taskId);
      if (!previous) continue;
      const travelBack = getTravelMinBetweenTasks(current, previous, travelMatrix);
      if (travelBack > RETURN_TO_AREA_MAX_TRAVEL_MIN) continue;
      const gapStops = j - i - 1;
      if (gapStops <= 0) continue;
      const startJ = parseMinutes(route[j].startTime, 0);
      const endI = parseMinutes(route[i].endTime, 0);
      const minutesBetween = Math.max(0, startJ - endI);

      let pairPenalty = gapStops * RETURN_TO_AREA_WEIGHT;
      if (minutesBetween > 60) {
        pairPenalty += Math.min(40, (minutesBetween - 60) * 0.2);
      }
      penalty += pairPenalty;
      events.push({
        taskIdA: previous.taskId,
        taskIdB: current.taskId,
        reason: "return_to_area",
        gapStops,
        gapMinutes: minutesBetween,
        travelMin: travelBack,
        penalty: pairPenalty,
      });
    }
  }
  return { penalty, events };
}

function calculateRouteLinearityPenalty(args: {
  route: LogisticsTaskSchedule[];
  taskById: Map<number, LogisticsTaskForPhase2>;
  travelMatrix?: TravelMatrix;
}): RouteLinearityResult {
  const gap = calculateSameOrNearGapPenalty(args.route, args.taskById, args.travelMatrix);
  const waste = calculateNearestNeighborWastePenalty(args.route, args.taskById, args.travelMatrix);
  const back = calculateReturnToAreaPenalty(args.route, args.taskById, args.travelMatrix);
  return {
    totalPenalty: gap.penalty + waste.penalty + back.penalty,
    sameOrNearGapPenalty: gap.penalty,
    nearestNeighborWastePenalty: waste.penalty,
    returnToAreaPenalty: back.penalty,
    events: [...gap.events, ...waste.events, ...back.events],
  };
}

/**
 * Popola in-place il campo `addressId` sui task: due task con lo stesso addressId sono
 * considerati alla stessa location. Implementazione union-find sul predicato
 * `areTasksAtSameAddress` ristretta a coppie con lo stesso logisticCode oppure
 * vicine entro NEARBY_TASKS_TRAVEL_MAX_MIN (filtro di costo).
 * Ritorna il numero di address-group con >=2 membri rilevati.
 */
function populateAddressIds(tasks: LogisticsTaskForPhase2[]): number {
  const n = tasks.length;
  if (n === 0) return 0;

  const parent = new Array<number>(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let cur = x;
    while (parent[cur] !== cur) {
      parent[cur] = parent[parent[cur]];
      cur = parent[cur];
    }
    return cur;
  };
  const union = (x: number, y: number): void => {
    const px = find(x);
    const py = find(y);
    if (px !== py) parent[px] = py;
  };

  // Fast pass: coppie con stesso logisticCode (O(N) tramite hashmap).
  const byLogisticCode = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const lc = tasks[i].logisticCode;
    if (!Number.isFinite(lc) || lc <= 0) continue;
    if (!byLogisticCode.has(lc)) byLogisticCode.set(lc, []);
    byLogisticCode.get(lc)!.push(i);
  }
  for (const indices of byLogisticCode.values()) {
    for (let k = 1; k < indices.length; k++) {
      union(indices[0], indices[k]);
    }
  }

  // Slow pass: coppie geograficamente vicinissime (O(N^2) sul predicato esatto).
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (find(i) === find(j)) continue;
      if (areTasksAtSameAddress(tasks[i], tasks[j])) {
        union(i, j);
      }
    }
  }

  // Conta dimensioni delle componenti e assegna addressId ai gruppi >= 2.
  const componentSize = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    componentSize.set(root, (componentSize.get(root) ?? 0) + 1);
  }

  const rootToAddressId = new Map<number, number>();
  let nextAddressId = 0;
  let addressGroupCount = 0;
  for (const [root, size] of componentSize.entries()) {
    if (size < 2) continue;
    rootToAddressId.set(root, nextAddressId++);
    addressGroupCount += 1;
  }

  for (let i = 0; i < n; i++) {
    const root = find(i);
    const id = rootToAddressId.get(root);
    tasks[i].addressId = id ?? null;
  }

  return addressGroupCount;
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

function getHardDeadlineMin(task: LogisticsTaskForPhase2, workDate: string): number {
  const deadlines: number[] = [];
  const cleanerDeadline = getCleanerDeadlineForBagDelivery(task);
  if (cleanerDeadline) {
    deadlines.push(parseMinutes(cleanerDeadline, 23 * 60 + 59) + resolveBagDeliveryToleranceMin(task));
  }
  if (isDateCompatibleWithWorkDate(task.checkinDate, workDate) && task.checkinTime) {
    deadlines.push(parseMinutes(task.checkinTime, 23 * 60 + 59));
  }
  if (isDateCompatibleWithWorkDate(task.checkoutDate, workDate) && task.checkoutTime) {
    deadlines.push(parseMinutes(task.checkoutTime, 23 * 60 + 59));
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

function buildStrongLocationGroupingReason(
  addressId: number,
  members: LogisticsTaskForPhase2[],
  chunkIndex: number,
  totalChunks: number
): GroupingReasonJson {
  const logisticCodes = Array.from(new Set(members.map((t) => t.logisticCode))).sort((a, b) => a - b);
  const reason =
    logisticCodes.length === 1
      ? `tutti i task condividono logisticCode ${logisticCodes[0]}`
      : `task praticamente alla stessa posizione (travel <= ${STRONG_LOCATION_TRAVEL_MAX_MIN} min)`;
  return {
    strategy: "STRONG_LOCATION_CLUSTER",
    summary:
      totalChunks > 1
        ? `Stesso indirizzo (addressId=${addressId}): ${members.length} task (chunk ${chunkIndex + 1}/${totalChunks})`
        : `Stesso indirizzo (addressId=${addressId}): ${members.length} task pre-aggregati`,
    details: {
      addressId,
      chunkIndex,
      totalChunks,
      reason,
      logisticCodes,
      limits: {
        maxTasksPerCluster: MAX_STRONG_CLUSTER_SIZE,
        sameLocationTravelMaxMin: STRONG_LOCATION_TRAVEL_MAX_MIN,
      },
      members: members.map((task) => ({
        taskId: task.taskId,
        logisticCode: task.logisticCode,
        lat: task.lat,
        lng: task.lng,
        priority: task.priority,
        bagPolicy: task.bagPolicy,
      })),
    },
  };
}

function compareFallbackSeedOrder(a: LogisticsTaskForPhase2, b: LogisticsTaskForPhase2, workDate: string): number {
  const deadlineDiff = getTaskDeadlineMin(a, workDate) - getTaskDeadlineMin(b, workDate);
  if (deadlineDiff !== 0) return deadlineDiff;

  const aBag = requiresDriverBeforeCleaner(a.bagPolicy) ? 0 : 1;
  const bBag = requiresDriverBeforeCleaner(b.bagPolicy) ? 0 : 1;
  if (aBag !== bBag) return aBag - bBag;

  const priorityDiff = getPriorityRank(a) - getPriorityRank(b);
  if (priorityDiff !== 0) return priorityDiff;
  return a.taskId - b.taskId;
}

/**
 * Pre-aggrega i task del pool fallback (non in cleaner-cluster) per address: due
 * task con lo stesso addressId vengono raggruppati in un unico SpatialGroup di tipo
 * STRONG_LOCATION_CLUSTER PRIMA che parta il fallback geografico, evitando di
 * spezzarli in route diverse per ordine greedy.
 *
 * - I cluster sono limitati a MAX_STRONG_CLUSTER_SIZE task; oltre quel numero si
 *   spezzano per deadline crescente, mantenendo i task più urgenti insieme.
 * - I task senza addressId (location non condivisa) tornano nel pool fallback per
 *   il successivo buildGeographicFallbackGroups, come prima.
 */
function buildStrongLocationClusters(
  fallbackTasks: LogisticsTaskForPhase2[],
  bandIndexByTaskId: Map<number, number>,
  workDate: string
): { clusters: SpatialGroup[]; remaining: LogisticsTaskForPhase2[] } {
  if (fallbackTasks.length === 0) {
    return { clusters: [], remaining: [] };
  }

  const byAddressId = new Map<number, LogisticsTaskForPhase2[]>();
  const remaining: LogisticsTaskForPhase2[] = [];
  for (const task of fallbackTasks) {
    const aid = task.addressId;
    if (aid == null) {
      remaining.push(task);
      continue;
    }
    if (!byAddressId.has(aid)) byAddressId.set(aid, []);
    byAddressId.get(aid)!.push(task);
  }

  const clusters: SpatialGroup[] = [];
  const sortedAddressIds = Array.from(byAddressId.keys()).sort((a, b) => a - b);

  for (const addressId of sortedAddressIds) {
    const members = byAddressId.get(addressId)!;
    if (members.length < 2) {
      remaining.push(...members);
      continue;
    }
    const ordered = [...members].sort((a, b) => {
      const dd = getTaskDeadlineMin(a, workDate) - getTaskDeadlineMin(b, workDate);
      if (dd !== 0) return dd;
      const aBag = requiresDriverBeforeCleaner(a.bagPolicy) ? 0 : 1;
      const bBag = requiresDriverBeforeCleaner(b.bagPolicy) ? 0 : 1;
      if (aBag !== bBag) return aBag - bBag;
      return a.taskId - b.taskId;
    });

    const chunks: LogisticsTaskForPhase2[][] = [];
    for (let i = 0; i < ordered.length; i += MAX_STRONG_CLUSTER_SIZE) {
      chunks.push(ordered.slice(i, i + MAX_STRONG_CLUSTER_SIZE));
    }

    let chunkCounter = 0;
    for (const chunk of chunks) {
      if (chunk.length < 2) {
        remaining.push(...chunk);
        chunkCounter += 1;
        continue;
      }
      clusters.push({
        groupId: `strong-location-${addressId}-${chunkCounter}`,
        seedBandIndex: getDominantBandIndex(chunk, bandIndexByTaskId),
        tasks: chunk,
        origin: "STRONG_LOCATION_CLUSTER",
        cleanerId: null,
        groupingReason: buildStrongLocationGroupingReason(addressId, chunk, chunkCounter, chunks.length),
      });
      chunkCounter += 1;
    }
  }

  return { clusters, remaining };
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
  const hasBagDeliveryUrgency = group.tasks.some((task) => requiresDriverBeforeCleaner(task.bagPolicy)) ? 0 : 1;
  // Priorità tipi gruppo (più basso = processato prima a parità di deadline):
  //  CLEANER_CLUSTER < STRONG_LOCATION_CLUSTER < GEOGRAPHIC_FALLBACK < SINGLETON_FALLBACK
  const originPriority =
    group.origin === "CLEANER_CLUSTER"
      ? 0
      : group.origin === "STRONG_LOCATION_CLUSTER"
        ? 1
        : group.origin === "GEOGRAPHIC_FALLBACK"
          ? 2
          : 3;
  const sizeScore = -group.tasks.length;
  return [earliestDeadline, hasBagDeliveryUrgency, originPriority, sizeScore, group.groupId];
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
      if (requiresDriverBeforeCleaner(singletonTask.bagPolicy)) {
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

  // Step 4.5: pre-aggrega per indirizzo identico PRIMA del geo-fallback, così i task
  // dello stesso logisticCode/posizione non vengono dispersi in route diverse.
  const strongLocation = buildStrongLocationClusters(fallbackTasks, bandIndexByTaskId, workDate);
  const strongLocationClusters = strongLocation.clusters;
  const remainingFallback = strongLocation.remaining;
  const strongLocationClusterTasks = strongLocationClusters.reduce(
    (sum, group) => sum + group.tasks.length,
    0
  );

  const geographicFallbackGroups = buildGeographicFallbackGroups(remainingFallback, bandIndexByTaskId, workDate);
  const groups = [
    ...cleanerClusters,
    ...strongLocationClusters,
    ...geographicFallbackGroups,
    ...singletonFallbackGroups,
  ].sort((a, b) => compareGroups(a, b, workDate));
  return {
    groups,
    groupingStats: {
      cleanerClusters: cleanerClusters.length,
      geographicFallbackGroups: geographicFallbackGroups.length,
      singletonFallbackTasks: singletonFallbackGroups.length,
      fallbackTasks: fallbackTasks.length + singletonFallbackGroups.length,
      strongLocationClusters: strongLocationClusters.length,
      strongLocationClusterTasks,
    },
  };
}

function isCompetitiveGroupingEnabled(explicit?: boolean): boolean {
  if (explicit === true) return true;
  if (explicit === false) return false;
  const raw = String(process.env.LOGISTICS_COMPETITIVE_GROUPING ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function getCandidatePriorityRank(tasks: LogisticsTaskForPhase2[]): number {
  return tasks.reduce((best, task) => Math.min(best, getPriorityRank(task)), 9);
}

function getCandidateCompactnessScore(tasks: LogisticsTaskForPhase2[]): number {
  if (tasks.length <= 1) return 1000;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      sum += estimateCarTravelMinutes(
        { lat: tasks[i].lat, lng: tasks[i].lng },
        { lat: tasks[j].lat, lng: tasks[j].lng }
      );
      pairs += 1;
    }
  }
  return Math.max(0, 1000 - Math.round(sum / Math.max(1, pairs)) * 10);
}

function getCandidateCleanerSequenceScore(tasks: LogisticsTaskForPhase2[]): number {
  const byCleaner = new Map<number, LogisticsTaskForPhase2[]>();
  for (const task of tasks) {
    if (task.cleanerId == null || task.cleanerSequence == null) continue;
    if (!byCleaner.has(task.cleanerId)) byCleaner.set(task.cleanerId, []);
    byCleaner.get(task.cleanerId)!.push(task);
  }
  let score = 0;
  for (const list of byCleaner.values()) {
    const ordered = [...list].sort((a, b) => (a.cleanerSequence ?? 0) - (b.cleanerSequence ?? 0));
    for (let i = 1; i < ordered.length; i++) {
      if ((ordered[i].cleanerSequence ?? 0) === (ordered[i - 1].cleanerSequence ?? 0) + 1) {
        score += 5;
      }
    }
  }
  return score;
}

function buildCandidate(
  id: string,
  type: CandidateType,
  group: SpatialGroup
): CompetitiveCandidate {
  return {
    id,
    type,
    group,
    taskIds: group.tasks.map((task) => task.taskId),
    assignedTaskCount: group.tasks.length,
    preScore: 0,
    priorityRank: getCandidatePriorityRank(group.tasks),
    compactnessScore: getCandidateCompactnessScore(group.tasks),
    cleanerSequenceScore: getCandidateCleanerSequenceScore(group.tasks),
  };
}

function buildCleanerSequenceCandidates(
  tasks: LogisticsTaskForPhase2[],
  phase1: LogisticsPhase1Result,
  workDate: string
): CompetitiveCandidate[] {
  const grouped = buildCleanerAwareGroups(tasks, phase1, workDate);
  const cleanerGroups = grouped.groups.filter((group) => group.origin === "CLEANER_CLUSTER");
  const candidates: CompetitiveCandidate[] = [];
  for (const group of cleanerGroups) {
    candidates.push(buildCandidate(`cand-cleaner-${group.groupId}`, "CLEANER_SEQUENCE", group));
    if (group.tasks.length > 2) {
      for (let i = 0; i < group.tasks.length - 1; i++) {
        const subset = group.tasks.slice(i, i + 2);
        if (subset.length < 2) continue;
        candidates.push(
          buildCandidate(`cand-cleaner-${group.groupId}-pair-${i}`, "CLEANER_SEQUENCE", {
            ...group,
            groupId: `${group.groupId}-pair-${i}`,
            tasks: subset,
          })
        );
      }
    }
  }
  return candidates;
}

function buildSameLocationCandidates(
  tasks: LogisticsTaskForPhase2[],
  bandIndexByTaskId: Map<number, number>,
  workDate: string
): CompetitiveCandidate[] {
  const byAddressId = new Map<number, LogisticsTaskForPhase2[]>();
  for (const task of tasks) {
    if (task.addressId == null) continue;
    if (!byAddressId.has(task.addressId)) byAddressId.set(task.addressId, []);
    byAddressId.get(task.addressId)!.push(task);
  }
  const candidates: CompetitiveCandidate[] = [];
  const sortedAddress = Array.from(byAddressId.keys()).sort((a, b) => a - b);
  for (const addressId of sortedAddress) {
    const members = [...(byAddressId.get(addressId) ?? [])].sort((a, b) => {
      const dd = getTaskDeadlineMin(a, workDate) - getTaskDeadlineMin(b, workDate);
      if (dd !== 0) return dd;
      return a.taskId - b.taskId;
    });
    if (members.length < 2) continue;
    const baseGroup: SpatialGroup = {
      groupId: `same-location-${addressId}`,
      seedBandIndex: getDominantBandIndex(members, bandIndexByTaskId),
      tasks: members,
      origin: "STRONG_LOCATION_CLUSTER",
      cleanerId: null,
      groupingReason: buildStrongLocationGroupingReason(addressId, members, 0, 1),
    };
    candidates.push(buildCandidate(`cand-same-${addressId}-full`, "SAME_LOCATION", baseGroup));
    for (let i = 0; i < members.length - 1; i++) {
      const pair = members.slice(i, i + 2);
      if (pair.length < 2) continue;
      candidates.push(
        buildCandidate(`cand-same-${addressId}-pair-${i}`, "SAME_LOCATION", {
          ...baseGroup,
          groupId: `same-location-${addressId}-pair-${i}`,
          tasks: pair,
        })
      );
    }
  }
  return candidates;
}

function buildNearbyMicroCandidates(
  tasks: LogisticsTaskForPhase2[],
  bandIndexByTaskId: Map<number, number>
): CompetitiveCandidate[] {
  const candidates: CompetitiveCandidate[] = [];
  const byTaskCounter = new Map<number, number>();
  const sorted = [...tasks].sort((a, b) => a.taskId - b.taskId);
  for (let i = 0; i < sorted.length; i++) {
    const seed = sorted[i];
    const nearby: Array<{ task: LogisticsTaskForPhase2; travelMin: number }> = [];
    for (let j = 0; j < sorted.length; j++) {
      if (i === j) continue;
      const candidateTask = sorted[j];
      if (!areTasksNearby(seed, candidateTask)) continue;
      const travelMin = estimateCarTravelMinutes(
        { lat: seed.lat, lng: seed.lng },
        { lat: candidateTask.lat, lng: candidateTask.lng }
      );
      nearby.push({ task: candidateTask, travelMin });
    }
    // Ordina i candidati nearby per distanza reale (poi urgenza, poi taskId),
    // così i pair più compatti non vengono esclusi dal cap top-K.
    nearby.sort((a, b) => {
      if (a.travelMin !== b.travelMin) return a.travelMin - b.travelMin;
      const deadlineDiff = getTaskDeadlineMin(a.task) - getTaskDeadlineMin(b.task);
      if (deadlineDiff !== 0) return deadlineDiff;
      return a.task.taskId - b.task.taskId;
    });
    for (const near of nearby) {
      if ((byTaskCounter.get(seed.taskId) ?? 0) >= MAX_NEARBY_CANDIDATES_PER_TASK) break;
      const candidateTask = near.task;
      const groupTasks = [seed, candidateTask];
      const group: SpatialGroup = {
        groupId: `nearby-${seed.taskId}-${candidateTask.taskId}`,
        seedBandIndex: getDominantBandIndex(groupTasks, bandIndexByTaskId),
        tasks: groupTasks,
        origin: "GEOGRAPHIC_FALLBACK",
        cleanerId: null,
        groupingReason: {
          strategy: "NEARBY_MICRO_CLUSTER",
          summary: `Nearby micro-cluster (${seed.taskId}, ${candidateTask.taskId})`,
          details: {
            seedTaskId: seed.taskId,
            candidateTaskId: candidateTask.taskId,
            travelMaxMin: NEARBY_TASKS_TRAVEL_MAX_MIN,
          },
        },
      };
      candidates.push(buildCandidate(`cand-nearby-${seed.taskId}-${candidateTask.taskId}`, "NEARBY_MICRO", group));
      byTaskCounter.set(seed.taskId, (byTaskCounter.get(seed.taskId) ?? 0) + 1);
    }
  }
  return candidates;
}

function buildSingletonCandidates(
  tasks: LogisticsTaskForPhase2[],
  bandIndexByTaskId: Map<number, number>
): CompetitiveCandidate[] {
  return tasks.map((task) =>
    buildCandidate(`cand-singleton-${task.taskId}`, "SINGLETON", {
      groupId: `singleton-${task.taskId}`,
      seedBandIndex: getDominantBandIndex([task], bandIndexByTaskId),
      tasks: [task],
      origin: "SINGLETON_FALLBACK",
      cleanerId: task.cleanerId ?? null,
      groupingReason: buildRecoverySingletonGroupingReason(task),
    })
  );
}

function buildAllCompetitiveCandidates(
  tasks: LogisticsTaskForPhase2[],
  phase1: LogisticsPhase1Result,
  workDate: string
): CompetitiveCandidate[] {
  const bandIndexByTaskId = buildBandIndexByTaskId(phase1);
  const candidates = [
    ...buildSameLocationCandidates(tasks, bandIndexByTaskId, workDate),
    ...buildCleanerSequenceCandidates(tasks, phase1, workDate),
    ...buildNearbyMicroCandidates(tasks, bandIndexByTaskId),
    ...buildSingletonCandidates(tasks, bandIndexByTaskId),
  ];

  const byTask = new Map<number, CompetitiveCandidate[]>();
  for (const candidate of candidates) {
    for (const taskId of candidate.taskIds) {
      if (!byTask.has(taskId)) byTask.set(taskId, []);
      byTask.get(taskId)!.push(candidate);
    }
  }

  const selected = new Set<string>();
  const typeRank: Record<CandidateType, number> = {
    SAME_LOCATION: 0,
    CLEANER_SEQUENCE: 1,
    NEARBY_MICRO: 2,
    SINGLETON: 3,
  };
  for (const candidateList of byTask.values()) {
    const ordered = [...candidateList].sort((a, b) => {
      const typeDiff = typeRank[a.type] - typeRank[b.type];
      if (typeDiff !== 0) return typeDiff;
      if (b.assignedTaskCount !== a.assignedTaskCount) return b.assignedTaskCount - a.assignedTaskCount;
      if (b.compactnessScore !== a.compactnessScore) return b.compactnessScore - a.compactnessScore;
      return a.id.localeCompare(b.id);
    });
    for (let i = 0; i < Math.min(MAX_CANDIDATES_PER_TASK, ordered.length); i++) {
      selected.add(ordered[i].id);
    }
  }

  const deduped = candidates.filter((candidate) => selected.has(candidate.id));
  const seen = new Set<string>();
  return deduped.filter((candidate) => {
    const key = [...candidate.taskIds].sort((a, b) => a - b).join(",");
    const fullKey = `${candidate.type}:${key}`;
    if (seen.has(fullKey)) return false;
    seen.add(fullKey);
    return true;
  });
}

function rankCandidatesWithCheapScore(
  candidates: CompetitiveCandidate[],
  workDate: string
): CompetitiveCandidate[] {
  for (const candidate of candidates) {
    const earliestDeadline = Math.min(...candidate.group.tasks.map((task) => getTaskDeadlineMin(task, workDate)));
    const hasUrgentBag = candidate.group.tasks.some((task) => requiresDriverBeforeCleaner(task.bagPolicy));
    candidate.preScore =
      candidate.assignedTaskCount * ASSIGNED_TASK_WEIGHT +
      candidate.compactnessScore * 0.1 +
      candidate.cleanerSequenceScore * 0.5 -
      candidate.priorityRank * 8 -
      earliestDeadline / 60 +
      (hasUrgentBag ? 20 : 0);
  }
  return [...candidates].sort((a, b) => {
    if (b.preScore !== a.preScore) return b.preScore - a.preScore;
    return a.id.localeCompare(b.id);
  });
}

function shouldForceLookaheadForCandidate(candidate: CompetitiveCandidate, workDate: string): boolean {
  return candidate.group.tasks.some((task) => {
    if (requiresDriverBeforeCleaner(task.bagPolicy)) return true;
    const deadline = getTaskDeadlineMin(task, workDate);
    return deadline <= 11 * 60;
  });
}

function selectTopNOrUrgent(
  ranked: CompetitiveCandidate[],
  workDate: string,
  topN: number
): CompetitiveCandidate[] {
  const selected = new Map<string, CompetitiveCandidate>();
  for (let i = 0; i < Math.min(topN, ranked.length); i++) {
    selected.set(ranked[i].id, ranked[i]);
  }
  for (const candidate of ranked) {
    if (shouldForceLookaheadForCandidate(candidate, workDate)) {
      selected.set(candidate.id, candidate);
    }
  }
  return Array.from(selected.values());
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

      const bagBonus = requiresDriverBeforeCleaner(task.bagPolicy) ? -2 : 0;
      let score: number;
      if (group.origin === "CLEANER_CLUSTER") {
        // Cleaner clusters prioritize sequence continuity but still consider travel.
        score = sequencePenalty * 120 + travel * 20 + deadline / 10000 + keepConsecutiveCleanerBonus + bagBonus;
      } else if (
        group.origin === "GEOGRAPHIC_FALLBACK" ||
        group.origin === "STRONG_LOCATION_CLUSTER"
      ) {
        // Geographic fallback and strong-location clusters: travel-first with deadline
        // and bag urgency as soft ties. Per i cluster forti il travel intra-gruppo è
        // tendenzialmente ~0 quindi il deadline dominerà comunque l'ordinamento interno.
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
    case "TRULY_IMPOSSIBLE":
      return 5;
    case "ROUTE_CAPACITY_OR_ORDERING_CONFLICT":
      return 4;
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
  taskById: Map<number, LogisticsTaskForPhase2>,
  priorityWindows: PriorityWindows | null,
  performanceStats: LogisticsPhase2PerformanceStats,
  options?: SimulationOptions
): GroupSimulationResult {
  const allowInsertion = options?.allowInsertion ?? false;
  const existingOrdered = [...state.assignedTasks]
    .sort((a, b) => a.sequence - b.sequence)
    .map((assignment) => taskById.get(assignment.taskId))
    .filter((task): task is LogisticsTaskForPhase2 => task != null);

  const baselineFullRoute: LogisticsTaskSchedule[] = [...state.assignedTasks].sort(
    (a, b) => a.sequence - b.sequence
  );
  const infeasibleResult = (
    reasonCode: LogisticsPhase2ReasonCode,
    taskId: number | null,
    details?: Record<string, unknown>
  ): GroupSimulationResult => ({
    feasible: false,
    assignments: [],
    fullRouteAssignments: baselineFullRoute,
    insertIndex: existingOrdered.length,
    fullRouteTravelMinutes: state.totalTravelMinutes,
    projectedClockMin: state.clockMin,
    projectedLastLat: state.lastLat,
    projectedLastLng: state.lastLng,
    projectedCleanerLastSequence: new Map<number, number>(state.cleanerLastSequence),
    travelMinutesDelta: 0,
    score: Number.NEGATIVE_INFINITY,
    failure: { reasonCode, taskId, details },
  });

  if (orderedTasks.length === 0) {
    return infeasibleResult("NO_DRIVER_FEASIBLE", null);
  }

  // Insertion positions: 0..existingOrdered.length when allowed, else only "append".
  const insertStart = allowInsertion ? 0 : existingOrdered.length;
  const insertEnd = existingOrdered.length;

  const candidateIds = new Set(orderedTasks.map((task) => task.taskId));
  let bestSimulation: GroupSimulationResult | null = null;
  let bestFailure: FeasibilityFailure | null = null;

  // Step 4.7-bis (Fix A) — Linearity baseline ("before"): calcolata UNA VOLTA
  // sulla route pre-insertion. Per ogni candidate insertion calcoleremo
  // l'"after" e sottrarremo dallo score solo il DELTA (con bonus cappato),
  // così il driver con route già "sporca" non paga il pregresso ad ogni round.
  const routeLinearityBeforeFull = calculateRouteLinearityPenalty({
    route: baselineFullRoute,
    taskById,
    travelMatrix: options?.travelMatrix,
  });
  const routeLinearityBefore = routeLinearityBeforeFull.totalPenalty;

  for (let insertIndex = insertStart; insertIndex <= insertEnd; insertIndex++) {
    const fullOrdered = [
      ...existingOrdered.slice(0, insertIndex),
      ...orderedTasks,
      ...existingOrdered.slice(insertIndex),
    ];

    const built = buildScheduleWithMetrics(
      {
        tasks: fullOrdered.map(toLogisticsScheduleTaskInput),
        driverStartMin: state.driverStartMin,
        workDate,
        priorityWindows,
      },
      performanceStats
    );

    // Hard violations apply to the WHOLE route (existing tasks can shift when inserting in the middle).
    if (built.violations.checkin.length > 0) {
      const fail =
        built.violations.checkin.find((row) => candidateIds.has(row.taskId)) ?? built.violations.checkin[0];
      bestFailure = pickMoreUsefulFailure(bestFailure, {
        reasonCode: "CHECKIN_CHECKOUT_CONSTRAINT",
        taskId: fail?.taskId ?? null,
      });
      continue;
    }

    if (built.violations.checkoutWaitExceeded.length > 0) {
      const fail =
        built.violations.checkoutWaitExceeded.find((row) => candidateIds.has(row.taskId)) ??
        built.violations.checkoutWaitExceeded[0];
      bestFailure = pickMoreUsefulFailure(bestFailure, {
        reasonCode: "CHECKIN_CHECKOUT_CONSTRAINT",
        taskId: fail?.taskId ?? null,
      });
      continue;
    }

    // Cleaner constraint on every task in the (possibly reshuffled) route.
    const rowByTaskId = new Map(built.tasks.map((row) => [row.taskId, row]));
    let routeFailure: FeasibilityFailure | null = null;
    for (const task of fullOrdered) {
      const row = rowByTaskId.get(task.taskId);
      if (!row) {
        routeFailure = { reasonCode: "CHECKIN_CHECKOUT_CONSTRAINT", taskId: task.taskId };
        break;
      }
      if (getCleanerViolation(task, row.startMin)) {
        routeFailure = {
          reasonCode: "CLEANER_TIME_CONSTRAINT",
          taskId: task.taskId,
          details: getCleanerFailureDetails(task, row),
        };
        break;
      }
    }
    if (routeFailure) {
      bestFailure = pickMoreUsefulFailure(bestFailure, routeFailure);
      continue;
    }

    // Build the full schedule (existing + new) using LogisticsTaskSchedule shape.
    const fullRouteAssignments: LogisticsTaskSchedule[] = built.tasks.map((row) => {
      const task = taskById.get(row.taskId);
      return {
        taskId: row.taskId,
        logisticCode: task?.logisticCode ?? 0,
        startTime: row.startTime,
        endTime: row.endTime,
        travelMinutes: row.travelMinutes,
        checkoutWaitMinutes: row.checkoutWaitMinutes,
        sequence: row.sequence,
        reasonCode: null,
      };
    });
    const newAssignments = fullRouteAssignments.filter((assignment) => candidateIds.has(assignment.taskId));

    const fullRouteTravelMinutes = built.tasks.reduce((sum, row) => sum + row.travelMinutes, 0);
    const travelMinutesDelta = fullRouteTravelMinutes - state.totalTravelMinutes;

    let checkoutWaitMinutesDelta = 0;
    let priorityPenaltyDelta = 0;
    for (const row of built.tasks) {
      if (!candidateIds.has(row.taskId)) continue;
      checkoutWaitMinutesDelta += row.checkoutWaitMinutes;
      const task = taskById.get(row.taskId);
      if (priorityWindows && task && task.priorityType) {
        const pp = priorityPenalty(task.priorityType, row.startMin, row.endMin, priorityWindows);
        priorityPenaltyDelta += pp.penalty;
      }
    }

    const projectedCleanerLastSequence = new Map<number, number>(state.cleanerLastSequence);
    for (const task of orderedTasks) {
      if (task.cleanerId != null && task.cleanerSequence != null) {
        const previous = projectedCleanerLastSequence.get(task.cleanerId) ?? 0;
        projectedCleanerLastSequence.set(task.cleanerId, Math.max(previous, task.cleanerSequence));
      }
    }

    const projectedTaskCount = fullOrdered.length;
    const projectedLoadMin = projectedTaskCount * LOGISTICS_TASK_DURATION_MIN;
    const fairnessPenalty = projectedLoadMin * 0.3 + projectedTaskCount * 2.5;
    const bandPenalty = Math.abs(group.seedBandIndex - state.driverIndex) * 3;
    const hasBagDeliveryUrgency = group.tasks.some((task) => requiresDriverBeforeCleaner(task.bagPolicy));
    const cleanerContinuityBonus = group.tasks.reduce((sum, task) => {
      if (task.cleanerId == null || task.cleanerSequence == null) return sum;
      const previousSequence = state.cleanerLastSequence.get(task.cleanerId);
      if (previousSequence == null) return sum;
      return task.cleanerSequence === previousSequence + 1 ? sum + 4 : sum;
    }, 0);
    const cleanerClusterBonus = group.origin === "CLEANER_CLUSTER" ? 5 : 0;
    const strongLocationClusterBonus = group.origin === "STRONG_LOCATION_CLUSTER" ? 6 : 0;
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

    // Step 4.7-bis (Fix A,B,D) — continuity bonus su coppie consecutive resta
    // inline; le penalty di SPLIT (stesso address con stop in mezzo) e RETURN
    // sono ora dentro calculateRouteLinearityPenalty più sotto, applicate come
    // DELTA (after - before) per non punire il pregresso del driver.
    let sameLocationBonus = 0;
    let nearbyContinuityBonus = 0;
    let cleanerSequenceBreakPenalty = 0;
    const routeTasks: (LogisticsTaskForPhase2 | undefined)[] = built.tasks.map((row) =>
      taskById.get(row.taskId)
    );
    for (let i = 1; i < routeTasks.length; i++) {
      const prev = routeTasks[i - 1];
      const cur = routeTasks[i];
      if (!prev || !cur) continue;
      if (prev.addressId != null && cur.addressId != null && prev.addressId === cur.addressId) {
        sameLocationBonus += SAME_LOCATION_CONTINUITY_BONUS_PER_PAIR;
      } else if (areTasksNearby(prev, cur)) {
        nearbyContinuityBonus += NEARBY_CONTINUITY_BONUS_PER_PAIR;
      }
      if (
        prev.cleanerId != null &&
        cur.cleanerId != null &&
        prev.cleanerId === cur.cleanerId &&
        prev.cleanerSequence != null &&
        cur.cleanerSequence != null &&
        cur.cleanerSequence !== prev.cleanerSequence + 1
      ) {
        cleanerSequenceBreakPenalty += CLEANER_SEQUENCE_BREAK_PENALTY;
      }
    }

    // Step 4.7-bis (Fix A) — Route Linearity DELTA.
    // before = baseline (state.assignedTasks pre-inserzione) calcolato fuori dal loop
    // after  = full route dopo l'inserzione
    // delta  = after - before; può essere NEGATIVO se l'inserzione ricompatta la route
    // applied = max(-ROUTE_LINEARITY_MAX_BONUS, delta) → bonus cappato per evitare
    //           "fix mania": premiamo migliorie reali ma non spingiamo a patchare
    //           route brutte a discapito di route già compatte.
    const routeLinearityAfterFull = calculateRouteLinearityPenalty({
      route: fullRouteAssignments,
      taskById,
      travelMatrix: options?.travelMatrix,
    });
    const routeLinearityAfter = routeLinearityAfterFull.totalPenalty;
    const routeLinearityDelta = routeLinearityAfter - routeLinearityBefore;
    const routeLinearityDeltaApplied = Math.max(-ROUTE_LINEARITY_MAX_BONUS, routeLinearityDelta);

    const bagDeliveryUrgencyBonus = hasBagDeliveryUrgency ? 3 : 0;
    const waitPenalty = checkoutWaitMinutesDelta * 0.5;
    const assignedTaskReward = group.tasks.length * ASSIGNED_TASK_WEIGHT;

    // Slack penalty: route in cui un task resta troppo vicino al limite hard sono fragili
    // (un futuro inserimento può sforare). Penalizziamo i margini residui sotto soglia
    // su TUTTI i task della route, non solo sui nuovi: l'inserimento può ridurre il
    // margine di task già assegnati.
    let slackPenalty = 0;
    for (const row of built.tasks) {
      const task = taskById.get(row.taskId);
      if (!task) continue;
      slackPenalty += computeTaskSlackPenalty(task, row, workDate);
    }

    const score =
      assignedTaskReward -
      travelMinutesDelta -
      waitPenalty -
      slackPenalty +
      sameLocationBonus +
      nearbyContinuityBonus +
      cleanerContinuityBonus +
      cleanerClusterBonus +
      strongLocationClusterBonus +
      bagDeliveryUrgencyBonus -
      cleanerSequenceBreakPenalty -
      fallbackCompactnessPenalty -
      routeLinearityDeltaApplied -
      priorityPenaltyDelta * 2 -
      fairnessPenalty -
      bandPenalty;

    const lastRow = built.tasks[built.tasks.length - 1];

    const simulation: GroupSimulationResult = {
      feasible: true,
      assignments: newAssignments,
      fullRouteAssignments,
      insertIndex,
      fullRouteTravelMinutes,
      projectedClockMin: lastRow?.endMin ?? state.clockMin,
      projectedLastLat: built.lastLat,
      projectedLastLng: built.lastLng,
      projectedCleanerLastSequence,
      travelMinutesDelta,
      score,
      failure: null,
      routeLinearityBefore,
      routeLinearityAfter,
      routeLinearityDelta,
      routeLinearityDeltaApplied,
      routeLinearitySameOrNearGapPenalty: routeLinearityAfterFull.sameOrNearGapPenalty,
      routeLinearityNearestNeighborWastePenalty: routeLinearityAfterFull.nearestNeighborWastePenalty,
      routeLinearityReturnToAreaPenalty: routeLinearityAfterFull.returnToAreaPenalty,
      routeLinearityEvents: routeLinearityAfterFull.events,
    };

    const isBetter =
      !bestSimulation ||
      simulation.score > bestSimulation.score ||
      (simulation.score === bestSimulation.score && simulation.insertIndex < bestSimulation.insertIndex);
    if (isBetter) {
      bestSimulation = simulation;
    }
  }

  if (bestSimulation) return bestSimulation;
  return infeasibleResult(bestFailure?.reasonCode ?? "NO_DRIVER_FEASIBLE", bestFailure?.taskId ?? null, bestFailure?.details);
}

function simulateGroupForDriver(
  group: SpatialGroup,
  state: DriverState,
  workDate: string,
  taskById: Map<number, LogisticsTaskForPhase2>,
  priorityWindows: PriorityWindows | null,
  performanceStats: LogisticsPhase2PerformanceStats,
  options?: SimulationOptions
): GroupSimulationResult {
  const orderCandidates = buildOrderCandidates(group, state, workDate);
  let bestSimulation: GroupSimulationResult | null = null;
  let bestFailure: FeasibilityFailure | null = null;

  for (const orderedTasks of orderCandidates) {
    const simulation = simulateOrderedTasksForDriver(
      group,
      orderedTasks,
      state,
      workDate,
      taskById,
      priorityWindows,
      performanceStats,
      options
    );
    if (!simulation.feasible) {
      bestFailure = pickMoreUsefulFailure(bestFailure, simulation.failure);
      continue;
    }
    if (!bestSimulation || simulation.score > bestSimulation.score) {
      bestSimulation = simulation;
    }
  }

  if (bestSimulation) return bestSimulation;
  const baselineFullRoute: LogisticsTaskSchedule[] = [...state.assignedTasks].sort(
    (a, b) => a.sequence - b.sequence
  );
  return {
    feasible: false,
    assignments: [],
    fullRouteAssignments: baselineFullRoute,
    insertIndex: state.assignedTasks.length,
    fullRouteTravelMinutes: state.totalTravelMinutes,
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

function decrementReasonCount(
  reasonCounts: Record<LogisticsPhase2ReasonCode, number>,
  reasonCode: LogisticsPhase2ReasonCode
): void {
  reasonCounts[reasonCode] = Math.max(0, reasonCounts[reasonCode] - 1);
}

function applySimulationToDriverState(state: DriverState, simulation: GroupSimulationResult): void {
  // Replace the full route with the simulated one (insertion-aware): existing tasks may have
  // been reordered/shifted, so we cannot rely on push+delta anymore.
  state.assignedTasks = [...simulation.fullRouteAssignments];
  state.clockMin = simulation.projectedClockMin;
  state.lastLat = simulation.projectedLastLat;
  state.lastLng = simulation.projectedLastLng;
  state.cleanerLastSequence = simulation.projectedCleanerLastSequence;
  state.totalTravelMinutes = simulation.fullRouteTravelMinutes;
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
      totalTravelMinutes: choice.simulation.fullRouteTravelMinutes,
      assignedTasks: [...choice.simulation.fullRouteAssignments],
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
  priorityWindows: PriorityWindows | null,
  performanceStats: LogisticsPhase2PerformanceStats,
  depth = 0
): number {
  if (!group) return 0;

  for (const state of driverStates) {
    const simulation = simulateGroupForDriver(group, state, workDate, taskById, priorityWindows, performanceStats);
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
      const simulation = simulateGroupForDriver(
        subsetGroup,
        state,
        workDate,
        taskById,
        priorityWindows,
        performanceStats
      );
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
        estimateRecoverableTaskCount(
          remainingGroup,
          projectedStates,
          workDate,
          taskById,
          priorityWindows,
          performanceStats,
          depth + 1
        );

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
  taskById: Map<number, LogisticsTaskForPhase2>,
  priorityWindows: PriorityWindows | null,
  performanceStats: LogisticsPhase2PerformanceStats,
  options?: { travelMatrix?: TravelMatrix; fragmentationPenalty?: number }
): PartialChoiceRanking {
  let remainingFeasibleOnSomeDriver = false;
  let remainingScoreEstimate = Number.NEGATIVE_INFINITY;
  const projectedDriverStates = projectDriverStatesAfterChoice(choice, driverStates);
  if (choice.remainingGroup) {
    for (const state of projectedDriverStates) {
      const remainingSimulation = simulateGroupForDriver(
        choice.remainingGroup,
        state,
        workDate,
        taskById,
        priorityWindows,
        performanceStats,
        { travelMatrix: options?.travelMatrix }
      );
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
    taskById,
    priorityWindows,
    performanceStats
  );
  const expectedRecoverableTasks =
    choice.assignedGroup.tasks.length + remainingRecoverableTasks;
  // Step 4.7-bis — fragmentation entra nello score del partial ranking, così
  // un subset che spezza partner protetti viene preferito dopo uno che li tiene
  // insieme (a parità di task recuperabili).
  const fragmentationPenalty = options?.fragmentationPenalty ?? 0;
  return {
    expectedRecoverableTasks,
    assignedSize: choice.assignedGroup.tasks.length,
    remainingFeasibleOnSomeDriver,
    remainingScoreEstimate,
    score: choice.simulation.score - fragmentationPenalty,
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
  taskById: Map<number, LogisticsTaskForPhase2>,
  priorityWindows: PriorityWindows | null,
  performanceStats: LogisticsPhase2PerformanceStats
): LogisticsPhase2ReasonCode {
  const singletonGroup: SpatialGroup = {
    ...sourceGroup,
    groupId: `${sourceGroup.groupId}-reason-${task.taskId}`,
    tasks: [task],
    origin: "SINGLETON_FALLBACK",
  };

  let bestFailure: FeasibilityFailure | null = null;

  for (const state of driverStates) {
    const simulation = simulateGroupForDriver(
      singletonGroup,
      state,
      workDate,
      taskById,
      priorityWindows,
      performanceStats,
      { allowInsertion: true }
    );
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
  taskById: Map<number, LogisticsTaskForPhase2>,
  priorityWindows: PriorityWindows | null,
  performanceStats: LogisticsPhase2PerformanceStats,
  options?: {
    travelMatrix?: TravelMatrix;
    feasibleTaskIds?: Set<number>;
    remainingTasksForFragmentation?: LogisticsTaskForPhase2[];
  }
): { choice: PartialGroupSimulationChoice; fragmentationPenalty: number; fragmentation?: FragmentationResult } | null {
  if (group.tasks.length <= 1) return null;
  const subsets = buildTaskSubsetsByDescendingSize(group.tasks).filter((subset) => subset.length < group.tasks.length);

  let currentSize: number | null = null;
  let bestChoice: PartialGroupSimulationChoice | null = null;
  let bestRanking: PartialChoiceRanking | null = null;
  let bestFragmentationPenalty = 0;
  let bestFragmentation: FragmentationResult | undefined;

  for (const subset of subsets) {
    if (
      currentSize !== null &&
      subset.length < currentSize &&
      bestChoice &&
      bestRanking?.remainingFeasibleOnSomeDriver
    ) {
      // Chiude solo se il miglior subset alla dimensione precedente lascia un remaining assegnabile.
      return { choice: bestChoice, fragmentationPenalty: bestFragmentationPenalty, fragmentation: bestFragmentation };
    }
    currentSize = subset.length;

    const subsetGroup: SpatialGroup = {
      ...group,
      groupId: `${group.groupId}-partial-${subset.map((task) => task.taskId).join("-")}`,
      tasks: subset,
      origin: subset.length === 1 ? "SINGLETON_FALLBACK" : group.origin,
    };

    // Step 4.7-bis — fragmentation calcolata sul subset assegnato (è
    // indipendente dal driver scelto, quindi una volta per subset).
    let fragmentation: FragmentationResult | undefined;
    let fragmentationPenalty = 0;
    if (options?.remainingTasksForFragmentation) {
      const subsetCandidate: CompetitiveCandidate = {
        id: subsetGroup.groupId,
        type: subset.length === 1 ? "SINGLETON" : "SAME_LOCATION",
        group: subsetGroup,
        taskIds: subset.map((task) => task.taskId),
        assignedTaskCount: subset.length,
        preScore: 0,
        priorityRank: 0,
        compactnessScore: 0,
        cleanerSequenceScore: 0,
      };
      fragmentation = calculateCandidateFragmentationPenalty({
        candidate: subsetCandidate,
        remainingTasks: options.remainingTasksForFragmentation,
        taskById,
        travelMatrix: options.travelMatrix,
        feasibleTaskIds: options.feasibleTaskIds,
      });
      fragmentationPenalty = fragmentation.penalty;
    }

    for (const state of driverStates) {
      const simulation = simulateGroupForDriver(
        subsetGroup,
        state,
        workDate,
        taskById,
        priorityWindows,
        performanceStats,
        { allowInsertion: true, travelMatrix: options?.travelMatrix }
      );
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
      const ranking = getPartialChoiceRanking(
        choice,
        driverStates,
        workDate,
        taskById,
        priorityWindows,
        performanceStats,
        { travelMatrix: options?.travelMatrix, fragmentationPenalty }
      );

      if (!bestRanking || isBetterPartialRanking(ranking, bestRanking)) {
        bestChoice = choice;
        bestRanking = ranking;
        bestFragmentationPenalty = fragmentationPenalty;
        bestFragmentation = fragmentation;
      }
    }
  }

  if (!bestChoice) return null;
  return { choice: bestChoice, fragmentationPenalty: bestFragmentationPenalty, fragmentation: bestFragmentation };
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
  taskById: Map<number, LogisticsTaskForPhase2>,
  priorityWindows: PriorityWindows | null,
  performanceStats: LogisticsPhase2PerformanceStats,
  options?: SimulationOptions
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
    const simulation = simulateGroupForDriver(
      group,
      state,
      workDate,
      taskById,
      priorityWindows,
      performanceStats,
      { allowInsertion: true, ...options }
    );
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

function projectDriverStatesAfterSimulation(
  targetState: DriverState,
  simulation: GroupSimulationResult,
  driverStates: DriverState[]
): DriverState[] {
  return driverStates.map((state) => {
    if (state.driverId !== targetState.driverId) return state;
    return {
      ...state,
      clockMin: simulation.projectedClockMin,
      lastLat: simulation.projectedLastLat,
      lastLng: simulation.projectedLastLng,
      totalTravelMinutes: simulation.fullRouteTravelMinutes,
      assignedTasks: simulation.fullRouteAssignments.map((item) => ({ ...item })),
      cleanerLastSequence: new Map(simulation.projectedCleanerLastSequence),
    };
  });
}

function getUrgentTaskRiskWeight(task: LogisticsTaskForPhase2, workDate: string): number {
  if (requiresDriverBeforeCleaner(task.bagPolicy)) return 8;
  return getTaskDeadlineMin(task, workDate) <= 11 * 60 ? 8 : 0;
}

function estimateMissedUrgentTaskRisk(args: {
  candidate: CompetitiveCandidate;
  bestState: DriverState;
  simulation: GroupSimulationResult;
  remainingTasks: LogisticsTaskForPhase2[];
  driverStates: DriverState[];
  workDate: string;
  taskById: Map<number, LogisticsTaskForPhase2>;
  priorityWindows: PriorityWindows | null;
  performanceStats: LogisticsPhase2PerformanceStats;
}): number {
  const projectedStates = projectDriverStatesAfterSimulation(args.bestState, args.simulation, args.driverStates);
  const selectedTaskIds = new Set(args.candidate.taskIds);
  let risk = 0;
  for (const task of args.remainingTasks) {
    if (selectedTaskIds.has(task.taskId)) continue;
    const taskRisk = getUrgentTaskRiskWeight(task, args.workDate);
    if (taskRisk <= 0) continue;
    const singletonGroup: SpatialGroup = {
      groupId: `risk-${task.taskId}`,
      seedBandIndex: 0,
      tasks: [task],
      origin: "SINGLETON_FALLBACK",
      cleanerId: task.cleanerId ?? null,
    };
    let feasibleCount = 0;
    for (const state of projectedStates) {
      const simulation = simulateGroupForDriver(
        singletonGroup,
        state,
        args.workDate,
        args.taskById,
        args.priorityWindows,
        args.performanceStats,
        { allowInsertion: true }
      );
      if (simulation.feasible) feasibleCount += 1;
      if (feasibleCount > 1) break;
    }
    if (feasibleCount === 0) risk += taskRisk;
    else if (feasibleCount <= 1) risk += Math.ceil(taskRisk / 2);
  }
  return risk;
}

function estimateSameLocationCrossDriverSplitPenalty(args: {
  candidate: CompetitiveCandidate;
  driverId: number;
  driverStates: DriverState[];
  taskById: Map<number, LogisticsTaskForPhase2>;
}): number {
  const candidateAddressIds = new Set(
    args.candidate.group.tasks.map((task) => task.addressId).filter((id): id is number => id != null)
  );
  if (candidateAddressIds.size === 0) return 0;
  let penalties = 0;
  for (const state of args.driverStates) {
    if (state.driverId === args.driverId) continue;
    const routeTasks = getAssignedRouteTasks(state, args.taskById);
    const hasOverlapAddress = routeTasks.some((task) => task.addressId != null && candidateAddressIds.has(task.addressId));
    if (hasOverlapAddress) penalties += SAME_LOCATION_CROSS_DRIVER_SPLIT_PENALTY;
  }
  return penalties;
}

interface CompetitiveBestPick {
  candidate: CompetitiveCandidate;
  state: DriverState;
  simulation: GroupSimulationResult;
  attempts: DriverAttemptJson[];
  finalScore: number;
  scoreGapToRunnerUp: number | null;
  competitorsConsidered: Array<{ id: string; type: CandidateType; score: number | null; feasible: boolean }>;
  sameLocationSplitAcceptedReason: string | null;
  fragmentationPenalty: number;
  fragmentationPenaltyCapped: boolean;
  fragmentationProtectedNearPairCount: number;
  fragmentationEvents: FragmentationEvent[];
  routeLinearityBefore: number;
  routeLinearityAfter: number;
  routeLinearityDelta: number;
  routeLinearityDeltaApplied: number;
  routeLinearityEvents: RouteLinearityEvent[];
}

function pickBestCompetitiveCandidate(args: {
  candidates: CompetitiveCandidate[];
  driverStates: DriverState[];
  workDate: string;
  taskById: Map<number, LogisticsTaskForPhase2>;
  priorityWindows: PriorityWindows | null;
  performanceStats: LogisticsPhase2PerformanceStats;
  remainingTasks: LogisticsTaskForPhase2[];
  travelMatrix?: TravelMatrix;
  feasibleTaskIds?: Set<number>;
}): CompetitiveBestPick | null {
  const competitorRows: Array<{ id: string; type: CandidateType; score: number | null; feasible: boolean }> = [];
  const feasible: Array<{
    candidate: CompetitiveCandidate;
    state: DriverState;
    simulation: GroupSimulationResult;
    attempts: DriverAttemptJson[];
    score: number;
    sameLocationSplitAcceptedReason: string | null;
    fragmentation: FragmentationResult;
  }> = [];

  for (const candidate of args.candidates) {
    const { attempts, bestState, bestSimulation } = buildDriverAttemptsForGroup(
      candidate.group,
      args.driverStates,
      args.workDate,
      args.taskById,
      args.priorityWindows,
      args.performanceStats,
      { travelMatrix: args.travelMatrix }
    );
    if (!bestState || !bestSimulation) {
      competitorRows.push({ id: candidate.id, type: candidate.type, score: null, feasible: false });
      continue;
    }

    const lookaheadRisk = estimateMissedUrgentTaskRisk({
      candidate,
      bestState,
      simulation: bestSimulation,
      remainingTasks: args.remainingTasks,
      driverStates: args.driverStates,
      workDate: args.workDate,
      taskById: args.taskById,
      priorityWindows: args.priorityWindows,
      performanceStats: args.performanceStats,
    });
    const crossDriverPenalty = estimateSameLocationCrossDriverSplitPenalty({
      candidate,
      driverId: bestState.driverId,
      driverStates: args.driverStates,
      taskById: args.taskById,
    });
    // Step 4.7-bis (Fix C) — fragmentation calcolata 1 volta per candidato (non
    // per (candidato × driver)): la dipendenza è solo da `remainingTasks` +
    // taskById, indipendente dal driver scelto.
    const fragmentation = calculateCandidateFragmentationPenalty({
      candidate,
      remainingTasks: args.remainingTasks,
      taskById: args.taskById,
      travelMatrix: args.travelMatrix,
      feasibleTaskIds: args.feasibleTaskIds,
    });
    const finalScore = bestSimulation.score - lookaheadRisk - crossDriverPenalty - fragmentation.penalty;
    const sameLocationSplitAcceptedReason = crossDriverPenalty > 0 ? "cross_driver_same_location_split" : null;
    feasible.push({
      candidate,
      state: bestState,
      simulation: bestSimulation,
      attempts,
      score: finalScore,
      sameLocationSplitAcceptedReason,
      fragmentation,
    });
    competitorRows.push({ id: candidate.id, type: candidate.type, score: finalScore, feasible: true });
  }

  if (feasible.length === 0) return null;
  feasible.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tie-break (Step 4.7-bis):
    //  1. meno fragmentation (preferiamo candidati che non spezzano partner protetti)
    //  2. linearity delta più basso (preferiamo inserzioni che ricompattano)
    //  3. più task assegnati
    //  4. id lessicografico (determinismo)
    if (a.fragmentation.penalty !== b.fragmentation.penalty) {
      return a.fragmentation.penalty - b.fragmentation.penalty;
    }
    const aLin = a.simulation.routeLinearityDeltaApplied ?? 0;
    const bLin = b.simulation.routeLinearityDeltaApplied ?? 0;
    if (aLin !== bLin) return aLin - bLin;
    if (b.candidate.assignedTaskCount !== a.candidate.assignedTaskCount) {
      return b.candidate.assignedTaskCount - a.candidate.assignedTaskCount;
    }
    return a.candidate.id.localeCompare(b.candidate.id);
  });
  const best = feasible[0];
  const runnerUp = feasible[1];
  return {
    candidate: best.candidate,
    state: best.state,
    simulation: best.simulation,
    attempts: best.attempts,
    finalScore: best.score,
    scoreGapToRunnerUp: runnerUp ? best.score - runnerUp.score : null,
    competitorsConsidered: competitorRows,
    sameLocationSplitAcceptedReason: best.sameLocationSplitAcceptedReason,
    fragmentationPenalty: best.fragmentation.penalty,
    fragmentationPenaltyCapped: best.fragmentation.cappedByMax,
    fragmentationProtectedNearPairCount: best.fragmentation.protectedNearPairCount,
    fragmentationEvents: best.fragmentation.events,
    routeLinearityBefore: best.simulation.routeLinearityBefore ?? 0,
    routeLinearityAfter: best.simulation.routeLinearityAfter ?? 0,
    routeLinearityDelta: best.simulation.routeLinearityDelta ?? 0,
    routeLinearityDeltaApplied: best.simulation.routeLinearityDeltaApplied ?? 0,
    routeLinearityEvents: best.simulation.routeLinearityEvents ?? [],
  };
}

function pickBestPartialAcrossCandidates(args: {
  candidates: CompetitiveCandidate[];
  driverStates: DriverState[];
  workDate: string;
  taskById: Map<number, LogisticsTaskForPhase2>;
  priorityWindows: PriorityWindows | null;
  performanceStats: LogisticsPhase2PerformanceStats;
  remainingTasks?: LogisticsTaskForPhase2[];
  travelMatrix?: TravelMatrix;
  feasibleTaskIds?: Set<number>;
}): {
  candidate: CompetitiveCandidate;
  choice: PartialGroupSimulationChoice;
  ranking: PartialChoiceRanking;
  fragmentationPenalty: number;
  fragmentation?: FragmentationResult;
} | null {
  let best:
    | {
        candidate: CompetitiveCandidate;
        choice: PartialGroupSimulationChoice;
        ranking: PartialChoiceRanking;
        fragmentationPenalty: number;
        fragmentation?: FragmentationResult;
      }
    | null = null;

  for (const candidate of args.candidates) {
    const partial = findBestPartialGroupAssignment(
      candidate.group,
      args.driverStates,
      args.workDate,
      args.taskById,
      args.priorityWindows,
      args.performanceStats,
      {
        travelMatrix: args.travelMatrix,
        feasibleTaskIds: args.feasibleTaskIds,
        remainingTasksForFragmentation: args.remainingTasks,
      }
    );
    if (!partial) continue;
    const { choice, fragmentationPenalty, fragmentation } = partial;
    const ranking = getPartialChoiceRanking(
      choice,
      args.driverStates,
      args.workDate,
      args.taskById,
      args.priorityWindows,
      args.performanceStats,
      { travelMatrix: args.travelMatrix, fragmentationPenalty }
    );
    if (!best || isBetterPartialRanking(ranking, best.ranking)) {
      best = { candidate, choice, ranking, fragmentationPenalty, fragmentation };
    }
  }

  return best;
}

function getAssignedRouteTasks(
  state: DriverState,
  taskById: Map<number, LogisticsTaskForPhase2>
): LogisticsTaskForPhase2[] {
  return [...state.assignedTasks]
    .sort((a, b) => a.sequence - b.sequence)
    .map((assignment) => taskById.get(assignment.taskId))
    .filter((task): task is LogisticsTaskForPhase2 => task != null);
}

function rebuildCleanerLastSequence(routeTasks: LogisticsTaskForPhase2[]): Map<number, number> {
  const cleanerLastSequence = new Map<number, number>();
  for (const task of routeTasks) {
    if (task.cleanerId == null || task.cleanerSequence == null) continue;
    const previous = cleanerLastSequence.get(task.cleanerId) ?? 0;
    cleanerLastSequence.set(task.cleanerId, Math.max(previous, task.cleanerSequence));
  }
  return cleanerLastSequence;
}

function simulateFullRouteForRepair(
  state: DriverState,
  routeTasks: LogisticsTaskForPhase2[],
  insertedTaskId: number,
  workDate: string,
  priorityWindows: PriorityWindows | null,
  performanceStats: LogisticsPhase2PerformanceStats
): RepairRouteSimulationResult {
  const built = buildScheduleWithMetrics(
    {
      tasks: routeTasks.map(toLogisticsScheduleTaskInput),
      driverStartMin: state.driverStartMin,
      workDate,
      priorityWindows,
    },
    performanceStats
  );

  const rowByTaskId = new Map(built.tasks.map((row) => [row.taskId, row]));
  const fail = (failure: FeasibilityFailure): RepairRouteSimulationResult => ({
    feasible: false,
    assignments: [],
    projectedClockMin: state.clockMin,
    projectedLastLat: state.lastLat,
    projectedLastLng: state.lastLng,
    projectedCleanerLastSequence: new Map(state.cleanerLastSequence),
    totalTravelMinutes: state.totalTravelMinutes,
    insertedTaskSchedule: null,
    failure,
  });

  if (built.violations.checkin.length > 0) {
    const violation =
      built.violations.checkin.find((row) => row.taskId === insertedTaskId) ?? built.violations.checkin[0];
    return fail({ reasonCode: "CHECKIN_CHECKOUT_CONSTRAINT", taskId: violation?.taskId ?? null });
  }

  if (built.violations.checkoutWaitExceeded.length > 0) {
    const violation =
      built.violations.checkoutWaitExceeded.find((row) => row.taskId === insertedTaskId) ??
      built.violations.checkoutWaitExceeded[0];
    return fail({ reasonCode: "CHECKIN_CHECKOUT_CONSTRAINT", taskId: violation?.taskId ?? null });
  }

  const assignments: LogisticsTaskSchedule[] = [];
  let totalTravelMinutes = 0;
  for (const task of routeTasks) {
    const row = rowByTaskId.get(task.taskId);
    if (!row) {
      return fail({ reasonCode: "CHECKIN_CHECKOUT_CONSTRAINT", taskId: task.taskId });
    }
    if (getCleanerViolation(task, row.startMin)) {
      return fail({
        reasonCode: "CLEANER_TIME_CONSTRAINT",
        taskId: task.taskId,
        details: getCleanerFailureDetails(task, row),
      });
    }
    totalTravelMinutes += row.travelMinutes;
    assignments.push({
      taskId: task.taskId,
      logisticCode: task.logisticCode,
      startTime: row.startTime,
      endTime: row.endTime,
      travelMinutes: row.travelMinutes,
      checkoutWaitMinutes: row.checkoutWaitMinutes,
      sequence: row.sequence,
      reasonCode: null,
    });
  }

  return {
    feasible: true,
    assignments,
    projectedClockMin: built.projectedClockMin,
    projectedLastLat: built.lastLat,
    projectedLastLng: built.lastLng,
    projectedCleanerLastSequence: rebuildCleanerLastSequence(routeTasks),
    totalTravelMinutes,
    insertedTaskSchedule: assignments.find((assignment) => assignment.taskId === insertedTaskId) ?? null,
    failure: null,
  };
}

function calculateRepairInsertionCost(
  state: DriverState,
  task: LogisticsTaskForPhase2,
  routeBefore: LogisticsTaskForPhase2[],
  routeAfter: LogisticsTaskForPhase2[],
  insertIndex: number,
  simulation: RepairRouteSimulationResult,
  bandIndexByTaskId: Map<number, number>,
  workDate: string
): number {
  const hardDeadlineMin = getHardDeadlineMin(task, workDate);
  const insertedRow = simulation.insertedTaskSchedule;
  const insertedStartMin = insertedRow ? parseMinutes(insertedRow.startTime, hardDeadlineMin) : hardDeadlineMin;
  const insertedEndMin = insertedRow ? parseMinutes(insertedRow.endTime, hardDeadlineMin) : hardDeadlineMin;
  const cleanerDeadline = getCleanerDeadlineForBagDelivery(task);
  const cleanerOverflow =
    cleanerDeadline != null
      ? Math.max(
          0,
          insertedStartMin -
            (parseMinutes(cleanerDeadline, 23 * 60 + 59) + resolveBagDeliveryToleranceMin(task))
        )
      : 0;
  const checkinOverflow =
    isDateCompatibleWithWorkDate(task.checkinDate, workDate) && task.checkinTime
      ? Math.max(0, insertedEndMin - parseMinutes(task.checkinTime, 23 * 60 + 59))
      : 0;
  const fallbackOverflow =
    cleanerDeadline == null && checkinOverflow === 0 ? Math.max(0, insertedEndMin - hardDeadlineMin) : 0;
  const urgencyOverflow = Math.max(cleanerOverflow, checkinOverflow, fallbackOverflow);
  const addedTravel = Math.max(0, simulation.totalTravelMinutes - state.totalTravelMinutes);
  const bandIndex = bandIndexByTaskId.get(task.taskId);
  const bandPenalty = bandIndex == null ? 0 : Math.abs(bandIndex - state.driverIndex) * 10;
  const previousTask = routeAfter[insertIndex - 1] ?? null;
  const nextTask = routeAfter[insertIndex + 1] ?? null;
  const cleanerContinuityBonus =
    previousTask?.cleanerId != null &&
    previousTask.cleanerId === task.cleanerId &&
    previousTask.cleanerSequence != null &&
    task.cleanerSequence != null &&
    task.cleanerSequence === previousTask.cleanerSequence + 1
      ? -20
      : nextTask?.cleanerId != null &&
          nextTask.cleanerId === task.cleanerId &&
          nextTask.cleanerSequence != null &&
          task.cleanerSequence != null &&
          nextTask.cleanerSequence === task.cleanerSequence + 1
        ? -10
        : 0;

  return (
    urgencyOverflow * 10000 +
    addedTravel * 100 +
    simulation.totalTravelMinutes * 5 +
    bandPenalty +
    routeBefore.length +
    insertIndex * 0.1 +
    cleanerContinuityBonus
  );
}

function applyRepairCandidate(candidate: RepairInsertionCandidate): void {
  candidate.state.assignedTasks = candidate.simulation.assignments;
  candidate.state.clockMin = candidate.simulation.projectedClockMin;
  candidate.state.lastLat = candidate.simulation.projectedLastLat;
  candidate.state.lastLng = candidate.simulation.projectedLastLng;
  candidate.state.cleanerLastSequence = candidate.simulation.projectedCleanerLastSequence;
  candidate.state.totalTravelMinutes = candidate.simulation.totalTravelMinutes;
}

function removeTaskFromUnassigned(
  taskId: number,
  unassignedTasks: LogisticsPhase2UnassignedTask[],
  debugUnassignedDetails: UnassignedTaskDebugJson[],
  reasonCounts: Record<LogisticsPhase2ReasonCode, number>
): void {
  const unassignedIndex = unassignedTasks.findIndex((item) => item.taskId === taskId);
  if (unassignedIndex >= 0) {
    const [removed] = unassignedTasks.splice(unassignedIndex, 1);
    decrementReasonCount(reasonCounts, removed.reasonCode);
  }

  for (let i = debugUnassignedDetails.length - 1; i >= 0; i--) {
    if (debugUnassignedDetails[i].taskId === taskId) {
      debugUnassignedDetails.splice(i, 1);
    }
  }
}

function mergeRepairFailuresIntoDebug(
  taskId: number,
  debugUnassignedDetails: UnassignedTaskDebugJson[],
  failuresByDriverId: Map<number, FeasibilityFailure>
): void {
  const entry = debugUnassignedDetails.find((item) => item.taskId === taskId);
  if (!entry) return;
  const existingKeys = new Set(
    entry.driverFailures.map((failure) => `${failure.driverId}:${failure.reasonCode}:${failure.taskId ?? "null"}`)
  );
  for (const [driverId, failure] of failuresByDriverId.entries()) {
    const key = `${driverId}:${failure.reasonCode}:${failure.taskId ?? "null"}`;
    if (existingKeys.has(key)) continue;
    entry.driverFailures.push({
      driverId,
      reasonCode: failure.reasonCode,
      taskId: failure.taskId,
      details: failure.details,
    });
  }
}

function repairUnassignedTasksWithInsertion(args: {
  unassignedTasks: LogisticsPhase2UnassignedTask[];
  debugUnassignedDetails: UnassignedTaskDebugJson[];
  driverStates: DriverState[];
  taskById: Map<number, LogisticsTaskForPhase2>;
  bandIndexByTaskId: Map<number, number>;
  workDate: string;
  priorityWindows: PriorityWindows | null;
  performanceStats: LogisticsPhase2PerformanceStats;
  reasonCounts: Record<LogisticsPhase2ReasonCode, number>;
  debugCollector?: LogisticsPhase2DebugCollector | null;
  stepStart: number;
}): number {
  const pendingTasks = [...args.unassignedTasks]
    .map((item) => args.taskById.get(item.taskId))
    .filter((task): task is LogisticsTaskForPhase2 => task != null)
    .sort((a, b) => {
      const deadlineDiff = getHardDeadlineMin(a, args.workDate) - getHardDeadlineMin(b, args.workDate);
      if (deadlineDiff !== 0) return deadlineDiff;
      return a.taskId - b.taskId;
    });

  let repairedCount = 0;
  for (const task of pendingTasks) {
    if (!args.unassignedTasks.some((item) => item.taskId === task.taskId)) continue;

    let bestCandidate: RepairInsertionCandidate | null = null;
    const bestFailureByDriverId = new Map<number, FeasibilityFailure>();
    const driverAttempts: DriverAttemptJson[] = [];

    for (const state of args.driverStates) {
      const currentRoute = getAssignedRouteTasks(state, args.taskById);
      let bestDriverFailure: FeasibilityFailure | null = null;
      let bestDriverSimulation: RepairRouteSimulationResult | null = null;
      let bestDriverCost = Number.POSITIVE_INFINITY;

      for (let insertIndex = 0; insertIndex <= currentRoute.length; insertIndex++) {
        const candidateRoute = [
          ...currentRoute.slice(0, insertIndex),
          task,
          ...currentRoute.slice(insertIndex),
        ];
        const simulation = simulateFullRouteForRepair(
          state,
          candidateRoute,
          task.taskId,
          args.workDate,
          args.priorityWindows,
          args.performanceStats
        );

        if (!simulation.feasible) {
          bestDriverFailure = pickMoreUsefulFailure(bestDriverFailure, simulation.failure);
          continue;
        }

        const cost = calculateRepairInsertionCost(
          state,
          task,
          currentRoute,
          candidateRoute,
          insertIndex,
          simulation,
          args.bandIndexByTaskId,
          args.workDate
        );
        if (cost < bestDriverCost) {
          bestDriverCost = cost;
          bestDriverSimulation = simulation;
        }
        if (!bestCandidate || cost < bestCandidate.cost) {
          bestCandidate = {
            state,
            simulation,
            insertIndex,
            cost,
          };
        }
      }

      if (bestDriverFailure) {
        bestFailureByDriverId.set(state.driverId, bestDriverFailure);
      }
      driverAttempts.push({
        driverId: state.driverId,
        feasible: bestDriverSimulation != null,
        score: bestDriverSimulation ? -bestDriverCost : undefined,
        travelMinutesDelta: bestDriverSimulation
          ? Math.max(0, bestDriverSimulation.totalTravelMinutes - state.totalTravelMinutes)
          : undefined,
        projectedClockEnd: bestDriverSimulation ? toHHMM(bestDriverSimulation.projectedClockMin) : undefined,
        failure: bestDriverSimulation
          ? undefined
          : bestDriverFailure
            ? {
                reasonCode: bestDriverFailure.reasonCode,
                taskId: bestDriverFailure.taskId,
                details: bestDriverFailure.details,
              }
            : undefined,
      });
    }

    if (!bestCandidate) {
      mergeRepairFailuresIntoDebug(task.taskId, args.debugUnassignedDetails, bestFailureByDriverId);
      continue;
    }

    const travelMinutesDelta = Math.max(
      0,
      bestCandidate.simulation.totalTravelMinutes - bestCandidate.state.totalTravelMinutes
    );
    applyRepairCandidate(bestCandidate);
    removeTaskFromUnassigned(task.taskId, args.unassignedTasks, args.debugUnassignedDetails, args.reasonCounts);
    repairedCount += 1;

    if (args.debugCollector) {
      args.debugCollector.recordGroupDecision({
        step: args.stepStart + repairedCount,
        groupId: `repair-${task.taskId}`,
        origin: "REPAIR_INSERTION",
        taskIds: [task.taskId],
        logisticCodes: [task.logisticCode],
        groupingReason: {
          strategy: "REPAIR_INSERTION",
          summary: "Task non assegnata recuperata inserendola in mezzo a una route esistente",
          details: {
            taskId: task.taskId,
            driverId: bestCandidate.state.driverId,
            insertIndex: bestCandidate.insertIndex,
            cost: bestCandidate.cost,
          },
        },
        outcome: "REPAIR_ASSIGNED",
        why: "best_valid_position_across_existing_driver_routes",
        winner: {
          driverId: bestCandidate.state.driverId,
          score: -bestCandidate.cost,
          travelMinutesDelta,
          projectedClockEnd: toHHMM(bestCandidate.simulation.projectedClockMin),
          taskOrder: bestCandidate.simulation.assignments.map((item) => item.taskId),
          schedule: mapAssignmentsToDebugSchedule(bestCandidate.simulation.assignments),
        },
        driverAttempts,
      });
    }
  }

  return repairedCount;
}

function classifyFinalUnassignedTasks(args: {
  unassignedTasks: LogisticsPhase2UnassignedTask[];
  debugUnassignedDetails: UnassignedTaskDebugJson[];
  selectedDrivers: LogisticsSelectedDriver[];
  taskById: Map<number, LogisticsTaskForPhase2>;
  workDate: string;
  priorityWindows: PriorityWindows | null;
  performanceStats: LogisticsPhase2PerformanceStats;
  reasonCounts: Record<LogisticsPhase2ReasonCode, number>;
}): void {
  for (const item of args.unassignedTasks) {
    const task = args.taskById.get(item.taskId);
    if (!task) continue;

    const singletonGroup: SpatialGroup = {
      groupId: `final-classify-${task.taskId}`,
      seedBandIndex: 0,
      tasks: [task],
      origin: "SINGLETON_FALLBACK",
      cleanerId: task.cleanerId ?? null,
    };

    const emptyStates = buildDriverStates(args.selectedDrivers);
    const feasibleAloneOnDriverIds: number[] = [];
    for (const state of emptyStates) {
      const simulation = simulateGroupForDriver(
        singletonGroup,
        state,
        args.workDate,
        args.taskById,
        args.priorityWindows,
        args.performanceStats
      );
      if (simulation.feasible) {
        feasibleAloneOnDriverIds.push(state.driverId);
      }
    }

    const finalReasonCode: LogisticsPhase2ReasonCode = feasibleAloneOnDriverIds.length > 0
      ? "ROUTE_CAPACITY_OR_ORDERING_CONFLICT"
      : "TRULY_IMPOSSIBLE";
    if (item.reasonCode !== finalReasonCode) {
      decrementReasonCount(args.reasonCounts, item.reasonCode);
      incrementReasonCount(args.reasonCounts, finalReasonCode);
      item.reasonCode = finalReasonCode;
    }

    const debugEntry = args.debugUnassignedDetails.find((entry) => entry.taskId === item.taskId);
    if (debugEntry) {
      debugEntry.reasonCode = finalReasonCode;
      debugEntry.feasibleAloneOnDriverIds = feasibleAloneOnDriverIds;
      debugEntry.trulyImpossible = finalReasonCode === "TRULY_IMPOSSIBLE";
    }
  }
}

/**
 * Step 4.7-bis (Fix C, supporto a feasibleTaskIds) — precomputa l'insieme dei
 * task che almeno UN driver può servire come singleton partendo dal depot.
 *
 * Usato dalla fragmentation penalty per non punire un candidato per aver
 * lasciato fuori task che nessuno comunque potrebbe servire (stranded by
 * deadline / cleaner / check-in). Snapshot statico: i driver "veri"
 * cambieranno state durante il loop, ma per la quasi totalità dei task
 * "stranded" non c'è alcuna giornata in cui diventeranno feasibili.
 */
function buildAssignableTaskIds(
  schedulableTasks: LogisticsTaskForPhase2[],
  selectedDrivers: LogisticsSelectedDriver[],
  workDate: string,
  taskById: Map<number, LogisticsTaskForPhase2>,
  priorityWindows: PriorityWindows | null,
  performanceStats: LogisticsPhase2PerformanceStats,
  travelMatrix?: TravelMatrix
): Set<number> {
  const result = new Set<number>();
  const freshDriverStates = buildDriverStates(selectedDrivers);
  const simulationOptions: SimulationOptions = { allowInsertion: false, travelMatrix };

  for (const task of schedulableTasks) {
    const singletonGroup: SpatialGroup = {
      groupId: `assignability-${task.taskId}`,
      seedBandIndex: 0,
      tasks: [task],
      origin: "SINGLETON_FALLBACK",
      cleanerId: task.cleanerId ?? null,
    };
    for (const state of freshDriverStates) {
      const sim = simulateGroupForDriver(
        singletonGroup,
        state,
        workDate,
        taskById,
        priorityWindows,
        performanceStats,
        simulationOptions
      );
      if (sim.feasible) {
        result.add(task.taskId);
        break;
      }
    }
  }
  return result;
}

function collectSameLocationReturnEvents(
  driverStates: DriverState[],
  taskById: Map<number, LogisticsTaskForPhase2>
): Array<{
  addressId: number;
  logisticCode: number | null;
  taskIds: number[];
  driverIds: number[];
  sequencePositions: number[];
  minutesBetweenVisits: number;
  reason: string;
}> {
  const events: Array<{
    addressId: number;
    logisticCode: number | null;
    taskIds: number[];
    driverIds: number[];
    sequencePositions: number[];
    minutesBetweenVisits: number;
    reason: string;
  }> = [];
  const byAddress = new Map<number, Array<{ driverId: number; sequence: number; task: LogisticsTaskForPhase2 }>>();
  for (const state of driverStates) {
    const ordered = [...state.assignedTasks].sort((a, b) => a.sequence - b.sequence);
    for (const assignment of ordered) {
      const task = taskById.get(assignment.taskId);
      if (!task || task.addressId == null) continue;
      if (!byAddress.has(task.addressId)) byAddress.set(task.addressId, []);
      byAddress.get(task.addressId)!.push({
        driverId: state.driverId,
        sequence: assignment.sequence,
        task,
      });
    }
  }

  for (const [addressId, rows] of byAddress.entries()) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => a.sequence - b.sequence);
    const driverIds = Array.from(new Set(rows.map((row) => row.driverId)));
    const taskIds = rows.map((row) => row.task.taskId);
    const sequencePositions = rows.map((row) => row.sequence);
    const logisticCode = rows[0]?.task.logisticCode ?? null;
    const maxGap = sequencePositions.reduce((max, cur, idx) => {
      if (idx === 0) return max;
      return Math.max(max, cur - sequencePositions[idx - 1]);
    }, 0);
    if (driverIds.length > 1 || maxGap > 1) {
      events.push({
        addressId,
        logisticCode,
        taskIds,
        driverIds,
        sequencePositions,
        minutesBetweenVisits: maxGap * LOGISTICS_TASK_DURATION_MIN,
        reason: driverIds.length > 1 ? "cross_driver_split" : "non_contiguous_same_driver",
      });
    }
  }
  return events;
}

export async function runLogisticsPhase2(
  workDate: string,
  unlockedTaskData: LogisticsTaskInputWithLock[],
  phase1: LogisticsPhase1Result,
  debugCollector?: LogisticsPhase2DebugCollector | null,
  competitiveGroupingExplicit?: boolean
): Promise<LogisticsPhase2Result> {
  let priorityWindows: PriorityWindows | null = null;
  try {
    priorityWindows = await loadPriorityStartWindows();
  } catch (error) {
    console.warn("[logistics-optimizer] Priority settings unavailable, continuing without priority windows:", error);
  }

  const reasonCounts: Record<LogisticsPhase2ReasonCode, number> = {
    CHECKIN_CHECKOUT_CONSTRAINT: 0,
    CLEANER_TIME_CONSTRAINT: 0,
    NO_DRIVER_FEASIBLE: 0,
    NO_TASK_CANDIDATES: 0,
    TRULY_IMPOSSIBLE: 0,
    ROUTE_CAPACITY_OR_ORDERING_CONFLICT: 0,
  };
  const performanceStats: LogisticsPhase2PerformanceStats = {
    scheduleBuildCount: 0,
    scheduleBuildElapsedMs: 0,
  };

  const phase2Tasks = buildPhase2Tasks(unlockedTaskData, phase1.taskCandidates);
  const competitiveGroupingEnabled = isCompetitiveGroupingEnabled(competitiveGroupingExplicit);
  const filteredByBagRule = filterTasksByBagRule(phase2Tasks);
  const bagPolicyExcludedTaskIds = filteredByBagRule.excludedTaskIds;
  const schedulableTasks = filteredByBagRule.included;
  // Step 4.5: identifica i cluster "stesso indirizzo" sull'intero set schedulabile
  // (popola task.addressId). Serve sia al pre-grouping prima del geo-fallback sia
  // alla penalità di split e al bonus di continuità nello scoring.
  const addressGroupsDetected = populateAddressIds(schedulableTasks);
  const taskById = new Map(schedulableTasks.map((task) => [task.taskId, task]));

  // Step 4.7-bis — Travel matrix precomputata sui task schedulabili. Letta da
  // tutte le helper di fragmentation / route linearity attraverso SimulationOptions.
  const travelMatrix = buildTravelMatrix(schedulableTasks);
  // Step 4.7-bis (Fix C, supporto) — Task feasibili come singleton dal depot:
  // fragmentation NON deve punire un candidato se il partner che lascia fuori è
  // comunque non assegnabile da nessun driver (stranded). Snapshot statico.
  const feasibleTaskIds = buildAssignableTaskIds(
    schedulableTasks,
    phase1.selectedDrivers,
    workDate,
    taskById,
    priorityWindows,
    performanceStats,
    travelMatrix
  );

  // Step 4.7-bis — KPI accumulators per il debug.
  let fragmentationPenaltyTotal = 0;
  let fragmentationCandidatesWithPenalty = 0;
  let fragmentationCandidatesCapped = 0;
  let fragmentationProtectedNearPairTotal = 0;
  const fragmentationEvents: FragmentationEvent[] = [];
  let routeLinearityDeltaTotal = 0;
  let routeLinearityDeltaAppliedTotal = 0;
  let routeLinearityDeltaBonusApplied = 0;
  const routeLinearityEvents: RouteLinearityEvent[] = [];

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
          competitiveGroupingEnabled,
          cleanerClusters: 0,
          geographicFallbackGroups: 0,
          singletonFallbackTasks: 0,
          fallbackTasks: 0,
          strongLocationClusters: 0,
          strongLocationClusterTasks: 0,
          addressGroupsDetected: 0,
        },
        performanceStats,
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
    if (competitiveGroupingEnabled) {
      const initialCandidates = buildAllCompetitiveCandidates(schedulableTasks, phase1, workDate);
      debugCollector.recordGroupsCreated(
        initialCandidates.map((candidate) => ({
          groupId: candidate.group.groupId,
          origin: candidate.group.origin,
          seedBandIndex: candidate.group.seedBandIndex,
          cleanerId: candidate.group.cleanerId ?? null,
          tasks: candidate.group.tasks.map((task) => ({
            taskId: task.taskId,
            logisticCode: task.logisticCode,
          })),
          groupingReason: candidate.group.groupingReason ?? defaultGroupingReason(candidate.group.origin),
          queueSortKey: buildQueueSortKeyForGroup(candidate.group, workDate),
        }))
      );
    } else {
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
    }
    debugCollector.setGroupingStats({
      competitiveGroupingEnabled,
      cleanerClusters: grouped.groupingStats.cleanerClusters,
      geographicFallbackGroups: grouped.groupingStats.geographicFallbackGroups,
      singletonFallbackTasks: grouped.groupingStats.singletonFallbackTasks,
      fallbackTasks: grouped.groupingStats.fallbackTasks,
      recoveredMissingTaskCount: missingTasks.length,
      duplicateGroupedTaskCount: duplicateTaskCount,
      strongLocationClusters: grouped.groupingStats.strongLocationClusters,
      strongLocationClusterTasks: grouped.groupingStats.strongLocationClusterTasks,
      addressGroupsDetected,
      competitiveCandidatesGenerated: 0,
      competitiveCandidatesSelectedByType: {
        CLEANER_SEQUENCE: 0,
        SAME_LOCATION: 0,
        NEARBY_MICRO: 0,
        SINGLETON: 0,
      },
      cleanerClusterBeatenBySameLocationCount: 0,
      sameLocationBeatenByCleanerClusterCount: 0,
      sameLocationSplitAcceptedCount: 0,
      sameLocationSplitAcceptedReasons: [],
      candidateOverlapInvalidationCount: 0,
      avgReturnToSameAddressAfterSplitMin: 0,
      selectedCandidateScoreGapP50: 0,
      selectedCandidateScoreGapP90: 0,
      sameLocationReturnEvents: [],
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
  let repairInsertedTasks = 0;
  const selectedByType: Record<CandidateType, number> = {
    CLEANER_SEQUENCE: 0,
    SAME_LOCATION: 0,
    NEARBY_MICRO: 0,
    SINGLETON: 0,
  };
  let competitiveCandidatesGenerated = 0;
  let cleanerClusterBeatenBySameLocationCount = 0;
  let sameLocationBeatenByCleanerClusterCount = 0;
  let sameLocationSplitAcceptedCount = 0;
  const sameLocationSplitAcceptedReasons: string[] = [];
  let candidateOverlapInvalidationCount = 0;
  const selectedScoreGaps: number[] = [];
  const debugUnassignedDetails: UnassignedTaskDebugJson[] = [];
  if (!competitiveGroupingEnabled) {
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
        taskById,
        priorityWindows,
        performanceStats,
        { travelMatrix }
      );

      if (bestState && bestSimulation) {
        applySimulationToDriverState(bestState, bestSimulation);
        groupsAssigned += 1;
        tasksAssigned += bestSimulation.assignments.length;
        if (bestSimulation.routeLinearityDelta != null) {
          routeLinearityDeltaTotal += bestSimulation.routeLinearityDelta;
        }
        if (bestSimulation.routeLinearityDeltaApplied != null) {
          routeLinearityDeltaAppliedTotal += bestSimulation.routeLinearityDeltaApplied;
          if (bestSimulation.routeLinearityDeltaApplied < 0) routeLinearityDeltaBonusApplied += 1;
        }
        if (bestSimulation.routeLinearityEvents) routeLinearityEvents.push(...bestSimulation.routeLinearityEvents);
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

      const legacyRemainingTasks = schedulableTasks.filter((task) => {
        // Considera "remaining" sia i task del gruppo corrente non assegnati sia quelli
        // ancora nei gruppi pendenti — è il vero pool da cui valutare i partner.
        const isInCurrentGroup = group.tasks.some((t) => t.taskId === task.taskId);
        if (isInCurrentGroup) return false;
        return pendingGroups.some((g) => g.tasks.some((t) => t.taskId === task.taskId));
      });
      const partialResult = findBestPartialGroupAssignment(
        group,
        driverStates,
        workDate,
        taskById,
        priorityWindows,
        performanceStats,
        {
          travelMatrix,
          feasibleTaskIds,
          remainingTasksForFragmentation: legacyRemainingTasks,
        }
      );
      if (partialResult) {
        const { choice: partialChoice, fragmentationPenalty: partialFragPenalty, fragmentation: partialFrag } = partialResult;
        applySimulationToDriverState(partialChoice.state, partialChoice.simulation);
        groupsAssigned += 1;
        partialGroupsAssigned += 1;
        tasksAssigned += partialChoice.simulation.assignments.length;
        if (partialFragPenalty > 0) {
          fragmentationPenaltyTotal += partialFragPenalty;
          fragmentationCandidatesWithPenalty += 1;
          if (partialFrag?.cappedByMax) fragmentationCandidatesCapped += 1;
          if (partialFrag) {
            fragmentationProtectedNearPairTotal += partialFrag.protectedNearPairCount;
            fragmentationEvents.push(...partialFrag.events);
          }
        }
        if (partialChoice.simulation.routeLinearityDelta != null) {
          routeLinearityDeltaTotal += partialChoice.simulation.routeLinearityDelta;
        }
        if (partialChoice.simulation.routeLinearityDeltaApplied != null) {
          routeLinearityDeltaAppliedTotal += partialChoice.simulation.routeLinearityDeltaApplied;
          if (partialChoice.simulation.routeLinearityDeltaApplied < 0) routeLinearityDeltaBonusApplied += 1;
        }
        if (partialChoice.simulation.routeLinearityEvents) {
          routeLinearityEvents.push(...partialChoice.simulation.routeLinearityEvents);
        }
        if (partialChoice.remainingGroup) {
          groupsSplit += 1;
          pendingGroups.unshift(partialChoice.remainingGroup);
        }
        if (debugCollector) {
          const partialRanking = getPartialChoiceRanking(
            partialChoice,
            driverStates,
            workDate,
            taskById,
            priorityWindows,
            performanceStats,
            { travelMatrix, fragmentationPenalty: partialFragPenalty }
          );
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
          getBestSingletonFailureReason(
            task,
            group,
            driverStates,
            workDate,
            taskById,
            priorityWindows,
            performanceStats
          );
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
  } else {
    const consumedTaskIds = new Set<number>();
    let previousPoolSize = 0;
    while (true) {
      const remainingTasks = schedulableTasks.filter((task) => !consumedTaskIds.has(task.taskId));
      if (remainingTasks.length === 0) break;

      const allCandidates = buildAllCompetitiveCandidates(remainingTasks, phase1, workDate);
      competitiveCandidatesGenerated += allCandidates.length;
      if (allCandidates.length === 0) break;
      if (previousPoolSize > 0) {
        candidateOverlapInvalidationCount += Math.max(0, previousPoolSize - allCandidates.length);
      }
      previousPoolSize = allCandidates.length;

      const ranked = rankCandidatesWithCheapScore(allCandidates, workDate);
      const topForLookahead = selectTopNOrUrgent(ranked, workDate, COMPETITIVE_TOP_N_LOOKAHEAD);
      groupsProcessed += 1;
      initialGroupsProcessed += 1;

      const bestPick =
        pickBestCompetitiveCandidate({
          candidates: topForLookahead,
          driverStates,
          workDate,
          taskById,
          priorityWindows,
          performanceStats,
          remainingTasks,
          travelMatrix,
          feasibleTaskIds,
        }) ??
        pickBestCompetitiveCandidate({
          candidates: ranked,
          driverStates,
          workDate,
          taskById,
          priorityWindows,
          performanceStats,
          remainingTasks,
          travelMatrix,
          feasibleTaskIds,
        });

      if (bestPick) {
        applySimulationToDriverState(bestPick.state, bestPick.simulation);
        groupsAssigned += 1;
        tasksAssigned += bestPick.simulation.assignments.length;
        selectedByType[bestPick.candidate.type] += 1;
        if (bestPick.scoreGapToRunnerUp != null) selectedScoreGaps.push(bestPick.scoreGapToRunnerUp);
        if (bestPick.sameLocationSplitAcceptedReason) {
          sameLocationSplitAcceptedCount += 1;
          sameLocationSplitAcceptedReasons.push(bestPick.sameLocationSplitAcceptedReason);
        }
        if (
          bestPick.candidate.type === "SAME_LOCATION" &&
          bestPick.competitorsConsidered.some((item) => item.feasible && item.type === "CLEANER_SEQUENCE")
        ) {
          cleanerClusterBeatenBySameLocationCount += 1;
        }
        if (
          bestPick.candidate.type === "CLEANER_SEQUENCE" &&
          bestPick.competitorsConsidered.some((item) => item.feasible && item.type === "SAME_LOCATION")
        ) {
          sameLocationBeatenByCleanerClusterCount += 1;
        }
        for (const taskId of bestPick.candidate.taskIds) consumedTaskIds.add(taskId);

        // Step 4.7-bis — KPI accumulators (fragmentation + linearity).
        if (bestPick.fragmentationPenalty > 0) {
          fragmentationPenaltyTotal += bestPick.fragmentationPenalty;
          fragmentationCandidatesWithPenalty += 1;
          if (bestPick.fragmentationPenaltyCapped) fragmentationCandidatesCapped += 1;
        }
        fragmentationProtectedNearPairTotal += bestPick.fragmentationProtectedNearPairCount;
        if (bestPick.fragmentationEvents.length > 0) fragmentationEvents.push(...bestPick.fragmentationEvents);
        routeLinearityDeltaTotal += bestPick.routeLinearityDelta;
        routeLinearityDeltaAppliedTotal += bestPick.routeLinearityDeltaApplied;
        if (bestPick.routeLinearityDeltaApplied < 0) routeLinearityDeltaBonusApplied += 1;
        if (bestPick.routeLinearityEvents.length > 0) routeLinearityEvents.push(...bestPick.routeLinearityEvents);

        if (debugCollector) {
          debugCollector.recordGroupDecision({
            step: groupsProcessed,
            groupId: bestPick.candidate.group.groupId,
            origin: bestPick.candidate.group.origin ?? "UNKNOWN",
            taskIds: bestPick.candidate.group.tasks.map((task) => task.taskId),
            logisticCodes: bestPick.candidate.group.tasks.map((task) => task.logisticCode),
            groupingReason: bestPick.candidate.group.groupingReason ?? defaultGroupingReason(bestPick.candidate.group.origin),
            outcome: "FULL_ASSIGNED",
            why: "best_competitive_candidate",
            winner: {
              driverId: bestPick.state.driverId,
              score: bestPick.finalScore,
              travelMinutesDelta: bestPick.simulation.travelMinutesDelta,
              projectedClockEnd: toHHMM(bestPick.simulation.projectedClockMin),
              taskOrder: bestPick.simulation.assignments.map((item) => item.taskId),
              schedule: mapAssignmentsToDebugSchedule(bestPick.simulation.assignments),
            },
            driverAttempts: bestPick.attempts,
            competitiveContext: {
              candidateType: bestPick.candidate.type,
              competitorsConsidered: bestPick.competitorsConsidered,
              scoreGapToRunnerUp: bestPick.scoreGapToRunnerUp,
              fragmentationPenalty: bestPick.fragmentationPenalty,
              fragmentationPenaltyCapped: bestPick.fragmentationPenaltyCapped,
              fragmentationProtectedNearPairCount: bestPick.fragmentationProtectedNearPairCount,
              fragmentationEvents: bestPick.fragmentationEvents,
              routeLinearityBefore: bestPick.routeLinearityBefore,
              routeLinearityAfter: bestPick.routeLinearityAfter,
              routeLinearityDelta: bestPick.routeLinearityDelta,
              routeLinearityDeltaApplied: bestPick.routeLinearityDeltaApplied,
              routeLinearityEvents: bestPick.routeLinearityEvents,
            },
          });
        }
        continue;
      }

      const partial = pickBestPartialAcrossCandidates({
        candidates: topForLookahead,
        driverStates,
        workDate,
        taskById,
        priorityWindows,
        performanceStats,
        remainingTasks,
        travelMatrix,
        feasibleTaskIds,
      });
      if (partial) {
        applySimulationToDriverState(partial.choice.state, partial.choice.simulation);
        groupsAssigned += 1;
        partialGroupsAssigned += 1;
        tasksAssigned += partial.choice.simulation.assignments.length;
        selectedByType[partial.candidate.type] += 1;
        for (const task of partial.choice.assignedGroup.tasks) consumedTaskIds.add(task.taskId);
        if (partial.choice.remainingGroup) groupsSplit += 1;

        if (partial.fragmentationPenalty > 0) {
          fragmentationPenaltyTotal += partial.fragmentationPenalty;
          fragmentationCandidatesWithPenalty += 1;
          if (partial.fragmentation?.cappedByMax) fragmentationCandidatesCapped += 1;
          if (partial.fragmentation) {
            fragmentationProtectedNearPairTotal += partial.fragmentation.protectedNearPairCount;
            fragmentationEvents.push(...partial.fragmentation.events);
          }
        }
        if (partial.choice.simulation.routeLinearityDelta != null) {
          routeLinearityDeltaTotal += partial.choice.simulation.routeLinearityDelta;
        }
        if (partial.choice.simulation.routeLinearityDeltaApplied != null) {
          routeLinearityDeltaAppliedTotal += partial.choice.simulation.routeLinearityDeltaApplied;
          if (partial.choice.simulation.routeLinearityDeltaApplied < 0) routeLinearityDeltaBonusApplied += 1;
        }
        if (partial.choice.simulation.routeLinearityEvents) {
          routeLinearityEvents.push(...partial.choice.simulation.routeLinearityEvents);
        }

        const { attempts } = buildDriverAttemptsForGroup(
          partial.candidate.group,
          driverStates,
          workDate,
          taskById,
          priorityWindows,
          performanceStats,
          { travelMatrix }
        );
        if (debugCollector) {
          debugCollector.recordGroupDecision({
            step: groupsProcessed,
            groupId: partial.candidate.group.groupId,
            origin: partial.candidate.group.origin ?? "UNKNOWN",
            taskIds: partial.candidate.group.tasks.map((task) => task.taskId),
            logisticCodes: partial.candidate.group.tasks.map((task) => task.logisticCode),
            groupingReason: partial.candidate.group.groupingReason ?? defaultGroupingReason(partial.candidate.group.origin),
            outcome: "PARTIAL_ASSIGNED",
            why: "competitive_partial_assignment",
            winner: {
              driverId: partial.choice.state.driverId,
              score: partial.choice.simulation.score,
              travelMinutesDelta: partial.choice.simulation.travelMinutesDelta,
              projectedClockEnd: toHHMM(partial.choice.simulation.projectedClockMin),
              taskOrder: partial.choice.simulation.assignments.map((item) => item.taskId),
              schedule: mapAssignmentsToDebugSchedule(partial.choice.simulation.assignments),
            },
            partial: {
              assignedTaskIds: partial.choice.assignedGroup.tasks.map((task) => task.taskId),
              remainingGroupId: partial.choice.remainingGroup?.groupId ?? null,
              expectedRecoverableTasks: partial.ranking.expectedRecoverableTasks,
              assignedSize: partial.ranking.assignedSize,
              remainingFeasibleOnSomeDriver: partial.ranking.remainingFeasibleOnSomeDriver,
            },
            driverAttempts: attempts,
            competitiveContext: {
              candidateType: partial.candidate.type,
              competitorsConsidered: ranked.map((item) => ({
                id: item.id,
                type: item.type,
                score: item.preScore,
                feasible: true,
              })),
              scoreGapToRunnerUp: null,
              fragmentationPenalty: partial.fragmentationPenalty,
              fragmentationPenaltyCapped: partial.fragmentation?.cappedByMax ?? false,
              fragmentationProtectedNearPairCount: partial.fragmentation?.protectedNearPairCount ?? 0,
              fragmentationEvents: partial.fragmentation?.events ?? [],
              routeLinearityBefore: partial.choice.simulation.routeLinearityBefore ?? 0,
              routeLinearityAfter: partial.choice.simulation.routeLinearityAfter ?? 0,
              routeLinearityDelta: partial.choice.simulation.routeLinearityDelta ?? 0,
              routeLinearityDeltaApplied: partial.choice.simulation.routeLinearityDeltaApplied ?? 0,
              routeLinearityEvents: partial.choice.simulation.routeLinearityEvents ?? [],
            },
          });
        }
        continue;
      }

      // Nessuna assegnazione possibile: evita loop infinito e lascia la classificazione finale.
      break;
    }
  }

  repairInsertedTasks = repairUnassignedTasksWithInsertion({
    unassignedTasks,
    debugUnassignedDetails,
    driverStates,
    taskById,
    bandIndexByTaskId,
    workDate,
    priorityWindows,
    performanceStats,
    reasonCounts,
    debugCollector,
    stepStart: groupsProcessed,
  });
  tasksAssigned += repairInsertedTasks;

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

  classifyFinalUnassignedTasks({
    unassignedTasks,
    debugUnassignedDetails,
    selectedDrivers: phase1.selectedDrivers,
    taskById,
    workDate,
    priorityWindows,
    performanceStats,
    reasonCounts,
  });

  const sortedScoreGaps = [...selectedScoreGaps].sort((a, b) => a - b);
  const percentileScoreGap = (percentile: number): number => {
    if (sortedScoreGaps.length === 0) return 0;
    const idx = Math.min(
      sortedScoreGaps.length - 1,
      Math.max(0, Math.round((percentile / 100) * (sortedScoreGaps.length - 1)))
    );
    return sortedScoreGaps[idx];
  };
  const sameLocationReturnEvents = collectSameLocationReturnEvents(driverStates, taskById);
  const avgReturnToSameAddressAfterSplitMin = sameLocationReturnEvents.length === 0
    ? 0
    : sameLocationReturnEvents.reduce((sum, item) => sum + item.minutesBetweenVisits, 0) /
      sameLocationReturnEvents.length;

  let debugDir: string | undefined;
  if (debugCollector) {
    debugCollector.setGroupingStats({
      ...(debugCollector.groupingStats ?? {
        competitiveGroupingEnabled,
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
      repairInsertedTasks,
      competitiveCandidatesGenerated,
      competitiveCandidatesSelectedByType: selectedByType,
      cleanerClusterBeatenBySameLocationCount,
      sameLocationBeatenByCleanerClusterCount,
      sameLocationSplitAcceptedCount,
      sameLocationSplitAcceptedReasons,
      candidateOverlapInvalidationCount,
      avgReturnToSameAddressAfterSplitMin,
      selectedCandidateScoreGapP50: percentileScoreGap(50),
      selectedCandidateScoreGapP90: percentileScoreGap(90),
      sameLocationReturnEvents,
      // Step 4.7-bis KPI
      fragmentationPenaltyTotal,
      fragmentationPenaltyAvgPerCandidate:
        fragmentationCandidatesWithPenalty > 0
          ? Math.round((fragmentationPenaltyTotal / fragmentationCandidatesWithPenalty) * 100) / 100
          : 0,
      fragmentationCandidatesWithPenalty,
      fragmentationCandidatesCapped,
      fragmentationProtectedNearPairTotal,
      fragmentationEventCount: fragmentationEvents.length,
      routeLinearityDeltaTotal: Math.round(routeLinearityDeltaTotal * 100) / 100,
      routeLinearityDeltaAppliedTotal: Math.round(routeLinearityDeltaAppliedTotal * 100) / 100,
      routeLinearityDeltaBonusAppliedCount: routeLinearityDeltaBonusApplied,
      routeLinearityEventCount: routeLinearityEvents.length,
    });
    debugCollector.recordUnassignedTasks(debugUnassignedDetails);
    debugCollector.setSummary(
      {
        groupsProcessed,
        groupsAssigned,
        groupsUnassigned,
        tasksAssigned,
        tasksUnassigned: unassignedTasks.length,
        repairInsertedTasks,
        scheduleBuildCount: performanceStats.scheduleBuildCount,
        scheduleBuildElapsedMs: performanceStats.scheduleBuildElapsedMs,
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
        competitiveGroupingEnabled,
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
        repairInsertedTasks,
        strongLocationClusters: grouped.groupingStats.strongLocationClusters,
        strongLocationClusterTasks: grouped.groupingStats.strongLocationClusterTasks,
        addressGroupsDetected,
        competitiveCandidatesGenerated,
        competitiveCandidatesSelectedByType: selectedByType,
        cleanerClusterBeatenBySameLocationCount,
        sameLocationBeatenByCleanerClusterCount,
        sameLocationSplitAcceptedCount,
        sameLocationSplitAcceptedReasons,
        candidateOverlapInvalidationCount,
        avgReturnToSameAddressAfterSplitMin,
        selectedCandidateScoreGapP50: percentileScoreGap(50),
        selectedCandidateScoreGapP90: percentileScoreGap(90),
        sameLocationReturnEvents,
      },
      performanceStats,
    },
  };
}

