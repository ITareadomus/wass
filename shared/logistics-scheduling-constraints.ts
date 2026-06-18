/**
 * Vincoli timeline logistica (allineati a housekeeping su checkout/check-in).
 * Attesa massima prima del checkout: LOGISTICS_MAX_CHECKOUT_WAIT_MIN.
 */

export const LOGISTICS_MAX_CHECKOUT_WAIT_MIN = 15;

export const LOGISTICS_SERVICE_DURATION_MIN = 15;

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
}

export interface LogisticsTimelineViolations {
  startBeforeCheckout: boolean;
  checkoutWaitExceeded: boolean;
  checkinViolated: boolean;
  startAtOrAfterCheckin: boolean;
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

  const hasViolation =
    startBeforeCheckout ||
    checkoutWaitExceeded ||
    checkinViolated ||
    startAtOrAfterCheckin;

  return {
    startBeforeCheckout,
    checkoutWaitExceeded,
    checkinViolated,
    startAtOrAfterCheckin,
    hasViolation,
  };
}

/** Lampeggio rosso in timeline: solo check-in, non attesa checkout (mostrata con wait gap). */
export function shouldBlinkLogisticsTaskCard(
  task: LogisticsTaskTimeFields,
  workDate: string
): boolean {
  const v = getLogisticsTimelineViolations(task, workDate);
  return v.checkinViolated || v.startAtOrAfterCheckin;
}

/**
 * Minuti di attesa prima del checkout da mostrare come wait gap (come housekeeping).
 * Preferisce checkout_wait_minutes dal ricalcolo; fallback HK se assente.
 */
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
