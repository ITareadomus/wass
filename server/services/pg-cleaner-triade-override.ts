import { formatInTimeZone } from "date-fns-tz";
import { query } from "../../shared/pg-db";
import { pgDailyAssignmentsService } from "./pg-daily-assignments-service";

export type DayCleanerTriadeOverride = {
  cleaner_id: number;
  weight: number;
  trial: boolean;
};

function asWeight(value: unknown): number | null {
  const weight = Number(value);
  if (!Number.isInteger(weight) || weight < 1) return null;
  return weight;
}

export async function listDayCleanerTriadeOverrides(workDate: string): Promise<DayCleanerTriadeOverride[]> {
  await pgDailyAssignmentsService.ensureTriadeOverrideTable();
  const [manual, promoted] = await Promise.all([
    query(
      `SELECT cleaner_id, weight
       FROM daily_cleaner_triade_override
       WHERE work_date = $1
       ORDER BY cleaner_id ASC`,
      [workDate]
    ),
    query(
      `SELECT cleaner_id, weight
       FROM cleaner_triade_promotion
       WHERE start_date <= $1::date
         AND start_date + (days - 1) >= $1::date`,
      [workDate]
    ),
  ]);
  const byCleaner = new Map<number, number>();
  const trialIds = new Set<number>();
  for (const row of promoted.rows) {
    const cleanerId = Number(row.cleaner_id);
    const weight = asWeight(row.weight);
    if (!Number.isFinite(cleanerId) || cleanerId <= 0 || weight == null) continue;
    byCleaner.set(cleanerId, weight);
    trialIds.add(cleanerId);
  }
  for (const row of manual.rows) {
    const cleanerId = Number(row.cleaner_id);
    const weight = asWeight(row.weight);
    if (!Number.isFinite(cleanerId) || cleanerId <= 0 || weight == null) continue;
    byCleaner.set(cleanerId, weight);
    trialIds.delete(cleanerId);
  }
  return [...byCleaner.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([cleaner_id, weight]) => ({ cleaner_id, weight, trial: trialIds.has(cleaner_id) }));
}

export type CleanerTriadePromotion = {
  cleanerId: number;
  weight: number;
  startDate: string;
  days: number;
  until: string;
  daysLeft: number;
};

function asYmd(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const text = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function addCalendarMonths(ymd: string, months: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const monthIndex = month - 1 + months;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDay);
  const nextMonth = String(targetMonth + 1).padStart(2, "0");
  const nextDay = String(clampedDay).padStart(2, "0");
  return `${targetYear}-${nextMonth}-${nextDay}`;
}

/** Durata inclusiva di 1, 2 o 3 mesi di calendario, espressa in giorni. */
export function trialDaysForMonths(startDate: string, months: number): number {
  const until = addDays(addCalendarMonths(startDate, months), -1);
  return daysBetween(startDate, until) + 1;
}

function addDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  const nextYear = date.getUTCFullYear();
  const nextMonth = String(date.getUTCMonth() + 1).padStart(2, "0");
  const nextDay = String(date.getUTCDate()).padStart(2, "0");
  return `${nextYear}-${nextMonth}-${nextDay}`;
}

export function romeToday(): string {
  return formatInTimeZone(new Date(), "Europe/Rome", "yyyy-MM-dd");
}

function daysBetween(from: string, to: string): number {
  const [fromYear, fromMonth, fromDay] = from.split("-").map(Number);
  const [toYear, toMonth, toDay] = to.split("-").map(Number);
  return Math.round((Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) / 86400000);
}

export function isTrialEligibleLevel(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === "essential" || normalized === "plus";
}

/** Promozioni ancora in corso, partendo dalla data di inserimento. */
export async function listActiveCleanerTriadePromotions(today = romeToday()): Promise<Map<number, CleanerTriadePromotion>> {
  await pgDailyAssignmentsService.ensureTriadeOverrideTable();
  const result = await query(
    `SELECT cleaner_id, weight, to_char(start_date, 'YYYY-MM-DD') AS start_date, days
     FROM cleaner_triade_promotion
     WHERE start_date + (days - 1) >= $1::date`,
    [today]
  );
  const promotions = new Map<number, CleanerTriadePromotion>();
  for (const row of result.rows) {
    const cleanerId = Number(row.cleaner_id);
    const weight = asWeight(row.weight);
    const startDate = asYmd(row.start_date);
    const days = Number(row.days);
    if (!Number.isFinite(cleanerId) || cleanerId <= 0 || weight == null || !startDate) continue;
    if (!Number.isInteger(days) || days < 1) continue;
    const until = addDays(startDate, days - 1);
    promotions.set(cleanerId, {
      cleanerId,
      weight,
      startDate,
      days,
      until,
      daysLeft: Math.max(0, daysBetween(today, until)),
    });
  }
  return promotions;
}

export async function saveCleanerTriadePromotion(
  cleanerId: number,
  days: number,
  weight: number,
  startDate: string
): Promise<CleanerTriadePromotion> {
  await pgDailyAssignmentsService.ensureTriadeOverrideTable();
  await query(
    `INSERT INTO cleaner_triade_promotion (cleaner_id, start_date, days, weight, updated_at)
     VALUES ($1, $2::date, $3, $4, NOW())
     ON CONFLICT (cleaner_id) DO UPDATE
       SET start_date = EXCLUDED.start_date,
           days = EXCLUDED.days,
           weight = EXCLUDED.weight,
           updated_at = NOW()`,
    [cleanerId, startDate, days, weight]
  );
  return {
    cleanerId,
    weight,
    startDate,
    days,
    until: addDays(startDate, days - 1),
    daysLeft: Math.max(0, daysBetween(startDate, addDays(startDate, days - 1))),
  };
}

export async function clearCleanerTriadePromotion(cleanerId: number): Promise<void> {
  await pgDailyAssignmentsService.ensureTriadeOverrideTable();
  await query(`DELETE FROM cleaner_triade_promotion WHERE cleaner_id = $1`, [cleanerId]);
}

/** weight null cancella l'eccezione e il cleaner torna al livello ADAM. */
export async function saveDayCleanerTriadeOverride(
  workDate: string,
  cleanerId: number,
  weight: number | null
): Promise<void> {
  await pgDailyAssignmentsService.ensureTriadeOverrideTable();
  if (weight == null) {
    await query(
      `DELETE FROM daily_cleaner_triade_override WHERE work_date = $1 AND cleaner_id = $2`,
      [workDate, cleanerId]
    );
    return;
  }
  await query(
    `INSERT INTO daily_cleaner_triade_override (work_date, cleaner_id, weight, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (work_date, cleaner_id)
     DO UPDATE SET weight = EXCLUDED.weight, updated_at = NOW()`,
    [workDate, cleanerId, weight]
  );
}
