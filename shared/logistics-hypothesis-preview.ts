import { minutesToHm } from "./logistics-scheduling-constraints";
import type {
  LogisticsHypothesisSummary,
  LogisticsHypothesisTimelinePreview,
} from "./logistics-routing-hypotheses";

export interface LogisticsHypothesisPickerItem {
  summary: LogisticsHypothesisSummary;
  solution: unknown;
  preview?: LogisticsHypothesisTimelinePreview | null;
}

export type LogisticsHypothesisDriverRow = {
  id: number;
  name?: string;
  lastname?: string;
  alias?: string;
  start_time?: string | null;
  isRemoved?: boolean;
};

export type LogisticsHypothesisAssignmentRow = {
  driver: LogisticsHypothesisDriverRow;
  tasks: any[];
  return_travel_time?: number;
};

function asAssignmentRows(value: unknown): LogisticsHypothesisAssignmentRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is LogisticsHypothesisAssignmentRow =>
      Boolean(row) && typeof row === "object" && (row as { driver?: unknown }).driver != null
  );
}

function hasValue(value: unknown): boolean {
  return value != null && value !== "";
}

function overlayMissingTaskFields(target: any, source: any): any {
  if (!source) return target;
  const next = { ...target };
  const keys = [
    "hk_start_time",
    "hk_end_time",
    "hk_window",
    "cleaner_task_start_time",
    "cleanerTaskStartTime",
    "cleaner_start_time",
    "cleanerStartTime",
    "cleaner_id",
    "cleaner_sequence",
    "cleaning_time",
    "logistics_task_kind",
    "logistics_task_kind_source",
    "checkin_time",
    "checkin_date",
    "checkout_time",
    "checkout_date",
    "premium",
    "pax_in",
  ];
  for (const key of keys) {
    if (!hasValue(next[key]) && hasValue(source[key])) {
      next[key] = source[key];
    }
  }
  if (!hasValue(next.cleaner_task_start_time) && hasValue(source.cleanerTaskStartTime)) {
    next.cleaner_task_start_time = source.cleanerTaskStartTime;
  }
  if (!hasValue(next.hk_start_time)) {
    next.hk_start_time =
      next.cleaner_task_start_time ??
      source.hk_start_time ??
      source.cleaner_task_start_time ??
      source.cleanerTaskStartTime ??
      null;
  }
  return next;
}

function collectTaskSources(
  containerTasks: any[],
  baselineAssignments: LogisticsHypothesisAssignmentRow[]
): Map<number, any> {
  const byId = new Map<number, any>();
  const merge = (task: any) => {
    const taskId = Number(task?.task_id);
    if (!Number.isFinite(taskId)) return;
    const previous = byId.get(taskId);
    byId.set(taskId, previous ? overlayMissingTaskFields(previous, task) : task);
  };
  for (const task of containerTasks) merge(task);
  for (const row of baselineAssignments) {
    for (const task of row.tasks || []) merge(task);
  }
  return byId;
}

function assignmentsFromSolution(
  solution: unknown,
  drivers: LogisticsHypothesisDriverRow[],
  taskById: Map<number, any>
): LogisticsHypothesisAssignmentRow[] {
  const routes = Array.isArray((solution as { routes?: unknown[] } | null)?.routes)
    ? ((solution as { routes: any[] }).routes ?? [])
    : [];
  const byDriver = new Map<number, LogisticsHypothesisAssignmentRow>();

  for (const route of routes) {
    const driverId = Number(route?.driverId);
    if (!Number.isFinite(driverId)) continue;
    const driver = drivers.find((entry) => entry.id === driverId) ?? {
      id: driverId,
      name: "Driver",
    };
    const stops = Array.isArray(route?.stops) ? route.stops : [];
    byDriver.set(driverId, {
      driver: {
        ...driver,
        start_time: Number.isFinite(Number(route?.startMin))
          ? minutesToHm(Number(route.startMin))
          : driver.start_time,
      },
      tasks: stops.map((stop: any, index: number) => {
        const source = taskById.get(Number(stop?.taskId)) || {};
        return {
          ...source,
          task_id: stop.taskId,
          start_time: minutesToHm(Number(stop?.startMin) || 0),
          end_time: minutesToHm(Number(stop?.endMin) || 0),
          sequence: Number(stop?.sequence) || index + 1,
          travel_time: Number(stop?.travelFromPreviousMin || 0),
          checkout_wait_minutes: Number(stop?.waitMin || 0),
        };
      }),
    });
  }

  return drivers.map((driver) => byDriver.get(driver.id) ?? { driver, tasks: [] });
}

export function mergeHypothesisPreviewAssignments(args: {
  drivers: LogisticsHypothesisDriverRow[];
  preview?: LogisticsHypothesisTimelinePreview | null;
  solution: unknown;
  containerTasks: any[];
  baselineAssignments: LogisticsHypothesisAssignmentRow[];
}): LogisticsHypothesisAssignmentRow[] {
  const taskById = collectTaskSources(args.containerTasks, args.baselineAssignments);
  const previewRows = asAssignmentRows(args.preview?.drivers_assignments);
  const sourceRows =
    previewRows.length > 0
      ? previewRows.map((row) => ({
          ...row,
          tasks: (row.tasks || []).map((task) =>
            overlayMissingTaskFields(task, taskById.get(Number(task?.task_id)))
          ),
        }))
      : assignmentsFromSolution(args.solution, args.drivers, taskById);

  const byId = new Map<number, LogisticsHypothesisAssignmentRow>();
  for (const row of sourceRows) {
    const driverId = Number(row?.driver?.id);
    if (Number.isFinite(driverId)) byId.set(driverId, row);
  }

  const merged = args.drivers.map((driver) => {
    const preview = byId.get(driver.id);
    if (!preview) return { driver, tasks: [] as any[] };
    return {
      ...preview,
      driver: {
        ...driver,
        ...preview.driver,
        id: driver.id,
        name: driver.name ?? preview.driver?.name,
        lastname: driver.lastname ?? preview.driver?.lastname,
        alias: driver.alias ?? preview.driver?.alias,
        start_time: preview.driver?.start_time ?? driver.start_time,
      },
      tasks: Array.isArray(preview.tasks) ? preview.tasks : [],
    };
  });

  const usedIds = new Set(args.drivers.map((driver) => driver.id));
  for (const row of sourceRows) {
    const driverId = Number(row?.driver?.id);
    if (!Number.isFinite(driverId) || usedIds.has(driverId)) continue;
    if ((row.tasks?.length || 0) === 0) continue;
    merged.push({
      ...row,
      driver: { ...row.driver, isRemoved: true },
    });
  }

  return merged;
}
