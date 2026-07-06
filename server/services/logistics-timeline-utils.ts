import * as workspaceFiles from "./workspace-files";
import { minutesToHm, parseHmToMinutes } from "../../shared/logistics-scheduling-constraints";
import { estimateLogisticsReturnToDepotMinutes } from "../../shared/logistics-travel-estimate";
export {
  estimateLogisticsCarTravelMinutes as estimateCarTravelMinutes,
  LOGISTICS_DEPOT_LAT,
  LOGISTICS_DEPOT_LNG,
} from "../../shared/logistics-travel-estimate";
import {
  buildLogisticsScheduleForDriver,
  type LogisticsScheduleTaskInput,
} from "./logistics-optimizer/logistics-driver-schedule";
import {
  loadPriorityStartWindows,
  mapPriorityType,
  type PriorityWindows,
} from "./optimizer/priorityWindows";

export async function getDriverStartTime(driverId: number, workDate: string): Promise<string | null> {
  try {
    const sel = await workspaceFiles.loadSelectedLogisticsDrivers(workDate);
    if (sel?.drivers) {
      const d = sel.drivers.find((x: any) => x.id === driverId);
      if (d?.start_time) return d.start_time;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function hydrateTasksFromLogisticsContainers(driverData: any, workDate: string): Promise<any> {
  if (!driverData?.tasks || driverData.tasks.length === 0) {
    return driverData;
  }
  try {
    const { query } = await import("../../shared/pg-db");
    const taskIds = driverData.tasks.map((t: any) => t.task_id).filter((id: any) => id != null);
    if (taskIds.length === 0) return driverData;
    const result = await query(
      `
      SELECT task_id, lat, lng, address FROM (
        SELECT task_id, lat::numeric, lng::numeric, address FROM lg_timeline
        WHERE work_date = $1 AND task_id = ANY($2)
        UNION ALL
        SELECT task_id, lat::numeric, lng::numeric, address FROM lg_containers
        WHERE work_date = $1 AND task_id = ANY($2)
      ) combined
    `,
      [workDate, taskIds]
    );
    const coordsMap = new Map<number, { lat: number | null; lng: number | null; address: string | null }>();
    for (const row of result.rows) {
      const taskIdNum = parseInt(String(row.task_id), 10);
      if (!coordsMap.has(taskIdNum)) {
        const lat = row.lat != null ? parseFloat(String(row.lat)) : null;
        const lng = row.lng != null ? parseFloat(String(row.lng)) : null;
        coordsMap.set(taskIdNum, {
          lat: lat && !isNaN(lat) && Math.abs(lat) > 0.0001 ? lat : null,
          lng: lng && !isNaN(lng) && Math.abs(lng) > 0.0001 ? lng : null,
          address: row.address || null,
        });
      }
    }
    for (const task of driverData.tasks) {
      const taskIdNum = parseInt(String(task.task_id), 10);
      const geo = coordsMap.get(taskIdNum);
      if (geo) {
        if (geo.lat !== null) task.lat = geo.lat;
        if (geo.lng !== null) task.lng = geo.lng;
        if (geo.address && !task.address) task.address = geo.address;
      }
    }
  } catch (error: any) {
    console.warn(`⚠️ hydrateTasksFromLogisticsContainers: ${error.message}`);
  }
  return driverData;
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getLogisticsTaskKey(task: any): string | null {
  const taskId = Number(task?.task_id);
  if (Number.isFinite(taskId) && taskId > 0) return `task:${taskId}`;
  const logisticCode = Number(task?.logistic_code);
  if (Number.isFinite(logisticCode) && logisticCode > 0) return `code:${logisticCode}`;
  return null;
}

export function dedupeLogisticsTimelineAssignments(
  timeline: { drivers_assignments?: any[] } | null | undefined
): boolean {
  if (!Array.isArray(timeline?.drivers_assignments)) return false;

  let changed = false;
  const mergedByDriver = new Map<number, any>();
  const mergedEntries: any[] = [];

  for (const entry of timeline.drivers_assignments) {
    const driverId = Number(entry?.driver?.id);
    if (!Number.isFinite(driverId)) {
      mergedEntries.push(entry);
      continue;
    }

    const existing = mergedByDriver.get(driverId);
    if (existing) {
      existing.tasks = [
        ...(Array.isArray(existing.tasks) ? existing.tasks : []),
        ...(Array.isArray(entry?.tasks) ? entry.tasks : []),
      ];
      changed = true;
      continue;
    }

    const normalizedEntry = {
      ...entry,
      tasks: Array.isArray(entry?.tasks) ? [...entry.tasks] : [],
    };
    mergedByDriver.set(driverId, normalizedEntry);
    mergedEntries.push(normalizedEntry);
  }

  const seenTasks = new Set<string>();
  for (const entry of mergedEntries) {
    if (!Array.isArray(entry?.tasks)) {
      entry.tasks = [];
      continue;
    }

    const dedupedTasks: any[] = [];
    for (const task of entry.tasks) {
      const key = getLogisticsTaskKey(task);
      if (key && seenTasks.has(key)) {
        changed = true;
        continue;
      }
      if (key) seenTasks.add(key);
      dedupedTasks.push(task);
    }

    entry.tasks = dedupedTasks
      .sort((left, right) => Number(left?.sequence || 0) - Number(right?.sequence || 0))
      .map((task, index) => ({
        ...task,
        sequence: index + 1,
        followup: index > 0,
      }));
  }

  if (changed) {
    timeline.drivers_assignments = mergedEntries;
  }
  return changed;
}

export function snapshotLogisticsTimelineSchedule(
  timeline: { drivers_assignments?: any[] } | null | undefined
): string {
  const entries = Array.isArray(timeline?.drivers_assignments) ? timeline.drivers_assignments : [];
  const snapshot = entries
    .map((entry) => {
      const tasks = Array.isArray(entry?.tasks) ? entry.tasks : [];
      return {
        driverId: Number(entry?.driver?.id ?? 0),
        driverStartTime: entry?.driver?.start_time ?? null,
        tasks: tasks
          .map((task: any) => ({
            taskId: Number(task?.task_id ?? 0),
            sequence: Number(task?.sequence ?? 0),
            startTime: task?.start_time ?? null,
            endTime: task?.end_time ?? null,
            travelTime: Number(task?.travel_time ?? 0),
            checkoutWaitMinutes: Number(task?.checkout_wait_minutes ?? 0),
          }))
          .sort((left, right) => left.sequence - right.sequence || left.taskId - right.taskId),
      };
    })
    .sort((left, right) => left.driverId - right.driverId);
  return JSON.stringify(snapshot);
}

/** Logistics-only recalc: route travel + fixed service window (15m). */
export async function recalculateLogisticsDriverTimes(
  entry: any,
  workDate?: string,
  priorityWindows: PriorityWindows | null = null
): Promise<any> {
  const dateToUse = workDate || new Date().toISOString().slice(0, 10);
  const driver = entry.driver || {};
  const startTime = await getDriverStartTime(driver.id, dateToUse);
  if (startTime) {
    entry.driver.start_time = startTime;
  }

  // Preserve array order: DnD mutations splice entry.tasks directly; sorting by stale
  // sequence values would undo manual reorders before times are recalculated.
  const tasks: any[] = Array.isArray(entry.tasks) ? [...entry.tasks] : [];
  if (tasks.length === 0) {
    entry.tasks = [];
    entry.return_travel_time = 0;
    return entry;
  }

  const driverStartMin = parseHmToMinutes(entry.driver?.start_time, 10 * 60) ?? 10 * 60;
  const scheduleInputs: LogisticsScheduleTaskInput[] = tasks.map((task) => ({
    taskId: Number(task.task_id),
    logisticCode: Number(task.logistic_code),
    lat: toFiniteNumber(task?.lat),
    lng: toFiniteNumber(task?.lng),
    priorityType: mapPriorityType(task?.priority ?? null),
    checkoutTime: task.checkout_time ?? null,
    checkoutDate: task.checkout_date ?? null,
    checkinTime: task.checkin_time ?? null,
    checkinDate: task.checkin_date ?? null,
    travelMinutesFromPrevious: toFiniteNumber(task?.travel_time),
  }));

  const built = buildLogisticsScheduleForDriver({
    tasks: scheduleInputs,
    driverStartMin,
    workDate: dateToUse,
    priorityWindows,
  });

  if (built.effectiveDriverStartMin !== driverStartMin) {
    entry.driver.start_time = minutesToHm(built.effectiveDriverStartMin);
  }

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const row = built.tasks[i];
    if (!row) continue;
    task.travel_time = row.travelMinutes;
    task.checkout_wait_minutes = row.checkoutWaitMinutes;
    task.checkout_wait_exceeded = row.checkoutWaitExceeded;
    task._checkin_violated = row.checkinViolated || row.startAtOrAfterCheckin;
    task.start_time = row.startTime;
    task.end_time = row.endTime;
    task.sequence = row.sequence;
    task.followup = i > 0;
  }

  entry.tasks = tasks;
  const lastTask = tasks[tasks.length - 1];
  entry.return_travel_time = estimateLogisticsReturnToDepotMinutes(lastTask);
  return entry;
}

/** Ricalcolo di tutti i driver prima del salvataggio (es. apply ottimizzatore). */
export async function recalculateLogisticsTimeline(
  timeline: { drivers_assignments?: any[] },
  workDate: string
): Promise<boolean> {
  const entries = timeline.drivers_assignments;
  if (!Array.isArray(entries)) return false;

  const before = snapshotLogisticsTimelineSchedule(timeline);
  dedupeLogisticsTimelineAssignments(timeline);

  let priorityWindows: PriorityWindows | null = null;
  try {
    priorityWindows = await loadPriorityStartWindows();
  } catch (error) {
    console.warn("⚠️ recalculateLogisticsTimeline: priority windows unavailable, proceeding without them", error);
  }

  for (let i = 0; i < timeline.drivers_assignments.length; i++) {
    const entry = timeline.drivers_assignments[i];
    if (!entry?.tasks?.length) continue;
    await hydrateTasksFromLogisticsContainers(entry, workDate);
    timeline.drivers_assignments[i] = await recalculateLogisticsDriverTimes(entry, workDate, priorityWindows);
  }

  return snapshotLogisticsTimelineSchedule(timeline) !== before;
}

/** Ricalcolo completo di un driver dopo DnD / mutazioni manuali (hydrate + priority windows). */
export async function recalculateLogisticsDriverEntry(
  entry: any,
  workDate: string
): Promise<any> {
  await hydrateTasksFromLogisticsContainers(entry, workDate);

  let priorityWindows: PriorityWindows | null = null;
  try {
    priorityWindows = await loadPriorityStartWindows();
  } catch (error) {
    console.warn(
      "⚠️ recalculateLogisticsDriverEntry: priority windows unavailable, proceeding without them",
      error
    );
  }

  return recalculateLogisticsDriverTimes(entry, workDate, priorityWindows);
}

export function pruneEmptyLogisticsDriverAssignments(timeline: { drivers_assignments?: any[] }): void {
  if (!Array.isArray(timeline?.drivers_assignments)) return;
  timeline.drivers_assignments = timeline.drivers_assignments.filter(
    (entry) => Array.isArray(entry?.tasks) && entry.tasks.length > 0
  );
}
