import { addDays, format, parseISO, startOfWeek, subDays } from "date-fns";
import * as mysql from "mysql2/promise";
import { databaseConfig } from "../../config/database";

function toYyyyMmDd(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return format(v, "yyyy-MM-dd");
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  return !isNaN(d.getTime()) ? format(d, "yyyy-MM-dd") : "";
}

const CONTRACT_BY_TYPE_ID: Record<number, string> = {
  1: "A",
  2: "B",
  3: "C",
  4: "a chiamata",
};

function streakEndingAt(workedByUser: Map<number, Set<string>>, uid: number, lastDayStr: string | null): number {
  if (!lastDayStr) return 0;
  const s = workedByUser.get(uid);
  if (!s || !s.has(lastDayStr)) return 0;
  let cnt = 0;
  let day = parseISO(lastDayStr);
  for (;;) {
    const key = format(day, "yyyy-MM-dd");
    if (!s.has(key)) break;
    cnt += 1;
    day = subDays(day, 1);
  }
  return cnt;
}

type MysqlDriverStats = {
  counter_hours: number;
  counter_days: number;
  contract_type: string | null;
};

async function loadMysqlDriverStatsOnConnection(
  conn: mysql.Connection,
  workDate: string,
  userIds: number[]
): Promise<Map<number, MysqlDriverStats>> {
  const out = new Map<number, MysqlDriverStats>();
  if (!userIds.length) return out;

  const targetDate = parseISO(workDate);
  const todayStr = format(new Date(), "yyyy-MM-dd");
  const isFutureTarget = workDate > todayStr;

  const weekStart = startOfWeek(targetDate, { weekStartsOn: 1 });
  const weekEndExcl = addDays(weekStart, 7);
  const dayBeforeTargetStr = format(subDays(targetDate, 1), "yyyy-MM-dd");
  const startWindowStr = format(subDays(targetDate, 60), "yyyy-MM-dd");

  const placeholders = userIds.map(() => "?").join(",");
  const [userRows]: any = await conn.execute(
    `SELECT id, contract_type_id FROM app_users WHERE id IN (${placeholders})`,
    userIds
  );
  const contractByUser = new Map<number, string | null>();
  for (const r of Array.isArray(userRows) ? userRows : []) {
    const id = Number(r?.id);
    const ctid = r?.contract_type_id != null ? Number(r.contract_type_id) : null;
    const label =
      ctid != null && Number.isFinite(ctid)
        ? CONTRACT_BY_TYPE_ID[ctid] ?? String(ctid)
        : null;
    if (Number.isFinite(id)) contractByUser.set(id, label);
  }

  const [weeklyRows]: any = await conn.execute(
    `SELECT user_id,
      ROUND(SUM(
        CASE
          WHEN duration IS NULL OR duration = '' THEN 0
          WHEN INSTR(duration, ':') > 0 THEN
               CAST(SUBSTRING_INDEX(duration, ':', 1) AS DECIMAL(10,2))
             + CAST(SUBSTRING_INDEX(duration, ':', -1) AS DECIMAL(10,2))/60
          ELSE CAST(duration AS DECIMAL(10,2))
        END
      ), 2) AS weekly_hours
    FROM app_housekeeping_report
    WHERE updated_at >= ? AND updated_at < ?
    GROUP BY user_id`,
    [weekStart, weekEndExcl]
  );
  const weeklyHours = new Map<number, number>();
  for (const r of Array.isArray(weeklyRows) ? weeklyRows : []) {
    const id = Number(r?.user_id);
    if (Number.isFinite(id)) weeklyHours.set(id, Number(r?.weekly_hours) || 0);
  }

  const [dateRows]: any = await conn.execute(
    `SELECT user_id, DATE(updated_at) AS d
     FROM app_housekeeping_report
     WHERE updated_at >= ? AND updated_at < ?
     GROUP BY user_id, DATE(updated_at)
     ORDER BY user_id, d DESC`,
    [startWindowStr, workDate]
  );
  const workedByUser = new Map<number, Set<string>>();
  for (const r of Array.isArray(dateRows) ? dateRows : []) {
    const id = Number(r?.user_id);
    const ds = toYyyyMmDd(r?.d);
    if (!Number.isFinite(id) || !ds) continue;
    if (!workedByUser.has(id)) workedByUser.set(id, new Set());
    workedByUser.get(id)!.add(ds);
  }

  for (const uid of userIds) {
    const counter_hours = weeklyHours.get(uid) ?? 0;
    let counter_days = 0;

    if (isFutureTarget) {
      const s = workedByUser.get(uid);
      if (s && s.has(dayBeforeTargetStr)) {
        counter_days = streakEndingAt(workedByUser, uid, dayBeforeTargetStr);
      }
    } else {
      const s = workedByUser.get(uid);
      let lastReported: string | null = null;
      if (s) {
        const candidates = [...s].filter((d) => d <= dayBeforeTargetStr);
        if (candidates.length) lastReported = candidates.reduce((a, b) => (a > b ? a : b));
      }
      counter_days = lastReported != null ? streakEndingAt(workedByUser, uid, lastReported) : 0;
    }

    out.set(uid, {
      counter_hours,
      counter_days,
      contract_type: contractByUser.get(uid) ?? null,
    });
  }

  return out;
}

