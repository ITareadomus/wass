import pool from "../../../shared/pg-db";
import { loadLogisticsTimeline } from "../workspace-files";
import { pgDailyAssignmentsService } from "../pg-daily-assignments-service";
import { loadPriorityStartWindows, type PriorityWindows } from "../optimizer/priorityWindows";
import type {
  ExistingLockedAssignment,
  LogisticsWindowConfig,
  RawLogisticsTaskInput,
  TimelineAssignmentHint,
} from "./input-contract";
import { extractDriverOperationalCode } from "./groups/historical-territory-profiles";
import { loadTimelineAssignmentHints } from "./timeline-assignment-hints";
import { normalizeEndTime, normalizeStartTime, toFiniteNumber } from "./normalizers";

export type { RawLogisticsTaskInput, ExistingLockedAssignment, TimelineAssignmentHint };

export interface SelectedLogisticsDriverInput {
  id: number;
  startTime: string;
  startTimeSource: "driver_row" | "default";
  endTime: string;
  endTimeSource: "driver_row" | "default";
  operationalCode?: string;
}

export interface SchedulableLogisticsTaskInput extends RawLogisticsTaskInput {
  lat: number;
  lng: number;
}

export interface LogisticsRoutingSourceData {
  workDate: string;
  allTaskData: RawLogisticsTaskInput[];
  unlockedTaskData: RawLogisticsTaskInput[];
  schedulableTasks: SchedulableLogisticsTaskInput[];
  lockedTasksExcluded: number;
  tasksExcludedNoCoordinatesIds: number[];
  selectedDrivers: SelectedLogisticsDriverInput[];
  timelineAssignmentHints: TimelineAssignmentHint[];
  windowConfig: LogisticsWindowConfig;
}

