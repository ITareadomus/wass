/**
 * Regole di accesso alle giornate di lavoro (housekeeping + logistica).
 *
 * In produzione le date passate sono in sola lettura (timeline/containers) e
 * alcune operazioni distruttive (reset timeline) sono bloccate sul server.
 * In development è consentito modificare anche giornate passate per debug e test.
 */

function startOfDay(date: Date): Date {
  const normalized = new Date(date);
  normalized.setHours(0, 0, 0, 0);
  return normalized;
}

export function getTodayStartOfDay(): Date {
  return startOfDay(new Date());
}

export function isWorkDateInPast(date: Date): boolean {
  return startOfDay(date) < getTodayStartOfDay();
}

export function isWorkDateInPastString(workDate: string): boolean {
  const parsed = new Date(workDate);
  if (Number.isNaN(parsed.getTime())) return false;
  return startOfDay(parsed) < getTodayStartOfDay();
}

export function isDevelopmentEnvironment(): boolean {
  if (typeof process !== "undefined" && process.env?.NODE_ENV) {
    return process.env.NODE_ENV !== "production";
  }

  try {
    const env = (import.meta as ImportMeta & { env?: { DEV?: boolean; MODE?: string } }).env;
    if (env?.DEV === true) return true;
    if (env?.MODE === "development") return true;
  } catch {
    /* non-Vite / bundler senza import.meta */
  }

  return false;
}

/**
 * True se la data è passata E l'ambiente non è development → UI read-only,
 * niente drag, toolbar disabilitata, ecc.
 */
export function isWorkDateHistoricallyLocked(date: Date): boolean {
  return isWorkDateInPast(date) && !isDevelopmentEnvironment();
}

/** Blocco server per reset timeline / operazioni distruttive su date passate. */
export function isPastWorkDateServerGuardBlocked(workDate: string): boolean {
  return isWorkDateInPastString(workDate) && !isDevelopmentEnvironment();
}
