/** Marker WASS: durata pulizia impostata a mano, non più ricalcolata da ADAM. */
export const WASS_CLEANING_TIME_MANUAL_REASON = "wass_cleaning_time_manual";

/**
 * Marker WASS: le quote dei collaboratori sono state sbilanciate a mano, quindi
 * non vanno più riportate alla divisione equa del totale.
 */
export const WASS_CLEANING_SPLIT_MANUAL_REASON = "wass_cleaning_split_manual";

export type ManualCleaningTimeOverride = {
  cleaningTime: number;
  baseCleaningTime: number;
  reasons: string[];
};

function taskIdOf(task: any): number | null {
  const id = Number(task?.task_id ?? task?.id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function reasonsOf(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return (value as { reasons?: unknown }).reasons;
  return [];
}

function hasReason(taskOrReasons: unknown, marker: string): boolean {
  const reasons = reasonsOf(taskOrReasons);
  if (!Array.isArray(reasons)) return false;
  return reasons.some((entry) => String(entry ?? "").trim() === marker);
}

function withReason(reasons: unknown, marker: string): string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(reasons)) {
    for (const entry of reasons) {
      const reason = String(entry ?? "").trim();
      if (!reason || seen.has(reason)) continue;
      seen.add(reason);
      next.push(reason);
    }
  }
  if (!seen.has(marker)) next.push(marker);
  return next;
}

export function hasManualCleaningTime(taskOrReasons: unknown): boolean {
  return hasReason(taskOrReasons, WASS_CLEANING_TIME_MANUAL_REASON);
}

export function withManualCleaningTimeReason(reasons: unknown): string[] {
  return withReason(reasons, WASS_CLEANING_TIME_MANUAL_REASON);
}

/** Quote dei collaboratori sbilanciate a mano: niente più divisione equa. */
export function hasManualCleaningSplit(taskOrReasons: unknown): boolean {
  return hasReason(taskOrReasons, WASS_CLEANING_SPLIT_MANUAL_REASON);
}

export function withManualCleaningSplitReason(reasons: unknown): string[] {
  return withReason(reasons, WASS_CLEANING_SPLIT_MANUAL_REASON);
}

/** Torna alla divisione equa: usato quando si aggiunge o toglie un collaboratore. */
export function withoutManualCleaningSplitReason(reasons: unknown): string[] {
  if (!Array.isArray(reasons)) return [];
  return reasons
    .map((entry) => String(entry ?? "").trim())
    .filter((reason) => reason && reason !== WASS_CLEANING_SPLIT_MANUAL_REASON);
}

/** Durata in formato "H.MM", quello usato ovunque nel campo `duration`. */
export function formatCleaningDuration(minutes: unknown): string {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  return `${Math.floor(total / 60)}.${String(total % 60).padStart(2, "0")}`;
}

/** Quota del singolo cleaner: il totale dell'appartamento diviso i collaboratori. */
export function splitCleaningTimeAcrossCollaborators(
  totalMinutes: unknown,
  collaboratorCount: unknown = 1
): number {
  const total = Math.max(0, Math.round(Number(totalMinutes) || 0));
  const count = Math.max(1, Math.round(Number(collaboratorCount) || 1));
  return Math.ceil(total / count);
}

/**
 * `totalCleaningMinutes` è la durata dell'appartamento, non quella del singolo
 * cleaner: in collaborazione viene divisa fra i collaboratori. Ridistribuire il
 * totale azzera un eventuale sbilanciamento manuale delle quote.
 */
export function applyWassCleaningTimeOverride(
  task: any,
  totalCleaningMinutes: number,
  collaboratorCount = 1
): void {
  const total = Math.max(0, Math.round(Number(totalCleaningMinutes) || 0));
  const perCleaner = splitCleaningTimeAcrossCollaborators(total, collaboratorCount);
  task.base_cleaning_time = total;
  task.cleaning_time = perCleaner;
  task.reasons = withManualCleaningTimeReason(
    withoutManualCleaningSplitReason(task.reasons)
  );
  task.duration = formatCleaningDuration(perCleaner);
}

function considerManualTask(
  map: Map<number, ManualCleaningTimeOverride>,
  task: any
): void {
  if (!hasManualCleaningTime(task)) return;
  const id = taskIdOf(task);
  if (id == null) return;
  const cleaning = Number(task.cleaning_time ?? 0) || 0;
  const count = Math.max(1, Number(task.collaborator_count) || 1);
  const base = Number(task.base_cleaning_time ?? 0) || cleaning * count;
  const existing = map.get(id);
  if (!existing || base > existing.baseCleaningTime) {
    map.set(id, {
      cleaningTime: cleaning,
      baseCleaningTime: base,
      reasons: withManualCleaningTimeReason(task.reasons),
    });
  }
}

function walkTasksFromDocument(doc: any, visit: (task: any) => void): void {
  if (!doc || typeof doc !== "object") return;
  const containers = doc.containers;
  if (containers && typeof containers === "object") {
    for (const key of Object.keys(containers)) {
      const bucket = containers[key];
      const tasks = Array.isArray(bucket)
        ? bucket
        : Array.isArray(bucket?.tasks)
          ? bucket.tasks
          : [];
      for (const task of tasks) visit(task);
    }
  }
  const assignments = doc.cleaners_assignments;
  if (Array.isArray(assignments)) {
    for (const entry of assignments) {
      for (const task of entry?.tasks || []) visit(task);
    }
  }
}

export function collectManualCleaningTimeOverrides(
  ...documents: any[]
): Map<number, ManualCleaningTimeOverride> {
  const map = new Map<number, ManualCleaningTimeOverride>();
  for (const doc of documents) {
    walkTasksFromDocument(doc, (task) => considerManualTask(map, task));
  }
  return map;
}

export function restoreManualCleaningTimeOverrides(
  containersData: any,
  overrides: Map<number, ManualCleaningTimeOverride>
): number {
  if (!containersData?.containers || !overrides || overrides.size === 0) return 0;
  let restored = 0;
  for (const key of Object.keys(containersData.containers)) {
    const tasks = containersData.containers[key]?.tasks;
    if (!Array.isArray(tasks)) continue;
    for (const task of tasks) {
      const id = taskIdOf(task);
      if (id == null) continue;
      const override = overrides.get(id);
      if (!override) continue;
      task.cleaning_time = override.baseCleaningTime || override.cleaningTime;
      task.duration = formatCleaningDuration(task.cleaning_time);
      task.reasons = withManualCleaningTimeReason([
        ...(Array.isArray(task.reasons) ? task.reasons : []),
        ...override.reasons,
      ]);
      restored += 1;
    }
  }
  return restored;
}
