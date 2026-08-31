/**
 * Vincoli timeline logistica (allineati a housekeeping su checkout/check-in).
 * Attesa massima prima del checkout: LOGISTICS_MAX_CHECKOUT_WAIT_MIN.
 */

import {
  requiresDriverBeforeCleaner,
  resolveLogisticsTaskKind,
  type LogisticsTaskKind,
} from "./logistics-task-kind";

export const LOGISTICS_MAX_CHECKOUT_WAIT_MIN = 15;

export const LOGISTICS_SERVICE_DURATION_MIN = 15;

export const LOGISTICS_DEFAULT_BAG_DELIVERY_TOLERANCE_MIN = 30;

export function parseHmToMinutes(value: unknown, fallback: number | null = null): number | null {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return fallback;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return fallback;
  return Math.max(0, Math.min(23 * 60 + 59, h * 60 + m));
}

export function minutesToHm(totalMinutes: number): string {
  const bounded = Math.max(0, Math.min(24 * 60 - 1, Math.round(totalMinutes)));
  const h = Math.floor(bounded / 60);
  const m = bounded % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export interface LogisticsTaskWorkedTimeFields {
  start_time?: string | null;
  startTime?: string | null;
  end_time?: string | null;
  endTime?: string | null;
}

/** Somma i minuti di servizio logistica di ogni task (end − start, fallback 15 min). */
export function sumLogisticsTaskWorkedMinutes(
  tasks: LogisticsTaskWorkedTimeFields[]
): number {
  return tasks.reduce((sum, task) => {
    const startMin = parseHmToMinutes(task.start_time ?? task.startTime, null);
    const endMin = parseHmToMinutes(task.end_time ?? task.endTime, null);
    if (startMin != null && endMin != null && endMin > startMin) {
      return sum + (endMin - startMin);
    }
    return sum + LOGISTICS_SERVICE_DURATION_MIN;
  }, 0);
}

/** Formato ore lavorate timeline logistica, es. 1:30 per 90 minuti. */
export function formatLogisticsWorkedHours(totalMinutes: number): string {
  const bounded = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(bounded / 60);
  const minutes = bounded % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

export function normalizeYmd(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return raw.slice(0, 10);
}

/** Checkout vale oggi se checkout_time presente e checkout_date assente o uguale a workDate. */
export function isCheckoutApplicableOnWorkDate(
  checkoutTime: unknown,
  checkoutDate: unknown,
  workDate: string
): boolean {
  if (!checkoutTime) return false;
  const cd = normalizeYmd(checkoutDate);
  const wd = normalizeYmd(workDate);
  if (cd && wd && cd !== wd) return false;
  return true;
}

/** Check-in vincola la fine solo se checkin_date coincide con workDate (come recalculate_times.py). */
export function isCheckinApplicableOnWorkDate(checkinDate: unknown, workDate: string): boolean {
  const cid = normalizeYmd(checkinDate);
  const wd = normalizeYmd(workDate);
  if (!cid || !wd) return false;
  return cid === wd;
}

export interface CheckoutScheduleResult {
  startMin: number;
  checkoutWaitMinutes: number;
  checkoutWaitExceeded: boolean;
}

/**
 * Arrivo prima del checkout: attesa fino al checkout, start al checkout.
 * Attesa > LOGISTICS_MAX_CHECKOUT_WAIT_MIN → violazione (non fattibile in optimizer).
 */
export function resolveCheckoutSchedule(
  arrivalMin: number,
  checkoutMin: number
): CheckoutScheduleResult {
  if (arrivalMin >= checkoutMin) {
    return { startMin: arrivalMin, checkoutWaitMinutes: 0, checkoutWaitExceeded: false };
  }
  const checkoutWaitMinutes = checkoutMin - arrivalMin;
  return {
    startMin: checkoutMin,
    checkoutWaitMinutes,
    checkoutWaitExceeded: checkoutWaitMinutes > LOGISTICS_MAX_CHECKOUT_WAIT_MIN,
  };
}

export function isCheckinEndViolation(endMin: number, checkinMin: number): boolean {
  return endMin > checkinMin;
}

export function isStartAtOrAfterCheckin(startMin: number, checkinMin: number): boolean {
  return startMin >= checkinMin;
}

export interface LogisticsTaskTimeFields {
  start_time?: string | null;
  startTime?: string | null;
  end_time?: string | null;
  endTime?: string | null;
  checkout_time?: string | null;
  checkout_date?: string | null;
  checkin_time?: string | null;
  checkin_date?: string | null;
  checkout_wait_minutes?: number | null;
  logistics_task_kind?: LogisticsTaskKind | string | null;
  logistics_task_kind_source?: string | null;
  logisticsTaskKind?: LogisticsTaskKind | string | null;
  logisticsTaskKindSource?: string | null;
  cleaner_id?: number | null;
  cleanerId?: number | null;
  cleaner_sequence?: number | null;
  cleanerSequence?: number | null;
  hk_start_time?: string | null;
  hkStartTime?: string | null;
  cleaner_task_start_time?: string | null;
  cleanerTaskStartTime?: string | null;
  cleaner_start_time?: string | null;
  cleanerStartTime?: string | null;
  cleaning_time?: number | null;
  cleaningTime?: number | null;
  premium?: boolean | null;
  pax_in?: number | null;
  paxIn?: number | null;
  _checkin_violated?: boolean | null;
  checkout_wait_exceeded?: boolean | null;
}

function toOptionalString(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  return String(value);
}

function toOptionalNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Campi necessari per violazioni timeline (summary + card dopo mapping). */
export function pickLogisticsViolationFields(
  source: Record<string, unknown> | null | undefined
): LogisticsTaskTimeFields {
  if (!source) return {};

  return {
    start_time: toOptionalString(source.start_time ?? source.startTime),
    end_time: toOptionalString(source.end_time ?? source.endTime),
    checkout_time: toOptionalString(source.checkout_time),
    checkout_date: toOptionalString(source.checkout_date),
    checkin_time: toOptionalString(source.checkin_time),
    checkin_date: toOptionalString(source.checkin_date),
    checkout_wait_minutes: toOptionalNumber(source.checkout_wait_minutes),
    logistics_task_kind: toOptionalString(source.logistics_task_kind ?? source.logisticsTaskKind),
    logistics_task_kind_source: toOptionalString(
      source.logistics_task_kind_source ?? source.logisticsTaskKindSource
    ),
    cleaner_id: toOptionalNumber(source.cleaner_id ?? source.cleanerId),
    cleaner_sequence: toOptionalNumber(source.cleaner_sequence ?? source.cleanerSequence),
    hk_start_time: toOptionalString(source.hk_start_time ?? source.hkStartTime),
    cleaner_task_start_time: toOptionalString(
      source.cleaner_task_start_time ?? source.cleanerTaskStartTime
    ),
    cleaner_start_time: toOptionalString(source.cleaner_start_time ?? source.cleanerStartTime),
    cleaning_time: toOptionalNumber(source.cleaning_time ?? source.cleaningTime),
    premium: source.premium === true ? true : source.premium === false ? false : undefined,
    pax_in: toOptionalNumber(source.pax_in ?? source.paxIn),
    _checkin_violated: source._checkin_violated === true,
    checkout_wait_exceeded: source.checkout_wait_exceeded === true,
  };
}

export function resolveDriverBringsBagLatestStartMin(params: {
  cleanerTaskStartMin: number;
  cleaningTimeMin: number | null;
}): number {
  const validCleaningTime =
    params.cleaningTimeMin !== null && Number.isFinite(params.cleaningTimeMin)
      ? params.cleaningTimeMin
      : null;
  const hasValidCleaningTime = validCleaningTime !== null && validCleaningTime > 0;
  const toleranceMin = hasValidCleaningTime
    ? Math.ceil(validCleaningTime * (2 / 3))
    : LOGISTICS_DEFAULT_BAG_DELIVERY_TOLERANCE_MIN;
  return params.cleanerTaskStartMin + toleranceMin;
}

function resolveCleanerTaskStartMin(task: LogisticsTaskTimeFields): number | null {
  const cleanerTaskStartTime =
    task.hk_start_time ??
    task.hkStartTime ??
    task.cleaner_task_start_time ??
    task.cleanerTaskStartTime ??
    task.cleaner_start_time ??
    task.cleanerStartTime ??
    null;
  return parseHmToMinutes(cleanerTaskStartTime, null);
}

function resolveCleaningTimeMin(task: LogisticsTaskTimeFields): number | null {
  const raw = task.cleaning_time ?? task.cleaningTime;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function isBagRuleViolation(task: LogisticsTaskTimeFields): boolean {
  const kind = resolveLogisticsTaskKind({
    logisticsTaskKind: task.logistics_task_kind ?? task.logisticsTaskKind,
    logisticsTaskKindSource: task.logistics_task_kind_source ?? task.logisticsTaskKindSource,
    cleanerId: task.cleaner_id ?? task.cleanerId,
    cleanerSequence: task.cleaner_sequence ?? task.cleanerSequence,
    premium: task.premium,
    paxIn: task.pax_in ?? task.paxIn,
  });

  if (!requiresDriverBeforeCleaner(kind)) return false;

  const cleanerTaskStartMin = resolveCleanerTaskStartMin(task);
  const startMin = parseHmToMinutes(task.start_time ?? task.startTime, null);
  if (cleanerTaskStartMin === null || startMin === null) return false;

  const latestStartMin = resolveDriverBringsBagLatestStartMin({
    cleanerTaskStartMin,
    cleaningTimeMin: resolveCleaningTimeMin(task),
  });

  return startMin > latestStartMin;
}

export interface LogisticsTimelineViolations {
  startBeforeCheckout: boolean;
  checkoutWaitExceeded: boolean;
  checkinViolated: boolean;
  startAtOrAfterCheckin: boolean;
  bagRuleViolated: boolean;
  hasViolation: boolean;
}

/** Violazioni visualizzate in timeline logistica (dopo ricalcolo: startBeforeCheckout di solito false). */
export function getLogisticsTimelineViolations(
  task: LogisticsTaskTimeFields,
  workDate: string
): LogisticsTimelineViolations {
  const startTime = task.start_time ?? task.startTime;
  const endTime = task.end_time ?? task.endTime;
  const startMin = parseHmToMinutes(startTime, null);
  const endMin = parseHmToMinutes(endTime, null);
  const checkoutMin = parseHmToMinutes(task.checkout_time, null);
  const checkinMin = parseHmToMinutes(task.checkin_time, null);

  let startBeforeCheckout = false;
  let checkoutWaitExceeded = false;

  if (
    startMin != null &&
    checkoutMin != null &&
    isCheckoutApplicableOnWorkDate(task.checkout_time, task.checkout_date, workDate)
  ) {
    if (startMin < checkoutMin) {
      startBeforeCheckout = true;
    }
    const waitFromField = Number(task.checkout_wait_minutes ?? 0);
    const impliedWait =
      waitFromField > 0
        ? waitFromField
        : startMin < checkoutMin
          ? checkoutMin - startMin
          : 0;
    checkoutWaitExceeded = impliedWait > LOGISTICS_MAX_CHECKOUT_WAIT_MIN;
  }

  let checkinViolated = false;
  let startAtOrAfterCheckin = false;
  if (checkinMin != null && isCheckinApplicableOnWorkDate(task.checkin_date, workDate)) {
    if (endMin != null) {
      checkinViolated = isCheckinEndViolation(endMin, checkinMin);
    }
    if (startMin != null) {
      startAtOrAfterCheckin = isStartAtOrAfterCheckin(startMin, checkinMin);
    }
  }

  const bagRuleViolated = isBagRuleViolation(task);

  const hasViolation =
    startBeforeCheckout ||
    checkoutWaitExceeded ||
    checkinViolated ||
    startAtOrAfterCheckin ||
    bagRuleViolated;

  return {
    startBeforeCheckout,
    checkoutWaitExceeded,
    checkinViolated,
    startAtOrAfterCheckin,
    bagRuleViolated,
    hasViolation,
  };
}

/** Lampeggio rosso in timeline: check-in (o flag server dopo ricalcolo). */
export function shouldBlinkLogisticsTaskCard(
  task: LogisticsTaskTimeFields,
  workDate: string
): boolean {
  if (task._checkin_violated === true) return true;
  const v = getLogisticsTimelineViolations(task, workDate);
  return v.checkinViolated || v.startAtOrAfterCheckin;
}

/** Lampeggio rosso in timeline: qualsiasi violazione logistica (check-in o borsone). */
export function shouldBlinkLogisticsTimelineTask(
  task: LogisticsTaskTimeFields,
  workDate: string
): boolean {
  return getLogisticsTimelineViolationMessages(task, workDate).length > 0;
}

function formatTimeLabel(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "N/D";
  const min = parseHmToMinutes(raw, null);
  return min != null ? minutesToHm(min) : raw.slice(0, 5);
}

/** Messaggi in italiano per violazioni timeline (summary, dialog). */
export function getLogisticsTimelineViolationMessages(
  task: LogisticsTaskTimeFields,
  workDate: string
): string[] {
  const messages: string[] = [];
  const violations = getLogisticsTimelineViolations(task, workDate);
  const startLabel = formatTimeLabel(task.start_time ?? task.startTime);
  const endLabel = formatTimeLabel(task.end_time ?? task.endTime);
  const checkinLabel = formatTimeLabel(task.checkin_time);

  if (violations.bagRuleViolated) {
    const cleanerTaskStartMin = resolveCleanerTaskStartMin(task);
    const cleaningTimeMin = resolveCleaningTimeMin(task);
    const hkStartLabel = formatTimeLabel(
      task.hk_start_time ??
        task.hkStartTime ??
        task.cleaner_task_start_time ??
        task.cleanerTaskStartTime ??
        task.cleaner_start_time ??
        task.cleanerStartTime
    );
    if (cleanerTaskStartMin != null) {
      const toleranceMin =
        cleaningTimeMin != null && cleaningTimeMin > 0
          ? Math.ceil(cleaningTimeMin * (2 / 3))
          : LOGISTICS_DEFAULT_BAG_DELIVERY_TOLERANCE_MIN;
      const latestStartLabel = minutesToHm(
        resolveDriverBringsBagLatestStartMin({
          cleanerTaskStartMin,
          cleaningTimeMin,
        })
      );
      messages.push(
        `Regola borsone: il servizio logistica inizia alle ${startLabel}, ma il driver deve consegnare il borsone entro le ${latestStartLabel} (inizio HK alle ${hkStartLabel} + tolleranza ${toleranceMin} min).`
      );
    } else {
      messages.push(
        "Regola borsone: il driver deve consegnare il borsone prima dell'inizio housekeeping, ma mancano i dati HK per calcolare il limite."
      );
    }
  }

  if (violations.checkinViolated) {
    messages.push(
      `Check-in: la fine del servizio logistica (${endLabel}) supera l'orario di check-in (${checkinLabel}).`
    );
  }

  if (violations.startAtOrAfterCheckin) {
    messages.push(
      `Check-in: l'inizio del servizio logistica (${startLabel}) è uguale o successivo al check-in (${checkinLabel}).`
    );
  }

  if (
    task._checkin_violated === true &&
    !violations.checkinViolated &&
    !violations.startAtOrAfterCheckin
  ) {
    messages.push("Check-in: violazione rilevata dal ricalcolo timeline.");
  }

  return messages;
}

/** Etichette brevi per tooltip hover. */
export function getLogisticsTimelineViolationShortLabels(
  task: LogisticsTaskTimeFields,
  workDate: string
): string[] {
  const labels: string[] = [];
  const violations = getLogisticsTimelineViolations(task, workDate);

  if (violations.bagRuleViolated) {
    labels.push("regola borsone violata");
  }
  if (
    violations.checkinViolated ||
    violations.startAtOrAfterCheckin ||
    task._checkin_violated === true
  ) {
    labels.push("check-in violato");
  }

  return [...new Set(labels)];
}

/** @deprecated Use {@link shouldBlinkLogisticsTimelineTask} — stesso colore rosso per tutte le violazioni. */
export function shouldBlinkLogisticsBagRule(task: LogisticsTaskTimeFields): boolean {
  return isBagRuleViolation(task);
}

/**
 * Minuti di attesa prima del checkout da mostrare come wait gap (come housekeeping).
 * Preferisce checkout_wait_minutes dal ricalcolo; fallback HK se assente.
 */
export interface EarlyRouteWaitStop {
  startMin: number;
  endMin: number;
  travelMinutes: number;
}

/**
 * Minuti di attesa assorbibili spostando la partenza del driver (e quindi il primo task)
 * invece di mostrare wait prima del task 1 o tra task 1 e 2.
 */
export function computeEarlyRouteWaitAbsorptionMin(
  driverStartMin: number,
  stops: EarlyRouteWaitStop[]
): number {
  if (stops.length === 0) return 0;

  const first = stops[0];
  const firstArrivalMin = driverStartMin + first.travelMinutes;
  let absorptionMin = Math.max(0, first.startMin - firstArrivalMin);

  if (stops.length >= 2) {
    const second = stops[1];
    const secondArrivalMin = first.endMin + second.travelMinutes;
    absorptionMin += Math.max(0, second.startMin - secondArrivalMin);
  }

  return absorptionMin;
}

export function computeLogisticsCheckoutWaitGap(args: {
  workDate: string;
  sequence: number;
  startTime?: string | null;
  checkoutTime?: string | null;
  checkoutDate?: string | null;
  checkoutWaitMinutes?: number | null;
  travelMinutes?: number;
  prevEndTime?: string | null;
  prevCheckinDate?: string | null;
}): number {
  if (!isCheckoutApplicableOnWorkDate(args.checkoutTime, args.checkoutDate, args.workDate)) {
    return 0;
  }

  const fromField = Number(args.checkoutWaitMinutes ?? 0);
  if (fromField > 0) return fromField;

  const startMin = parseHmToMinutes(args.startTime, null);
  const checkoutMin = parseHmToMinutes(args.checkoutTime, null);
  if (startMin != null && checkoutMin != null && startMin < checkoutMin) {
    return checkoutMin - startMin;
  }

  if (args.sequence >= 2 && args.prevEndTime && args.startTime) {
    const prevDate = normalizeYmd(args.prevCheckinDate);
    const wd = normalizeYmd(args.workDate);
    if (prevDate && wd && prevDate !== wd) return 0;

    const prevEndMin = parseHmToMinutes(args.prevEndTime, null);
    const start = parseHmToMinutes(args.startTime, null);
    const travel = Number(args.travelMinutes ?? 0);
    if (prevEndMin != null && start != null) {
      const expectedStart = prevEndMin + travel;
      if (start > expectedStart) return start - expectedStart;
    }
  }

  return 0;
}

export function isCheckoutWaitFeasible(checkoutWaitMinutes: number): boolean {
  return checkoutWaitMinutes <= LOGISTICS_MAX_CHECKOUT_WAIT_MIN;
}
