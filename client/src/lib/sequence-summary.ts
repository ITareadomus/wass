import { formatHmTime, formatWorkWindowLabel } from "@shared/logistics-task-windows";
import {
  computeLogisticsCheckoutWaitGap,
  getLogisticsTimelineViolationMessages,
  minutesToHm,
  parseHmToMinutes,
  pickLogisticsViolationFields,
} from "@shared/logistics-scheduling-constraints";
import { estimateLogisticsReturnToDepotMinutes } from "@shared/logistics-travel-estimate";
import {
  resolveLogisticsTaskKind,
  type LogisticsTaskKind,
} from "@shared/logistics-task-kind";

export type SequenceSummaryEntry = {
  sequence: number;
  taskId: string;
  logisticCode: string;
  customerAlias?: string | null;
  address: string;
  hkWindow: string;
  lgWindow: string;
  checkoutTime?: string | null;
  checkinTime?: string | null;
  cleanerLabel?: string | null;
  cleanerId?: number | null;
  cleanerSequence?: number | null;
  sofabedLabel?: string | null;
  customerNote?: string | null;
  logisticsTaskKind: LogisticsTaskKind | null;
  timelineViolated?: boolean;
  violationMessages?: string[];
};

export type SequenceSummaryGroup = {
  id: number;
  label: string;
  vehicleName?: string;
  vehiclePlate?: string;
  warehouseDepartureTime?: string | null;
  warehouseReturnTime?: string | null;
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

function resolveCheckTime(task: any, ...keys: string[]): string | null {
  for (const key of keys) {
    const formatted = formatHmTime(task?.[key]);
    if (formatted) return formatted;
  }
  return null;
}

function resolveTaskCleanerLabel(task: any): string | null {
  const alias = String(
    task?.cleaner_alias ??
      task?.assigned_cleaner_alias ??
      task?.cleanerAlias ??
      ""
  ).trim();
  if (alias) return alias;

  const name = String(task?.cleaner_name ?? task?.cleanerName ?? "").trim();
  const lastname = String(task?.cleaner_lastname ?? task?.cleanerLastname ?? "").trim();
  const fullName = `${name} ${lastname}`.trim();
  if (fullName) return fullName;

  const cleanerId = Number(task?.cleaner_id ?? task?.cleanerId);
  if (Number.isFinite(cleanerId)) return `ID ${cleanerId}`;

  return null;
}

function resolveTaskCleanerSequence(task: any): number | null {
  const sequence = Number(task?.cleaner_sequence ?? task?.cleanerSequence);
  return Number.isFinite(sequence) && sequence > 0 ? sequence : null;
}

function resolveSofabedCount(task: any, ...keys: string[]): number | null {
  for (const key of keys) {
    const num = Number(task?.[key]);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return null;
}

export function formatSofabedSummaryLabel(
  singleSofabeds: number | null | undefined,
  doubleSofabeds: number | null | undefined
): string | null {
  const parts: string[] = [];
  const single = Number(singleSofabeds);
  const double = Number(doubleSofabeds);

  if (Number.isFinite(single) && single > 0) {
    parts.push(`${single} ${single === 1 ? "singolo" : "singoli"}`);
  }
  if (Number.isFinite(double) && double > 0) {
    parts.push(`${double} ${double === 1 ? "matrimoniale" : "matrimoniali"}`);
  }

  if (parts.length === 0) return null;
  return `DV: ${parts.join(", ")}`;
}

function resolveCustomerAlias(task: any): string | null {
  const alias = String(task?.alias ?? task?.customer_alias ?? task?.customerAlias ?? "").trim();
  return alias || null;
}

function resolveCustomerNote(task: any): string | null {
  const fromHistory = extractLatestCustomerNoteFromHistory(
    task?.customer_note_history ?? task?.customerNoteHistory
  );
  if (fromHistory) return fromHistory;

  const direct = String(task?.customer_note ?? task?.customerNote ?? "")
    .replace(/<\s*\/?\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .trim();
  return direct || null;
}

function extractLatestCustomerNoteFromHistory(history: unknown): string | null {
  if (!Array.isArray(history) || history.length === 0) return null;
  for (let idx = history.length - 1; idx >= 0; idx--) {
    const entry = history[idx];
    if (!entry || typeof entry !== "object") continue;
    const text = String((entry as { text?: unknown }).text ?? "")
      .replace(/<\s*\/?\s*br\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .trim();
    if (text) return text;
  }
  return null;
}

function mapTaskToSummaryEntry(
  task: any,
  fallbackSequence: number,
  workDate?: string
): SequenceSummaryEntry {
  const sequence = Number(task?.sequence);
  const cleanerIdRaw = Number(task?.cleaner_id ?? task?.cleanerId);
  const violationFields = pickLogisticsViolationFields(task);
  const violationMessages =
    workDate != null && workDate !== ""
      ? getLogisticsTimelineViolationMessages(violationFields, workDate)
      : [];
  const timelineViolated = violationMessages.length > 0;

  return {
    sequence: Number.isFinite(sequence) && sequence > 0 ? sequence : fallbackSequence,
    taskId: getTaskId(task),
    logisticCode: getTaskLogisticCode(task),
    customerAlias: resolveCustomerAlias(task),
    address: String(task?.address ?? "").trim().toUpperCase(),
    hkWindow: resolveHkWindow(task),
    lgWindow: resolveLgWindow(task),
    checkoutTime: resolveCheckTime(task, "checkout_time", "checkoutTime"),
    checkinTime: resolveCheckTime(task, "checkin_time", "checkinTime"),
    cleanerLabel: resolveTaskCleanerLabel(task),
    cleanerId: Number.isFinite(cleanerIdRaw) ? cleanerIdRaw : null,
    cleanerSequence: resolveTaskCleanerSequence(task),
    sofabedLabel: formatSofabedSummaryLabel(
      resolveSofabedCount(task, "single_sofabeds", "singleSofabeds"),
      resolveSofabedCount(task, "double_sofabeds", "doubleSofabeds")
    ),
    customerNote: resolveCustomerNote(task),
    logisticsTaskKind: resolveLogisticsTaskKindForSummary(task),
    timelineViolated,
    violationMessages,
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

function resolveDriverVehicleName(driver: {
  assigned_vehicle_name?: string | null;
  vehicle_name?: string | null;
}): string | undefined {
  const name = String(driver?.assigned_vehicle_name ?? driver?.vehicle_name ?? "").trim();
  if (!name) return undefined;
  const firstWord = name.split(/\s+/)[0]?.trim();
  return firstWord || undefined;
}

function resolveDriverVehiclePlate(driver: {
  assigned_vehicle_pms_code?: string | null;
  vehicle_pms_code?: string | null;
}): string | undefined {
  const plate = String(driver?.assigned_vehicle_pms_code ?? driver?.vehicle_pms_code ?? "").trim();
  return plate || undefined;
}

function resolveWarehouseScheduleTimes(
  driver: { start_time?: string | null; startTime?: string | null },
  tasks: any[],
  returnTravelTime?: number | null,
  workDate?: string
): { warehouseDepartureTime: string | null; warehouseReturnTime: string | null } {
  if (tasks.length === 0) {
    return { warehouseDepartureTime: null, warehouseReturnTime: null };
  }

  const sortedTasks = sortTasksBySequence(tasks);
  const firstTask = sortedTasks[0];
  const lastTask = sortedTasks[sortedTasks.length - 1];

  const travelTime = Number(firstTask?.travel_time ?? firstTask?.travelTime ?? 0);
  const checkoutWait =
    workDate != null && workDate !== ""
      ? computeLogisticsCheckoutWaitGap({
          workDate,
          sequence: 1,
          startTime: firstTask?.start_time ?? firstTask?.startTime,
          checkoutTime: firstTask?.checkout_time ?? firstTask?.checkoutTime,
          checkoutDate: firstTask?.checkout_date ?? firstTask?.checkoutDate,
          checkoutWaitMinutes:
            firstTask?.checkout_wait_minutes ?? firstTask?.checkoutWaitMinutes,
          travelMinutes: Number.isFinite(travelTime) ? travelTime : 0,
          prevEndTime: null,
          prevCheckinDate: null,
        })
      : 0;

  const startMin = parseHmToMinutes(firstTask?.start_time ?? firstTask?.startTime, null);
  let departureMin: number | null = null;
  if (startMin != null) {
    departureMin = startMin - checkoutWait - (Number.isFinite(travelTime) ? travelTime : 0);
  } else {
    departureMin = parseHmToMinutes(driver?.start_time ?? driver?.startTime, null);
  }

  const endMin = parseHmToMinutes(lastTask?.end_time ?? lastTask?.endTime, null);
  const returnTravel =
    returnTravelTime != null && Number.isFinite(Number(returnTravelTime))
      ? Number(returnTravelTime)
      : estimateLogisticsReturnToDepotMinutes(lastTask);

  let returnMin: number | null = null;
  if (endMin != null && returnTravel > 0) {
    returnMin = endMin + returnTravel;
  }

  return {
    warehouseDepartureTime: departureMin != null ? minutesToHm(departureMin) : null,
    warehouseReturnTime: returnMin != null ? minutesToHm(returnMin) : null,
  };
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

  return groups;
}

export function buildSequenceSummaryGroupsFromDriverAssignments(
  assignments: Array<{
    driver: {
      id: number;
      name?: string;
      lastname?: string;
      alias?: string;
      assigned_vehicle_name?: string | null;
      vehicle_name?: string | null;
      assigned_vehicle_pms_code?: string | null;
      vehicle_pms_code?: string | null;
      start_time?: string | null;
      startTime?: string | null;
    };
    tasks?: any[];
    return_travel_time?: number | null;
  }>,
  workDate?: string
): SequenceSummaryGroup[] {
  const groups: SequenceSummaryGroup[] = [];

  for (const row of assignments) {
    const driverTasks = Array.isArray(row?.tasks) ? row.tasks : [];
    if (driverTasks.length === 0) continue;

    const sortedTasks = sortTasksBySequence(driverTasks);
    const warehouseTimes = resolveWarehouseScheduleTimes(
      row.driver,
      sortedTasks,
      row.return_travel_time,
      workDate
    );
    groups.push({
      id: row.driver.id,
      label: resolveDriverLabel(row.driver),
      vehicleName: resolveDriverVehicleName(row.driver),
      vehiclePlate: resolveDriverVehiclePlate(row.driver),
      warehouseDepartureTime: warehouseTimes.warehouseDepartureTime,
      warehouseReturnTime: warehouseTimes.warehouseReturnTime,
      tasks: sortedTasks.map((task, index) => mapTaskToSummaryEntry(task, index + 1, workDate)),
    });
  }

  return groups;
}