/**
 * Arricchimento roster / convocati driver: ultimo giorno con report (app_housekeeping_report),
 * show_plus_one (in programma senza report per workDate),
 * e da MySQL: ore settimana, giorni lavorati consecutivi, tipo contratto (come extract_logistics_drivers.py).
 */
export async function enrichLogisticsDriversFromAdam(workDate: string, drivers: any[]): Promise<any[]> {
  if (!drivers?.length) return drivers;

  const { pgDailyAssignmentsService } = await import("./pg-daily-assignments-service");
  const lastLt = await pgDailyAssignmentsService.getLastLogisticsTransferToAdamTimestamp(workDate);
  let inProgramIds: Set<number>;
  if (!lastLt) {
    const sel = await pgDailyAssignmentsService.loadSelectedLogisticsDrivers(workDate);
    inProgramIds = new Set(sel ?? []);
  } else {
    inProgramIds = await pgDailyAssignmentsService.loadLogisticsCurrentDriverIds(workDate);
  }

  const hasReportIds = new Set<number>();
  const lastWorkedByUserId = new Map<number, string>();
  let mysqlStats = new Map<number, MysqlDriverStats>();

  const userIds = [...new Set(drivers.map((d: any) => Number(d.id)).filter((id: number) => Number.isFinite(id)))];

  try {
    const adamConnection = await mysql.createConnection({
      host: databaseConfig.mysql.host,
      port: databaseConfig.mysql.port,
      user: databaseConfig.mysql.user,
      password: databaseConfig.mysql.password,
      database: databaseConfig.mysql.database,
    });
    try {
      const [reportLast]: any = await adamConnection.execute(
        `SELECT user_id, MAX(DATE(updated_at)) AS d
         FROM app_housekeeping_report
         GROUP BY user_id`
      );
      for (const r of Array.isArray(reportLast) ? reportLast : []) {
        const id = Number(r?.user_id);
        const dateStr = toYyyyMmDd(r?.d);
        if (Number.isFinite(id) && dateStr) lastWorkedByUserId.set(id, dateStr);
      }

      const [reportRows]: any = await adamConnection.execute(
        `SELECT user_id FROM app_housekeeping_report WHERE DATE(updated_at) = ?`,
        [workDate]
      );
      for (const r of Array.isArray(reportRows) ? reportRows : []) {
        const id = Number(r?.user_id);
        if (Number.isFinite(id)) hasReportIds.add(id);
      }

      mysqlStats = await loadMysqlDriverStatsOnConnection(adamConnection, workDate, userIds);
    } finally {
      await adamConnection.end();
    }
  } catch (adamErr: any) {
    console.warn("⚠️ ADAM non disponibile per logistics drivers enrichment:", adamErr?.message);
  }

  return drivers.map((d: any) => {
    const id = Number(d.id);
    const stats = mysqlStats.get(id);
    return {
      ...d,
      last_worked_date: lastWorkedByUserId.get(id) ?? d.last_worked_date ?? null,
      show_plus_one: inProgramIds.has(id) && !hasReportIds.has(id),
      ...(stats
        ? {
            counter_hours: stats.counter_hours,
            counter_days: stats.counter_days,
            contract_type: stats.contract_type ?? d.contract_type ?? null,
          }
        : {}),
    };
  });
}
