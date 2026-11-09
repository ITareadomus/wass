/** Marker WASS: start/end impostati a mano. ADAM non li sovrascrive e non li riceve. */
export const WASS_MANUAL_SCHEDULE_REASON = "wass_manual_schedule";

/**
 * Check-in e check-out modificati a mano su WASS.
 * Lo specchio ADAM non li sostituisce. Il resto dei campi sì.
 * Il marker unico copre entrambi; quelli separati accendono solo il campo toccato.
 */
export const WASS_CHECKIN_CHECKOUT_MANUAL_REASON = "wass_checkin_checkout_manual";
export const WASS_CHECKOUT_MANUAL_REASON = "wass_checkout_manual";
export const WASS_CHECKIN_MANUAL_REASON = "wass_checkin_manual";
export const WASS_PAX_MANUAL_REASON = "wass_pax_manual";
export const WASS_OPERATION_MANUAL_REASON = "wass_operation_manual";
export const WASS_CUSTOMER_NOTE_MANUAL_REASON = "wass_customer_note_manual";

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

export function hasManualSchedule(taskOrReasons: unknown): boolean {
  return hasReason(taskOrReasons, WASS_MANUAL_SCHEDULE_REASON);
}

export function hasManualCheckinCheckout(taskOrReasons: unknown): boolean {
  return hasReason(taskOrReasons, WASS_CHECKIN_CHECKOUT_MANUAL_REASON);
}

export function hasManualCheckout(taskOrReasons: unknown): boolean {
  return (
    hasManualCheckinCheckout(taskOrReasons) ||
    hasReason(taskOrReasons, WASS_CHECKOUT_MANUAL_REASON)
  );
}

export function hasManualCheckin(taskOrReasons: unknown): boolean {
  return (
    hasManualCheckinCheckout(taskOrReasons) ||
    hasReason(taskOrReasons, WASS_CHECKIN_MANUAL_REASON)
  );
}

export function withManualCheckinCheckoutReason(reasons: unknown): string[] {
  return withReason(reasons, WASS_CHECKIN_CHECKOUT_MANUAL_REASON);
}

export function withManualCheckoutReason(reasons: unknown): string[] {
  return withReason(reasons, WASS_CHECKOUT_MANUAL_REASON);
}

export function withManualCheckinReason(reasons: unknown): string[] {
  return withReason(reasons, WASS_CHECKIN_MANUAL_REASON);
}

export function hasManualPax(taskOrReasons: unknown): boolean {
  return hasReason(taskOrReasons, WASS_PAX_MANUAL_REASON);
}

export function withManualPaxReason(reasons: unknown): string[] {
  return withReason(reasons, WASS_PAX_MANUAL_REASON);
}

export function hasManualOperation(taskOrReasons: unknown): boolean {
  return hasReason(taskOrReasons, WASS_OPERATION_MANUAL_REASON);
}

export function withManualOperationReason(reasons: unknown): string[] {
  return withReason(reasons, WASS_OPERATION_MANUAL_REASON);
}

export function hasManualCustomerNote(taskOrReasons: unknown): boolean {
  return hasReason(taskOrReasons, WASS_CUSTOMER_NOTE_MANUAL_REASON);
}

export function withManualCustomerNoteReason(reasons: unknown): string[] {
  return withReason(reasons, WASS_CUSTOMER_NOTE_MANUAL_REASON);
}

export type ManualDetailOverride = {
  checkin_date?: unknown;
  checkin_time?: unknown;
  checkout_date?: unknown;
  checkout_time?: unknown;
  pax_in?: unknown;
  operation_id?: unknown;
  confirmed_operation?: unknown;
  straordinaria?: unknown;
  customer_note?: unknown;
  customer_note_history?: unknown;
  reasons: string[];
};

