import { fromZonedTime } from "date-fns-tz";

export type HousekeepingTaskExecutionStatus =
  | "not_started"
  | "in_progress"
  | "completed";

const ROME_TZ = "Europe/Rome";

export function parseHousekeepingFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  }
  return Boolean(value);
}

/**
 * Stato esecuzione task housekeeping da ADAM:
 * - cleaned = 1 → verde (completato), vince su startwork
 * - startwork = 1 e cleaned = 0 → blu (in corso)
 * - startwork = 0 e cleaned = 0 → normale
 */
export function resolveHousekeepingTaskExecutionStatus(input: {
  startwork?: unknown;
  cleaned?: unknown;
}): HousekeepingTaskExecutionStatus {
  if (parseHousekeepingFlag(input.cleaned)) return "completed";
  if (parseHousekeepingFlag(input.startwork)) return "in_progress";
  return "not_started";
}

/** ADAM cleaned=1 (o stato completed già risolto): la task non è spostabile da WASS. */
export function isHousekeepingTaskCleaned(task: unknown): boolean {
  if (task == null) return false;
  if (typeof task !== "object") return parseHousekeepingFlag(task);
  const record = task as {
    cleaned?: unknown;
    housekeeping_execution_status?: unknown;
  };
  if (record.housekeeping_execution_status === "completed") return true;
  return parseHousekeepingFlag(record.cleaned);
}

export function normalizeHousekeepingStartworkAt(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const asDate = new Date(value);
    return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
  }
  const text = String(value).trim();
  if (!text || text.startsWith("0000-00-00")) return null;
  return text;
}

export function parseHousekeepingStartworkAtMs(value: unknown): number | null {
  const normalized = normalizeHousekeepingStartworkAt(value);
  if (!normalized) return null;

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z$/i.test(normalized)) {
    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? ms : null;
  }

  const match = normalized.match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2}(?::\d{2})?)/
  );
  if (!match) {
    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? ms : null;
  }

  const time = match[2].length === 5 ? `${match[2]}:00` : match[2];
  const asUtc = fromZonedTime(`${match[1]} ${time}`, ROME_TZ);
  const ms = asUtc.getTime();
  return Number.isNaN(ms) ? null : ms;
}

function isNumericCleaningTime(value: unknown): boolean {
  if (value == null || value === "") return false;
  return Number.isFinite(Number(value));
}

/** Minuti di pulizia per il timer. 0 = assente o zero ore: niente riempimento/lampeggio. */
export function resolveHousekeepingCleaningMinutes(task: any): number {
  const raw = task?.cleaning_time ?? task?.cleaningTime;
  if (isNumericCleaningTime(raw)) {
    const minutes = Number(raw);
    return minutes > 0 ? minutes : 0;
  }

  const duration = String(task?.duration ?? "");
  if (duration.includes(".")) {
    const [hoursPart, minutesPart = "0"] = duration.split(".");
    const hours = Number.parseInt(hoursPart, 10);
    const minutes = Number.parseInt(minutesPart, 10);
    const total =
      (Number.isFinite(hours) ? hours : 0) * 60 +
      (Number.isFinite(minutes) ? minutes : 0);
    return total > 0 ? total : 0;
  }

  return 0;
}

export type HousekeepingWorkProgress = {
  percent: number;
  remainingMinutes: number;
  overdue: boolean;
};

export function resolveHousekeepingWorkProgress(input: {
  status?: HousekeepingTaskExecutionStatus | null;
  startworkAt?: unknown;
  cleaningMinutes: number;
  nowMs: number;
}): HousekeepingWorkProgress | null {
  if (input.status !== "in_progress") return null;
  const durationMin = input.cleaningMinutes;
  if (!(durationMin > 0)) return null;

  const startMs = parseHousekeepingStartworkAtMs(input.startworkAt);
  if (startMs == null) {
    return { percent: 0, remainingMinutes: durationMin, overdue: false };
  }

  const elapsedMin = (input.nowMs - startMs) / 60_000;
  const percent = Math.max(0, Math.min(100, (elapsedMin / durationMin) * 100));
  const overdue = elapsedMin >= durationMin;
  const remainingMinutes = overdue
    ? 0
    : Math.max(0, Math.ceil(durationMin - elapsedMin));
  return { percent, remainingMinutes, overdue };
}

export function pickHousekeepingExecutionStatusFields(task: any): {
  startwork: boolean;
  cleaned: boolean;
  startwork_at: string | null;
  housekeeping_execution_status: HousekeepingTaskExecutionStatus;
} {
  const startwork = parseHousekeepingFlag(task?.startwork ?? task?.startWork);
  const cleaned = parseHousekeepingFlag(task?.cleaned);
  const startwork_at = normalizeHousekeepingStartworkAt(
    task?.startwork_at ?? task?.startworkAt ?? task?.startWorkAt
  );
  const housekeeping_execution_status =
    (task?.housekeeping_execution_status as
      | HousekeepingTaskExecutionStatus
      | undefined) ??
    resolveHousekeepingTaskExecutionStatus({ startwork, cleaned });

  return {
    startwork,
    cleaned,
    startwork_at,
    housekeeping_execution_status,
  };
}

export type HousekeepingTaskExecutionStatusFields = ReturnType<
  typeof pickHousekeepingExecutionStatusFields
>;

export function housekeepingExecutionStatusFieldsEqual(
  task: any,
  fields: HousekeepingTaskExecutionStatusFields
): boolean {
  const current = pickHousekeepingExecutionStatusFields(task);
  return (
    current.startwork === fields.startwork &&
    current.cleaned === fields.cleaned &&
    current.startwork_at === fields.startwork_at &&
    current.housekeeping_execution_status === fields.housekeeping_execution_status
  );
}

/** Applica gli stati Adam alle task timeline senza toccare orari/sequenza. */
export function mergeHousekeepingExecutionStatusIntoTasks<T>(
  tasks: T[],
  statuses: Record<string, HousekeepingTaskExecutionStatusFields>
): { tasks: T[]; changed: boolean } {
  let changed = false;
  const next = tasks.map((task) => {
    const anyTask = task as any;
    const id = String(anyTask?.task_id ?? anyTask?.id ?? "").trim();
    if (!id) return task;
    const fields = statuses[id];
    if (!fields || housekeepingExecutionStatusFieldsEqual(task, fields)) return task;
    changed = true;
    return { ...anyTask, ...fields };
  });
  return { tasks: changed ? next : tasks, changed };
}