export async function loadWindowConfig(workDate: string): Promise<LogisticsWindowConfig> {
  try {
    const priorityWindows: PriorityWindows = await loadPriorityStartWindows();
    return {
      source: "app_settings",
      workDate,
      priorityWindows,
      fallbackUsed: false,
    };
  } catch (error) {
    return {
      source: "unavailable",
      workDate,
      priorityWindows: null,
      fallbackUsed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function mapRowToRawTask(row: any): RawLogisticsTaskInput {
  return {
    taskId: Number(row.taskId),
    logisticCode: Number(row.logisticCode),
    priority: row.priority ? String(row.priority) : null,
    cleaningTime: row.cleaningTime != null ? Number(row.cleaningTime) : null,
    lat: row.lat != null ? Number(row.lat) : null,
    lng: row.lng != null ? Number(row.lng) : null,
    checkinDate: row.checkinDate ? String(row.checkinDate) : null,
    checkoutDate: row.checkoutDate ? String(row.checkoutDate) : null,
    checkinTime: row.checkinTime ? String(row.checkinTime).slice(0, 5) : null,
    checkoutTime: row.checkoutTime ? String(row.checkoutTime).slice(0, 5) : null,
    premium: row.premium === true,
    paxIn: row.paxIn != null ? Number(row.paxIn) : null,
    cleanerId: row.cleanerId != null ? Number(row.cleanerId) : null,
    cleanerStartTime: row.cleanerStartTime ? String(row.cleanerStartTime).slice(0, 5) : null,
    cleanerTaskStartTime: row.cleanerTaskStartTime ? String(row.cleanerTaskStartTime).slice(0, 5) : null,
    cleanerSequence: row.cleanerSequence != null ? Number(row.cleanerSequence) : null,
    locked: row.locked === true,
    lockedReason: row.lockedReason ? String(row.lockedReason) : null,
    logisticsTaskKind: row.logisticsTaskKind ? String(row.logisticsTaskKind) : null,
    logisticsTaskKindSource: row.logisticsTaskKindSource
      ? String(row.logisticsTaskKindSource)
      : null,
  };
}

export async function loadUnlockedLogisticsTasks(workDate: string): Promise<{
  allTaskData: RawLogisticsTaskInput[];
  unlockedTaskData: RawLogisticsTaskInput[];
  schedulableTasks: SchedulableLogisticsTaskInput[];
  lockedTasksExcluded: number;
  tasksExcludedNoCoordinatesIds: number[];
}> {
  const result = await pool.query(
    `
      SELECT
        lc.task_id AS "taskId",
        lc.logistic_code AS "logisticCode",
        lc.priority AS "priority",
        lc.cleaning_time AS "cleaningTime",
        lc.lat AS "lat",
        lc.lng AS "lng",
        lc.checkin_date::text AS "checkinDate",
        lc.checkout_date::text AS "checkoutDate",
        lc.checkin_time AS "checkinTime",
        lc.checkout_time AS "checkoutTime",
        lc.premium AS "premium",
        lc.pax_in AS "paxIn",
        cleaner_ctx.cleaner_id AS "cleanerId",
        cleaner_ctx.cleaner_start_time AS "cleanerStartTime",
        cleaner_ctx.cleaner_task_start_time AS "cleanerTaskStartTime",
        cleaner_ctx.cleaner_sequence AS "cleanerSequence",
        COALESCE(dtl.locked, lc.locked, false) AS "locked",
        COALESCE(dtl.locked_reason, lc.locked_reason) AS "lockedReason",
        lc.logistics_task_kind AS "logisticsTaskKind",
        lc.logistics_task_kind_source AS "logisticsTaskKindSource"
      FROM lg_containers lc
      LEFT JOIN daily_task_locks dtl
        ON dtl.work_date = lc.work_date
       AND dtl.task_id = lc.task_id
       AND dtl.locked = true
      LEFT JOIN LATERAL (
        SELECT
          dac.cleaner_id,
          dac.cleaner_start_time,
          dac.start_time AS cleaner_task_start_time,
          dac.sequence AS cleaner_sequence
        FROM daily_assignments_current dac
        WHERE dac.work_date = lc.work_date
          AND dac.task_id = lc.task_id
          AND (dac.scope = 'housekeeping' OR dac.scope IS NULL)
          AND dac.cleaner_id IS NOT NULL
        ORDER BY dac.id DESC
        LIMIT 1
      ) cleaner_ctx ON true
      WHERE lc.work_date = $1
      ORDER BY lc.task_id
    `,
    [workDate]
  );

  const allTaskData = result.rows.map(mapRowToRawTask);
  const unlockedTaskData = allTaskData.filter((task) => !task.locked);
  const tasksExcludedNoCoordinatesIds: number[] = [];
  const schedulableTasks: SchedulableLogisticsTaskInput[] = [];

  for (const task of unlockedTaskData) {
    const lat = toFiniteNumber(task.lat);
    const lng = toFiniteNumber(task.lng);
    if (lat === null || lng === null) {
      tasksExcludedNoCoordinatesIds.push(task.taskId);
      continue;
    }
    schedulableTasks.push({ ...task, lat, lng });
  }

  return {
    allTaskData,
    unlockedTaskData,
    schedulableTasks,
    lockedTasksExcluded: allTaskData.length - unlockedTaskData.length,
    tasksExcludedNoCoordinatesIds,
  };
}

export async function loadSelectedDrivers(workDate: string): Promise<SelectedLogisticsDriverInput[]> {
  const selectedIds = await pgDailyAssignmentsService.loadSelectedLogisticsDrivers(workDate);
  if (!selectedIds || selectedIds.length === 0) return [];

  const uniqueIdsInOrder = selectedIds
    .map((id: unknown) => Number(id))
    .filter((id) => Number.isFinite(id))
    .reduce((acc, id) => {
      if (!acc.includes(id)) acc.push(id);
      return acc;
    }, [] as number[]);

  if (uniqueIdsInOrder.length === 0) return [];

  const rows = await pgDailyAssignmentsService.loadLgDriversByIds(uniqueIdsInOrder, workDate);
  const byId = new Map<number, any>((rows || []).map((row: any) => [Number(row.id), row]));

  return uniqueIdsInOrder.map((id) => {
    const row = byId.get(id);
    const start = normalizeStartTime(row?.start_time);
    const end = normalizeEndTime(row?.end_time);
    return {
      id,
      startTime: start.time,
      startTimeSource: start.source,
      endTime: end.time,
      endTimeSource: end.source,
      operationalCode: extractDriverOperationalCode({
        name: row?.name,
        lastname: row?.lastname,
        alias: row?.alias,
      }),
    };
  });
}

export async function loadExistingLockedAssignments(workDate: string): Promise<ExistingLockedAssignment[]> {
  const timeline = await loadLogisticsTimeline(workDate);
  if (!Array.isArray(timeline?.drivers_assignments)) return [];

  const lockedAssignments: ExistingLockedAssignment[] = [];
  for (const driverAssignment of timeline.drivers_assignments) {
    const driverId = Number(driverAssignment?.driver?.id);
    if (!Number.isFinite(driverId)) continue;

    const tasks = Array.isArray(driverAssignment?.tasks) ? driverAssignment.tasks : [];
    for (const task of tasks) {
      const taskId = Number(task?.task_id);
      if (!Number.isFinite(taskId)) continue;

      const locked = task?.locked === true;
      const manuallyMoved = task?.manually_moved === true;
      if (!locked && !manuallyMoved) continue;

      lockedAssignments.push({
        driverId,
        taskId,
        sequence: Number.isFinite(Number(task?.sequence)) ? Number(task.sequence) : null,
        locked,
        manuallyMoved,
      });
    }
  }
  return lockedAssignments;
}

export async function loadLogisticsRoutingSourceData(workDate: string): Promise<LogisticsRoutingSourceData> {
  const [tasks, selectedDrivers, windowConfig, timelineAssignmentHints] = await Promise.all([
    loadUnlockedLogisticsTasks(workDate),
    loadSelectedDrivers(workDate),
    loadWindowConfig(workDate),
    loadTimelineAssignmentHints(workDate),
  ]);

  return {
    workDate,
    ...tasks,
    selectedDrivers,
    timelineAssignmentHints,
    windowConfig,
  };
}