function taskIdOf(task: any): number | null {
  const id = Number(task?.task_id ?? task?.id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function snapshotManualDetails(task: any): ManualDetailOverride | null {
  const keepCheckin = hasManualCheckin(task);
  const keepCheckout = hasManualCheckout(task);
  const keepPax = hasManualPax(task);
  const keepOperation = hasManualOperation(task);
  const keepNote = hasManualCustomerNote(task);
  if (!keepCheckin && !keepCheckout && !keepPax && !keepOperation && !keepNote) {
    return null;
  }
  const snapshot: ManualDetailOverride = {
    reasons: Array.isArray(task?.reasons)
      ? task.reasons.map((entry: unknown) => String(entry ?? "").trim()).filter(Boolean)
      : [],
  };
  if (keepCheckin) {
    snapshot.checkin_date = task?.checkin_date ?? null;
    snapshot.checkin_time = task?.checkin_time ?? null;
  }
  if (keepCheckout) {
    snapshot.checkout_date = task?.checkout_date ?? null;
    snapshot.checkout_time = task?.checkout_time ?? null;
  }
  if (keepPax) snapshot.pax_in = task?.pax_in ?? null;
  if (keepOperation) {
    snapshot.operation_id = task?.operation_id ?? null;
    snapshot.confirmed_operation = task?.confirmed_operation;
    snapshot.straordinaria = task?.straordinaria;
  }
  if (keepNote) {
    snapshot.customer_note = task?.customer_note ?? null;
    snapshot.customer_note_history = task?.customer_note_history ?? null;
  }
  return snapshot;
}

function walkTaskDocuments(doc: any, visit: (task: any) => void): void {
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

/** Valori dei dettagli task impostati a mano, da rimettere dopo un refresh ADAM. */
export function collectManualDetailOverrides(
  ...documents: any[]
): Map<number, ManualDetailOverride> {
  const map = new Map<number, ManualDetailOverride>();
  for (const doc of documents) {
    walkTaskDocuments(doc, (task) => {
      const id = taskIdOf(task);
      const snapshot = snapshotManualDetails(task);
      if (id == null || !snapshot) return;
      const previous = map.get(id);
      map.set(id, previous ? { ...previous, ...snapshot, reasons: snapshot.reasons } : snapshot);
    });
  }
  return map;
}

export function restoreManualDetailOverrides(
  containersData: any,
  overrides: Map<number, ManualDetailOverride>
): number {
  if (!containersData?.containers || !overrides || overrides.size === 0) return 0;
  let restored = 0;
  for (const key of Object.keys(containersData.containers)) {
    const tasks = containersData.containers[key]?.tasks;
    if (!Array.isArray(tasks)) continue;
    for (const task of tasks) {
      const id = taskIdOf(task);
      if (id == null) continue;
      const snapshot = overrides.get(id);
      if (!snapshot) continue;
      if ("checkin_date" in snapshot) task.checkin_date = snapshot.checkin_date ?? null;
      if ("checkin_time" in snapshot) task.checkin_time = snapshot.checkin_time ?? null;
      if ("checkout_date" in snapshot) task.checkout_date = snapshot.checkout_date ?? null;
      if ("checkout_time" in snapshot) task.checkout_time = snapshot.checkout_time ?? null;
      if ("pax_in" in snapshot) task.pax_in = snapshot.pax_in ?? null;
      if ("operation_id" in snapshot) {
        task.operation_id = snapshot.operation_id ?? null;
        task.confirmed_operation = snapshot.confirmed_operation;
        task.straordinaria = snapshot.straordinaria;
      }
      if ("customer_note" in snapshot) {
        task.customer_note = snapshot.customer_note ?? null;
        task.customer_note_history = snapshot.customer_note_history ?? null;
      }
      const reasons = new Set<string>(
        Array.isArray(task.reasons)
          ? task.reasons.map((entry: unknown) => String(entry ?? "").trim()).filter(Boolean)
          : []
      );
      for (const reason of snapshot.reasons) reasons.add(reason);
      task.reasons = Array.from(reasons);
      restored += 1;
    }
  }
  return restored;
}

export function withManualScheduleReason(reasons: unknown): string[] {
  return withReason(reasons, WASS_MANUAL_SCHEDULE_REASON);
}

export function withoutManualScheduleReason(reasons: unknown): string[] {
  if (!Array.isArray(reasons)) return [];
  return reasons
    .map((entry) => String(entry ?? "").trim())
    .filter((reason) => reason && reason !== WASS_MANUAL_SCHEDULE_REASON);
}

/** HH:mm, oppure null se l'orario non è valido. */
export function normalizeScheduleClock(value: unknown): string | null {
  const match = String(value ?? "").trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function scheduleClockToMinutes(value: unknown): number | null {
  const clock = normalizeScheduleClock(value);
  if (!clock) return null;
  const [hours, minutes] = clock.split(":").map(Number);
  return hours * 60 + minutes;
}

/** Minuti fra start e end se l'orario è stato fissato a mano. Altrimenti null. */
export function manualScheduleSpanMinutes(task: unknown): number | null {
  if (!task || typeof task !== "object" || !hasManualSchedule(task)) return null;
  const record = task as { start_time?: unknown; startTime?: unknown; end_time?: unknown; endTime?: unknown };
  const start = scheduleClockToMinutes(record.start_time ?? record.startTime);
  const end = scheduleClockToMinutes(record.end_time ?? record.endTime);
  if (start == null || end == null || end <= start) return null;
  return end - start;
}

/** Durata "H.MM" usata dalla larghezza delle card in timeline. */
export function formatScheduleDurationLabel(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  return `${Math.floor(total / 60)}.${String(total % 60).padStart(2, "0")}`;
}
