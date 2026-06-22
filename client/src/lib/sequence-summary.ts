import { formatWorkWindowLabel } from "@shared/logistics-task-windows";
import {
  resolveLogisticsTaskKind,
  type LogisticsTaskKind,
} from "@shared/logistics-task-kind";

export type SequenceSummaryEntry = {
  sequence: number;
  taskId: string;
  logisticCode: string;
  address: string;
  hkWindow: string;
  lgWindow: string;
  logisticsTaskKind: LogisticsTaskKind | null;
};

export type SequenceSummaryGroup = {
  id: number;
  label: string;
  vehiclePlate?: string;
  tasks: SequenceSummaryEntry[];
};

function getTaskLogisticCode(task: any): string {
  return String(
    task?.logistic_code ??
      task?.logisticCode ??
      task?.name ??
      task?.task_id ??
      task?.id ??
      ""
  );
}

function getTaskId(task: any): string {
  return String(task?.id ?? task?.task_id ?? "");
}

function sortTasksBySequence(tasks: any[]): any[] {
  return [...tasks].sort((a, b) => {
    const seqA = Number(a?.sequence);
    const seqB = Number(b?.sequence);
    if (Number.isFinite(seqA) && Number.isFinite(seqB)) return seqA - seqB;

    const timeA = String(a?.start_time ?? a?.startTime ?? "");
    const timeB = String(b?.start_time ?? b?.startTime ?? "");
    if (timeA && timeB) return timeA.localeCompare(timeB);

    return 0;
  });
}

function resolvePresetWindow(value: unknown): string | null {
  const preset = String(value ?? "").trim();
  if (!preset || preset === "-") return null;
  return preset;
}

function resolveHkWindow(task: any): string {
  const preset = resolvePresetWindow(task?.hk_window ?? task?.hkWindow);
  if (preset) return preset;

  return formatWorkWindowLabel(
    task?.hk_start_time ??
      task?.hk_task_start_time ??
      task?.housekeeping_start_time ??
      task?.cleanerTaskStartTime ??
      task?.cleaner_start_time ??
      task?.cleanerStartTime,
    task?.hk_end_time ??
      task?.hk_task_end_time ??
      task?.housekeeping_end_time ??
      task?.cleanerTaskEndTime ??
      task?.cleaner_end_time ??
      task?.cleanerEndTime
  );
}

function resolveLgWindow(task: any): string {
  const preset = resolvePresetWindow(task?.lg_window ?? task?.lgWindow);
  if (preset) return preset;

  return formatWorkWindowLabel(
    task?.start_time ?? task?.startTime ?? task?.logistics_start_time ?? task?.logisticsStartTime,
    task?.end_time ?? task?.endTime ?? task?.logistics_end_time ?? task?.logisticsEndTime
  );
}

function resolveLogisticsTaskKindForSummary(task: any): LogisticsTaskKind | null {
  return resolveLogisticsTaskKind({
    cleanerId: task?.cleaner_id ?? task?.cleanerId ?? null,
    cleanerSequence: task?.cleaner_sequence ?? task?.cleanerSequence ?? null,
    premium: task?.premium,
    paxIn: task?.pax_in ?? task?.paxIn,
    logisticsTaskKind: task?.logistics_task_kind ?? task?.logisticsTaskKind,
    logisticsTaskKindSource: task?.logistics_task_kind_source ?? task?.logisticsTaskKindSource,
  });
}

function mapTaskToSummaryEntry(task: any, fallbackSequence: number): SequenceSummaryEntry {
  const sequence = Number(task?.sequence);
  return {
    sequence: Number.isFinite(sequence) && sequence > 0 ? sequence : fallbackSequence,
    taskId: getTaskId(task),
    logisticCode: getTaskLogisticCode(task),
    address: String(task?.address ?? "").trim().toUpperCase(),
    hkWindow: resolveHkWindow(task),
    lgWindow: resolveLgWindow(task),
    logisticsTaskKind: resolveLogisticsTaskKindForSummary(task),
  };
}

function resolveCleanerLabel(cleanerId: number, cleanerTasks: any[]): string {
  for (const task of cleanerTasks) {
    const alias = String(task?.alias ?? "").trim();
    if (alias) return alias;

    const cleanerName = String(task?.cleaner_name ?? task?.cleanerName ?? "").trim();
    if (cleanerName) return cleanerName;
  }

  return `ID ${cleanerId}`;
}

function resolveDriverLabel(driver: { id: number; name?: string; lastname?: string; alias?: string }): string {
  const alias = String(driver?.alias ?? "").trim();
  if (alias) return alias;

  const fullName = `${String(driver?.name ?? "").trim()} ${String(driver?.lastname ?? "").trim()}`.trim();
  if (fullName) return fullName;

  return `ID ${driver.id}`;
}

function resolveDriverVehiclePlate(driver: {
  assigned_vehicle_pms_code?: string | null;
  vehicle_pms_code?: string | null;
}): string | undefined {
  const plate = String(driver?.assigned_vehicle_pms_code ?? driver?.vehicle_pms_code ?? "").trim();
  return plate || undefined;
}

export function buildSequenceSummaryGroupsFromTasks(tasks: any[]): SequenceSummaryGroup[] {
  const byCleaner = new Map<number, any[]>();

  for (const task of tasks) {
    const cleanerId = Number(task?.assignedCleaner ?? task?.cleanerId);
    if (!Number.isFinite(cleanerId)) continue;

    const list = byCleaner.get(cleanerId) ?? [];
    list.push(task);
    byCleaner.set(cleanerId, list);
  }

  const groups: SequenceSummaryGroup[] = [];

  for (const [cleanerId, cleanerTasks] of byCleaner) {
    const sortedTasks = sortTasksBySequence(cleanerTasks);
    groups.push({
      id: cleanerId,
      label: resolveCleanerLabel(cleanerId, sortedTasks),
      tasks: sortedTasks.map((task, index) => mapTaskToSummaryEntry(task, index + 1)),
    });
  }

  groups.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  return groups;
}

export function buildSequenceSummaryGroupsFromDriverAssignments(
  assignments: Array<{
    driver: {
      id: number;
      name?: string;
      lastname?: string;
      alias?: string;
      assigned_vehicle_pms_code?: string | null;
      vehicle_pms_code?: string | null;
    };
    tasks?: any[];
  }>
): SequenceSummaryGroup[] {
  const groups: SequenceSummaryGroup[] = [];

  for (const row of assignments) {
    const driverTasks = Array.isArray(row?.tasks) ? row.tasks : [];
    if (driverTasks.length === 0) continue;

    const sortedTasks = sortTasksBySequence(driverTasks);
    groups.push({
      id: row.driver.id,
      label: resolveDriverLabel(row.driver),
      vehiclePlate: resolveDriverVehiclePlate(row.driver),
      tasks: sortedTasks.map((task, index) => mapTaskToSummaryEntry(task, index + 1)),
    });
  }

  groups.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  return groups;
}
