import { estimateCarTravelMinutes } from "../logistics-timeline-utils";
import { LogisticsTaskInputWithLock } from "./phase0";
import { LogisticsPhase1Result, LogisticsSelectedDriver, LogisticsTaskCandidate } from "./phase1";
import { computeBagPolicy } from "./bag-rule";

const LOGISTICS_TASK_DURATION_MIN = 15;
const GROUP_MAX_TASKS = 4;
const GROUP_NEARBY_THRESHOLD_MIN = 8;

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
  validation: {
    noTaskCandidates: boolean;
    bagPolicyExcludedCount: number;
    bagPolicyExcludedTaskIds: number[];
    reasonCounts: Record<LogisticsPhase2ReasonCode, number>;
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

function getCheckinCheckoutViolation(
  task: LogisticsTaskForPhase2,
  workDate: string,
  taskStartMin: number,
  taskEndMin: number
): boolean {
  if (isDateCompatibleWithWorkDate(task.checkoutDate, workDate) && task.checkoutTime) {
    const checkoutMin = parseMinutes(task.checkoutTime, 0);
    if (taskStartMin < checkoutMin) return true;
  }
  if (isDateCompatibleWithWorkDate(task.checkinDate, workDate) && task.checkinTime) {
    const checkinMin = parseMinutes(task.checkinTime, 23 * 60 + 59);
    if (taskEndMin > checkinMin) return true;
  }
  return false;
}

function getCleanerViolation(task: LogisticsTaskForPhase2, taskEndMin: number): boolean {
  if (!task.cleanerStartTime) return false;
  const cleanerStartMin = parseMinutes(task.cleanerStartTime, 23 * 60 + 59);
  return taskEndMin >= cleanerStartMin;
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

function buildSpatialGroups(
  tasks: LogisticsTaskForPhase2[],
  phase1: LogisticsPhase1Result
): SpatialGroup[] {
  const taskById = new Map<number, LogisticsTaskForPhase2>();
  tasks.forEach((task) => taskById.set(task.taskId, task));

  const tasksByBand = new Map<number, LogisticsTaskForPhase2[]>();
  for (const assignment of phase1.bandAssignments) {
    const task = taskById.get(assignment.taskId);
    if (!task) continue;
    if (!tasksByBand.has(assignment.assignedBandIndex)) {
      tasksByBand.set(assignment.assignedBandIndex, []);
    }
    tasksByBand.get(assignment.assignedBandIndex)!.push(task);
  }

  const groups: SpatialGroup[] = [];
  for (const [bandIndex, bandTasks] of tasksByBand.entries()) {
    const pending = [...bandTasks].sort((a, b) => a.lat - b.lat || a.lng - b.lng);
    let groupCounter = 0;
    while (pending.length > 0) {
      const seed = pending.shift()!;
      const currentGroup: LogisticsTaskForPhase2[] = [seed];

      while (currentGroup.length < GROUP_MAX_TASKS && pending.length > 0) {
        let bestIdx = -1;
        let bestTravel = Number.POSITIVE_INFINITY;
        for (let i = 0; i < pending.length; i++) {
          const candidate = pending[i];
          const avgLat = currentGroup.reduce((sum, t) => sum + t.lat, 0) / currentGroup.length;
          const avgLng = currentGroup.reduce((sum, t) => sum + t.lng, 0) / currentGroup.length;
          const travelMin = estimateCarTravelMinutes(
            { lat: avgLat, lng: avgLng },
            { lat: candidate.lat, lng: candidate.lng }
          );
          if (travelMin < bestTravel) {
            bestTravel = travelMin;
            bestIdx = i;
          }
        }
        if (bestIdx === -1 || bestTravel > GROUP_NEARBY_THRESHOLD_MIN) {
          break;
        }
        currentGroup.push(pending.splice(bestIdx, 1)[0]);
      }

      groups.push({
        groupId: `band-${bandIndex}-group-${groupCounter}`,
        seedBandIndex: bandIndex,
        tasks: currentGroup,
      });
      groupCounter += 1;
    }
  }

  return groups.sort((a, b) => {
    const aDeadline = Math.min(
      ...a.tasks.map((task) => {
        const checkin = task.checkinTime ? parseMinutes(task.checkinTime, 23 * 60 + 59) : 23 * 60 + 59;
        const cleaner = task.cleanerStartTime ? parseMinutes(task.cleanerStartTime, 23 * 60 + 59) : 23 * 60 + 59;
        return Math.min(checkin, cleaner);
      })
    );
    const bDeadline = Math.min(
      ...b.tasks.map((task) => {
        const checkin = task.checkinTime ? parseMinutes(task.checkinTime, 23 * 60 + 59) : 23 * 60 + 59;
        const cleaner = task.cleanerStartTime ? parseMinutes(task.cleanerStartTime, 23 * 60 + 59) : 23 * 60 + 59;
        return Math.min(checkin, cleaner);
      })
    );
    if (aDeadline !== bDeadline) return aDeadline - bDeadline;
    return b.tasks.length - a.tasks.length;
  });
}

function buildDriverStates(selectedDrivers: LogisticsSelectedDriver[]): DriverState[] {
  return selectedDrivers.map((driver, idx) => {
    const driverStartMin = parseMinutes(driver.startTime, 10 * 60);
    return {
      driverId: driver.id,
      driverIndex: idx,
      driverStartMin,
      clockMin: driverStartMin,
      lastLat: null,
      lastLng: null,
      totalTravelMinutes: 0,
      assignedTasks: [],
      cleanerLastSequence: new Map<number, number>(),
    };
  });
}

function getSequencePreferencePenalty(task: LogisticsTaskForPhase2, cleanerLastSequence: Map<number, number>): number {
  if (task.cleanerId == null || task.cleanerSequence == null) return 0;
  const cleanerId = task.cleanerId;
  const currentLastSequence = cleanerLastSequence.get(cleanerId) ?? 0;
  const expectedNext = currentLastSequence + 1;

  let penalty = 0;
  if (task.cleanerSequence > expectedNext) {
    penalty += (task.cleanerSequence - expectedNext) * 2;
  } else if (task.cleanerSequence < expectedNext) {
    penalty += (expectedNext - task.cleanerSequence) * 3;
  }

  // If cleaner already has the bag, sequence=1 is de-prioritized but still eligible.
  if (task.cleanerSequence === 1 && currentLastSequence === 0 && task.bagPolicy === "CLEANER_HAS_BAG") {
    penalty += 8;
  }

  return penalty;
}

function sortGroupTasksForDriver(group: SpatialGroup, state: DriverState): LogisticsTaskForPhase2[] {
  const remaining = [...group.tasks];
  const ordered: LogisticsTaskForPhase2[] = [];
  let currentLat = state.lastLat;
  let currentLng = state.lastLng;
  const cleanerLastSequence = new Map<number, number>(state.cleanerLastSequence);

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let i = 0; i < remaining.length; i++) {
      const task = remaining[i];
      const travel = currentLat != null && currentLng != null
        ? estimateCarTravelMinutes({ lat: currentLat, lng: currentLng }, { lat: task.lat, lng: task.lng })
        : 0;
      const deadline = task.cleanerStartTime
        ? parseMinutes(task.cleanerStartTime, 23 * 60 + 59)
        : task.checkinTime
          ? parseMinutes(task.checkinTime, 23 * 60 + 59)
          : 23 * 60 + 59;
      const sequencePenalty = getSequencePreferencePenalty(task, cleanerLastSequence);
      // Priority: feasibility is checked separately, then geography, then sequence.
      const score = travel * 100 + sequencePenalty * 10 + deadline / 10000;
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
  }

  return ordered;
}

function simulateGroupForDriver(
  group: SpatialGroup,
  state: DriverState,
  workDate: string
): GroupSimulationResult {
  const orderedTasks = sortGroupTasksForDriver(group, state);
  const schedule: LogisticsTaskSchedule[] = [];
  let clockMin = state.clockMin;
  let currentLat = state.lastLat;
  let currentLng = state.lastLng;
  let travelDelta = 0;
  const projectedCleanerLastSequence = new Map<number, number>(state.cleanerLastSequence);

  for (const task of orderedTasks) {
    const travelMinutes = currentLat != null && currentLng != null
      ? estimateCarTravelMinutes({ lat: currentLat, lng: currentLng }, { lat: task.lat, lng: task.lng })
      : 0;
    const taskStartMin = clockMin + travelMinutes;
    const taskEndMin = taskStartMin + LOGISTICS_TASK_DURATION_MIN;

    if (getCheckinCheckoutViolation(task, workDate, taskStartMin, taskEndMin)) {
      return {
        feasible: false,
        assignments: [],
        projectedClockMin: state.clockMin,
        projectedLastLat: state.lastLat,
        projectedLastLng: state.lastLng,
        projectedCleanerLastSequence: new Map<number, number>(state.cleanerLastSequence),
        travelMinutesDelta: 0,
        score: Number.NEGATIVE_INFINITY,
        failure: {
          reasonCode: "CHECKIN_CHECKOUT_CONSTRAINT",
          taskId: task.taskId,
        },
      };
    }

    if (getCleanerViolation(task, taskEndMin)) {
      return {
        feasible: false,
        assignments: [],
        projectedClockMin: state.clockMin,
        projectedLastLat: state.lastLat,
        projectedLastLng: state.lastLng,
        projectedCleanerLastSequence: new Map<number, number>(state.cleanerLastSequence),
        travelMinutesDelta: 0,
        score: Number.NEGATIVE_INFINITY,
        failure: {
          reasonCode: "CLEANER_TIME_CONSTRAINT",
          taskId: task.taskId,
        },
      };
    }

    schedule.push({
      taskId: task.taskId,
      logisticCode: task.logisticCode,
      startTime: toHHMM(taskStartMin),
      endTime: toHHMM(taskEndMin),
      travelMinutes,
      sequence: state.assignedTasks.length + schedule.length + 1,
      reasonCode: null,
    });

    clockMin = taskEndMin;
    travelDelta += travelMinutes;
    currentLat = task.lat;
    currentLng = task.lng;
    if (task.cleanerId != null && task.cleanerSequence != null) {
      const previous = projectedCleanerLastSequence.get(task.cleanerId) ?? 0;
      projectedCleanerLastSequence.set(task.cleanerId, Math.max(previous, task.cleanerSequence));
    }
  }

  const projectedTaskCount = state.assignedTasks.length + schedule.length;
  const projectedLoadMin = projectedTaskCount * LOGISTICS_TASK_DURATION_MIN;
  const fairnessPenalty = projectedLoadMin * 0.3 + projectedTaskCount * 2.5;
  const bandPenalty = Math.abs(group.seedBandIndex - state.driverIndex) * 3;
  const score = 1000 - travelDelta - fairnessPenalty - bandPenalty;

  return {
    feasible: true,
    assignments: schedule,
    projectedClockMin: clockMin,
    projectedLastLat: currentLat,
    projectedLastLng: currentLng,
    projectedCleanerLastSequence,
    travelMinutesDelta: travelDelta,
    score,
    failure: null,
  };
}

function incrementReasonCount(
  reasonCounts: Record<LogisticsPhase2ReasonCode, number>,
  reasonCode: LogisticsPhase2ReasonCode
): void {
  reasonCounts[reasonCode] += 1;
}

export async function runLogisticsPhase2(
  workDate: string,
  unlockedTaskData: LogisticsTaskInputWithLock[],
  phase1: LogisticsPhase1Result
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
      },
    };
  }

  const groups = buildSpatialGroups(schedulableTasks, phase1);
  const driverStates = buildDriverStates(phase1.selectedDrivers);
  const unassignedTasks: LogisticsPhase2UnassignedTask[] = [];
  let groupsAssigned = 0;
  let groupsUnassigned = 0;
  let tasksAssigned = 0;

  for (const group of groups) {
    let bestState: DriverState | null = null;
    let bestSimulation: GroupSimulationResult | null = null;
    let fallbackReason: LogisticsPhase2ReasonCode = "NO_DRIVER_FEASIBLE";

    for (const state of driverStates) {
      const simulation = simulateGroupForDriver(group, state, workDate);
      if (!simulation.feasible) {
        if (simulation.failure?.reasonCode) {
          fallbackReason = simulation.failure.reasonCode;
        }
        continue;
      }
      if (!bestSimulation || simulation.score > bestSimulation.score) {
        bestSimulation = simulation;
        bestState = state;
      }
    }

    if (!bestState || !bestSimulation) {
      groupsUnassigned += 1;
      for (const task of group.tasks) {
        incrementReasonCount(reasonCounts, fallbackReason);
        unassignedTasks.push({
          taskId: task.taskId,
          logisticCode: task.logisticCode,
          reasonCode: fallbackReason,
        });
      }
      continue;
    }

    bestState.assignedTasks.push(...bestSimulation.assignments);
    bestState.clockMin = bestSimulation.projectedClockMin;
    bestState.lastLat = bestSimulation.projectedLastLat;
    bestState.lastLng = bestSimulation.projectedLastLng;
    bestState.cleanerLastSequence = bestSimulation.projectedCleanerLastSequence;
    bestState.totalTravelMinutes += bestSimulation.travelMinutesDelta;

    groupsAssigned += 1;
    tasksAssigned += bestSimulation.assignments.length;
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
    }
  }

  return {
    canRun: true,
    phase: 2,
    workDate,
    groupsProcessed: groups.length,
    groupsAssigned,
    groupsUnassigned,
    tasksAssigned,
    tasksUnassigned: unassignedTasks.length,
    driverPlans,
    unassignedTasks,
    validation: {
      noTaskCandidates: false,
      bagPolicyExcludedCount: bagPolicyExcludedTaskIds.length,
      bagPolicyExcludedTaskIds,
      reasonCounts,
    },
  };
}

