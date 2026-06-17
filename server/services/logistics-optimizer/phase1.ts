import { pgDailyAssignmentsService } from "../pg-daily-assignments-service";
import { LogisticsTaskInputWithLock } from "./phase0";

export interface LogisticsSelectedDriver {
  id: number;
  startTime: string;
}

export interface LogisticsDriverBand {
  driverId: number;
  bandIndex: number;
  startLat: number;
  endLat: number;
  taskCount: number;
}

export interface LogisticsTaskCandidate {
  taskId: number;
  logisticCode: number;
  lat: number;
  lng: number;
  priority: string | null;
}

export interface LogisticsBandAssignment {
  taskId: number;
  logisticCode: number;
  assignedBandIndex: number;
  assignedDriverId: number;
  lat: number;
}

export interface LogisticsPhase1Validation {
  noSelectedDrivers: boolean;
  tasksExcludedNoCoordinatesCount: number;
  tasksExcludedNoCoordinatesIds: number[];
  driversWithoutTasks: number[];
}

export interface LogisticsPhase1Result {
  canRun: boolean;
  phase: 1;
  workDate: string;
  selectedDriversCount: number;
  selectedDrivers: LogisticsSelectedDriver[];
  taskCandidatesCount: number;
  taskCandidates: LogisticsTaskCandidate[];
  driverBands: LogisticsDriverBand[];
  bandAssignments: LogisticsBandAssignment[];
  validation: LogisticsPhase1Validation;
  reasonCode?: string;
}

function toFiniteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeStartTime(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "10:00";
  return raw.length >= 5 ? raw.slice(0, 5) : "10:00";
}

function computeBandIndex(lat: number, latMin: number, latMax: number, bandsCount: number): number {
  if (bandsCount <= 1) return 0;
  const span = latMax - latMin;
  if (span <= 0) return 0;

  const normalized = (lat - latMin) / span;
  const clamped = Math.max(0, Math.min(1, normalized));
  const idx = Math.floor(clamped * bandsCount);
  return Math.max(0, Math.min(bandsCount - 1, idx >= bandsCount ? bandsCount - 1 : idx));
}

async function loadSelectedDrivers(workDate: string): Promise<LogisticsSelectedDriver[]> {
  const selectedIds = await pgDailyAssignmentsService.loadSelectedLogisticsDrivers(workDate);
  if (!selectedIds || selectedIds.length === 0) return [];

  const uniqueIdsInOrder = Array.from(
    selectedIds
      .map((id: unknown) => Number(id))
      .filter((id) => Number.isFinite(id))
      .reduce((acc, id) => {
        if (!acc.includes(id)) acc.push(id);
        return acc;
      }, [] as number[])
  );

  if (uniqueIdsInOrder.length === 0) return [];

  const rows = await pgDailyAssignmentsService.loadLgDriversByIds(uniqueIdsInOrder, workDate);
  const byId = new Map<number, any>(
    (rows || []).map((row: any) => [Number(row.id), row])
  );

  return uniqueIdsInOrder.map((id) => ({
    id,
    startTime: normalizeStartTime(byId.get(id)?.start_time),
  }));
}

function buildTaskCandidates(unlockedTaskData: LogisticsTaskInputWithLock[]): {
  taskCandidates: LogisticsTaskCandidate[];
  excludedNoCoordinatesIds: number[];
} {
  const taskCandidates: LogisticsTaskCandidate[] = [];
  const excludedNoCoordinatesIds: number[] = [];

  for (const task of unlockedTaskData) {
    const lat = toFiniteNumber(task.lat);
    const lng = toFiniteNumber(task.lng);
    if (lat === null || lng === null) {
      excludedNoCoordinatesIds.push(task.taskId);
      continue;
    }

    taskCandidates.push({
      taskId: task.taskId,
      logisticCode: task.logisticCode,
      lat,
      lng,
      priority: task.priority ?? null,
    });
  }

  return { taskCandidates, excludedNoCoordinatesIds };
}

export async function runLogisticsPhase1(
  workDate: string,
  unlockedTaskData: LogisticsTaskInputWithLock[]
): Promise<LogisticsPhase1Result> {
  const selectedDrivers = await loadSelectedDrivers(workDate);
  const selectedDriversCount = selectedDrivers.length;

  if (selectedDriversCount === 0) {
    return {
      canRun: false,
      phase: 1,
      workDate,
      selectedDriversCount: 0,
      selectedDrivers: [],
      taskCandidatesCount: 0,
      taskCandidates: [],
      driverBands: [],
      bandAssignments: [],
      validation: {
        noSelectedDrivers: true,
        tasksExcludedNoCoordinatesCount: 0,
        tasksExcludedNoCoordinatesIds: [],
        driversWithoutTasks: [],
      },
      reasonCode: "NO_SELECTED_DRIVERS",
    };
  }

  const { taskCandidates, excludedNoCoordinatesIds } = buildTaskCandidates(unlockedTaskData);
  const taskCandidatesCount = taskCandidates.length;

  const latValues = taskCandidates.map((t) => t.lat);
  const latMin = latValues.length > 0 ? Math.min(...latValues) : 0;
  const latMax = latValues.length > 0 ? Math.max(...latValues) : 0;
  const bandsCount = selectedDriversCount;

  const bandHeight = bandsCount > 0 ? (latMax - latMin) / bandsCount : 0;
  const driverBands: LogisticsDriverBand[] = selectedDrivers.map((driver, bandIndex) => {
    const startLat = latMin + bandHeight * bandIndex;
    const endLat = bandIndex === bandsCount - 1 ? latMax : latMin + bandHeight * (bandIndex + 1);
    return {
      driverId: driver.id,
      bandIndex,
      startLat,
      endLat,
      taskCount: 0,
    };
  });

  const bandAssignments: LogisticsBandAssignment[] = taskCandidates.map((task) => {
    const assignedBandIndex = computeBandIndex(task.lat, latMin, latMax, bandsCount);
    const assignedDriverId = selectedDrivers[assignedBandIndex]?.id ?? selectedDrivers[0].id;
    return {
      taskId: task.taskId,
      logisticCode: task.logisticCode,
      assignedBandIndex,
      assignedDriverId,
      lat: task.lat,
    };
  });

  for (const assignment of bandAssignments) {
    if (driverBands[assignment.assignedBandIndex]) {
      driverBands[assignment.assignedBandIndex].taskCount += 1;
    }
  }

  const driversWithoutTasks = driverBands
    .filter((band) => band.taskCount === 0)
    .map((band) => band.driverId);

  return {
    canRun: true,
    phase: 1,
    workDate,
    selectedDriversCount,
    selectedDrivers,
    taskCandidatesCount,
    taskCandidates,
    driverBands,
    bandAssignments,
    validation: {
      noSelectedDrivers: false,
      tasksExcludedNoCoordinatesCount: excludedNoCoordinatesIds.length,
      tasksExcludedNoCoordinatesIds: excludedNoCoordinatesIds,
      driversWithoutTasks,
    },
  };
}
