export interface HousekeepingTimelineViolationInput {
  startTime?: string | null;
  endTime?: string | null;
  checkoutTime?: string | null;
  checkinTime?: string | null;
  checkoutDate?: string | null;
  checkinDate?: string | null;
}

type HousekeepingTimelineViolation =
  | { kind: "startBeforeCheckout"; start: string; checkout: string }
  | { kind: "endAfterCheckin"; end: string; checkin: string }
  | { kind: "startAtOrAfterCheckin"; start: string; checkin: string };

function normalizeYmd(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeHm(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^\d{2}:\d{2}$/.test(raw)) return raw;
  if (/^\d{2}:\d{2}:\d{2}$/.test(raw)) return raw.slice(0, 5);
  return null;
}

function collectHousekeepingTimelineViolations(
  input: HousekeepingTimelineViolationInput
): HousekeepingTimelineViolation[] {
  const startTime = normalizeHm(input.startTime);
  const endTime = normalizeHm(input.endTime);
  const checkoutTime = normalizeHm(input.checkoutTime);
  const checkinTime = normalizeHm(input.checkinTime);
  const checkoutDate = normalizeYmd(input.checkoutDate);
  const checkinDate = normalizeYmd(input.checkinDate);
  const violations: HousekeepingTimelineViolation[] = [];

  if (startTime && checkoutTime && checkoutDate) {
    const taskStart = new Date(`${checkoutDate}T${startTime}:00`);
    const checkoutAt = new Date(`${checkoutDate}T${checkoutTime}:00`);
    if (taskStart < checkoutAt) {
      violations.push({ kind: "startBeforeCheckout", start: startTime, checkout: checkoutTime });
    }
  }

  if (endTime && checkinTime && checkoutDate && checkinDate) {
    const taskEnd = new Date(`${checkoutDate}T${endTime}:00`);
    const checkinAt = new Date(`${checkinDate}T${checkinTime}:00`);
    if (taskEnd > checkinAt) {
      violations.push({ kind: "endAfterCheckin", end: endTime, checkin: checkinTime });
    }
  }

  if (startTime && checkinTime && checkoutDate && checkinDate) {
    const taskStart = new Date(`${checkoutDate}T${startTime}:00`);
    const checkinAt = new Date(`${checkinDate}T${checkinTime}:00`);
    if (taskStart >= checkinAt) {
      violations.push({ kind: "startAtOrAfterCheckin", start: startTime, checkin: checkinTime });
    }
  }

  return violations;
}

/**
 * Motivi in italiano del lampeggio rosso in timeline housekeeping:
 * inizio prima del checkout, fine dopo il check-in, inizio sul/dopo il check-in.
 */
export function getHousekeepingTimelineViolationMessages(
  input: HousekeepingTimelineViolationInput
): string[] {
  return collectHousekeepingTimelineViolations(input).map((violation) => {
    switch (violation.kind) {
      case "startBeforeCheckout":
        return `Check-out: l'inizio del task (${violation.start}) è prima del check-out (${violation.checkout}).`;
      case "endAfterCheckin":
        return `Check-in: la fine del task (${violation.end}) supera l'orario di check-in (${violation.checkin}).`;
      case "startAtOrAfterCheckin":
        return `Check-in: l'inizio del task (${violation.start}) è uguale o successivo al check-in (${violation.checkin}).`;
    }
  });
}

/** Etichette brevi per tooltip hover. */
export function getHousekeepingTimelineViolationShortLabels(
  input: HousekeepingTimelineViolationInput
): string[] {
  const labels = collectHousekeepingTimelineViolations(input).map((violation) => {
    switch (violation.kind) {
      case "startBeforeCheckout":
        return "checkout violato";
      case "endAfterCheckin":
      case "startAtOrAfterCheckin":
        return "check-in violato";
    }
  });
  return [...new Set(labels)];
}
