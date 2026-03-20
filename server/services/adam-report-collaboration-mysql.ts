import type { Connection } from "mysql2/promise";

/** Nella join con app_housekeeping_report (stesso schema usato altrove in WASS). */
const REPORT_ROW_ACTIVE = `(r.deleted IS NULL OR r.deleted = 0)`;

function mysqlDayToIso(d: unknown): string {
  if (d == null) return "";
  if (typeof d === "string") {
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
  }
  if (d instanceof Date) {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${mo}-${day}`;
  }
  return "";
}

/**
 * Giorni “lavorati” anche come solo collaboratore su un report (nessuna riga propria in app_housekeeping_report).
 * Arricchisce la stessa mappa usata per counter_days / streak.
 */
export async function mergeWorkedDaysFromReportCollaboration(
  conn: Connection,
  startWindowStr: string,
  endExclusiveStr: string,
  workedByUser: Map<number, Set<string>>
): Promise<void> {
  try {
    const [rows]: any = await conn.execute(
      `SELECT c.user_id AS user_id,
              DATE(COALESCE(c.updated_at, r.updated_at)) AS d
       FROM app_housekeeping_report_collaboration c
       INNER JOIN app_housekeeping_report r ON r.id = c.housekeeping_report_id
       WHERE COALESCE(c.updated_at, r.updated_at) >= ? AND COALESCE(c.updated_at, r.updated_at) < ?
         AND ${REPORT_ROW_ACTIVE}`,
      [startWindowStr, endExclusiveStr]
    );
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = Number(row?.user_id);
      const ds = mysqlDayToIso(row?.d);
      if (!Number.isFinite(id) || !ds) continue;
      if (!workedByUser.has(id)) workedByUser.set(id, new Set());
      workedByUser.get(id)!.add(ds);
    }
  } catch (e: any) {
    console.warn("⚠️ app_housekeeping_report_collaboration (worked-days):", e?.message || e);
  }
}

/**
 * Ultimo giorno lavorato come collaboratore su task housekeeping (checkout del giro, cleaned=1).
 * Integra last_worked oltre al solo titolare (cleaned_by_us).
 */
export async function mergeLastWorkedFromHousekeepingCollaborations(
  conn: Connection,
  lastWorkedByUserId: Map<number, string>
): Promise<void> {
  try {
    const [rows]: any = await conn.execute(
      `SELECT c.user_id AS user_id,
              MAX(DATE(h.checkout)) AS d
       FROM app_housekeeping_collaborations c
       INNER JOIN app_housekeeping h ON h.id = c.housekeeping_id
       WHERE h.cleaned = 1
         AND h.checkout IS NOT NULL
         AND h.deleted_at IS NULL
         AND h.deleted_at_client IS NULL
         AND (c.deleted_at IS NULL OR c.deleted_at = 0)
       GROUP BY c.user_id`
    );
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = Number(row?.user_id);
      const ds = mysqlDayToIso(row?.d);
      if (!Number.isFinite(id) || !ds) continue;
      const prev = lastWorkedByUserId.get(id);
      if (!prev || ds > prev) lastWorkedByUserId.set(id, ds);
    }
  } catch (e: any) {
    console.warn("⚠️ app_housekeeping_collaborations (last_worked):", e?.message || e);
  }
}

/** MAX(data) collaborazione-report per ultimo giorno con attività report (driver / display). */
export async function mergeLastWorkedFromReportCollaboration(
  conn: Connection,
  lastWorkedByUserId: Map<number, string>
): Promise<void> {
  try {
    const [rows]: any = await conn.execute(
      `SELECT c.user_id AS user_id,
              MAX(DATE(COALESCE(c.updated_at, r.updated_at))) AS d
       FROM app_housekeeping_report_collaboration c
       INNER JOIN app_housekeeping_report r ON r.id = c.housekeeping_report_id
       WHERE ${REPORT_ROW_ACTIVE}
       GROUP BY c.user_id`
    );
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = Number(row?.user_id);
      const ds = mysqlDayToIso(row?.d);
      if (!Number.isFinite(id) || !ds) continue;
      const prev = lastWorkedByUserId.get(id);
      if (!prev || ds > prev) lastWorkedByUserId.set(id, ds);
    }
  } catch (e: any) {
    console.warn("⚠️ app_housekeeping_report_collaboration (last_worked):", e?.message || e);
  }
}

/** Collaboratori che hanno partecipato al report in workDate (per show_plus_one / has_report). */
export async function addCollaboratorUserIdsWithReportOnDate(
  conn: Connection,
  workDate: string,
  hasReportIds: Set<number>
): Promise<void> {
  try {
    const [rows]: any = await conn.execute(
      `SELECT DISTINCT c.user_id AS user_id
       FROM app_housekeeping_report_collaboration c
       INNER JOIN app_housekeeping_report r ON r.id = c.housekeeping_report_id
       WHERE DATE(COALESCE(c.updated_at, r.updated_at)) = ?
         AND ${REPORT_ROW_ACTIVE}`,
      [workDate]
    );
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = Number(row?.user_id);
      if (Number.isFinite(id)) hasReportIds.add(id);
    }
  } catch (e: any) {
    console.warn("⚠️ app_housekeeping_report_collaboration (has_report):", e?.message || e);
  }
}
