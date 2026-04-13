import pool from '../../../shared/pg-db';
import type { DriverInput, HousekeepingWindow, LogisticsTaskInput } from './types';

/** Parse HH:MM or HH:MM:SS to minutes from midnight */
export function parseTimeToMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const s = String(value).trim().slice(0, 8);
  const parts = s.split(':');
  if (parts.length < 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/**
 * Source of truth for housekeeping schedule: daily_assignments_current (housekeeping scope).
 */
export async function loadHousekeepingWindows(workDate: string): Promise<Map<number, HousekeepingWindow>> {
  const result = await pool.query<{
    task_id: number;
    cleaner_id: number;
    start_time: string | null;
    end_time: string | null;
  }>(
    `
    SELECT task_id, cleaner_id, start_time::text as start_time, end_time::text as end_time
    FROM daily_assignments_current
    WHERE work_date = $1
      AND (scope = 'housekeeping' OR scope IS NULL)
      AND start_time IS NOT NULL
      AND end_time IS NOT NULL
    ORDER BY cleaner_id, sequence
    `,
    [workDate]
  );

  const map = new Map<number, HousekeepingWindow>();
  for (const row of result.rows) {
    const sm = parseTimeToMinutes(row.start_time);
    const em = parseTimeToMinutes(row.end_time);
    if (sm === null || em === null) continue;
    map.set(row.task_id, {
      taskId: row.task_id,
      cleanerId: row.cleaner_id,
      startMin: sm,
      endMin: em
    });
  }
  return map;
}

export async function hasAnyHousekeepingAssignments(workDate: string): Promise<boolean> {
  const r = await pool.query<{ c: string }>(
    `
    SELECT COUNT(*)::text as c FROM daily_assignments_current
    WHERE work_date = $1 AND (scope = 'housekeeping' OR scope IS NULL)
    `,
    [workDate]
  );
  return parseInt(r.rows[0]?.c || '0', 10) > 0;
}

export async function loadLogisticsTasksFromDb(workDate: string): Promise<LogisticsTaskInput[]> {
  const lockRes = await pool.query<{ task_id: number }>(
    `SELECT task_id FROM daily_task_locks WHERE work_date = $1 AND locked = true`,
    [workDate]
  );
  const lockedIds = new Set(lockRes.rows.map((r) => r.task_id));

  const { rows } = await pool.query<{
    task_id: number;
    logistic_code: number;
    lat: string | null;
    lng: string | null;
    cleaning_time: number | null;
    locked: boolean | null;
  }>(
    `
    SELECT task_id, logistic_code, lat::text as lat, lng::text as lng,
           COALESCE(cleaning_time, 15) as cleaning_time,
           COALESCE(locked, false) as locked
    FROM lg_containers
    WHERE work_date = $1
    ORDER BY task_id
    `,
    [workDate]
  );

  const out: LogisticsTaskInput[] = [];
  for (const row of rows) {
    if (row.lat == null || row.lng == null) continue;
    const lat = parseFloat(row.lat);
    const lng = parseFloat(row.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const svc = Math.max(5, Math.min(240, Number(row.cleaning_time) || 15));
    const locked = lockedIds.has(row.task_id) || row.locked === true;
    out.push({
      taskId: row.task_id,
      logisticCode: row.logistic_code,
      lat,
      lng,
      serviceMinutes: Math.min(60, svc),
      locked
    });
  }
  return out;
}

export async function loadSelectedLogisticsDriverIds(workDate: string): Promise<number[]> {
  const r = await pool.query<{ drivers: number[] | null }>(
    `SELECT drivers FROM lg_selected_drivers WHERE work_date = $1`,
    [workDate]
  );
  const arr = r.rows[0]?.drivers;
  if (!arr || !Array.isArray(arr)) return [];
  return arr.map((x) => Number(x)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
}

export async function loadLogisticsDriversMeta(
  workDate: string,
  driverIds: number[]
): Promise<DriverInput[]> {
  if (driverIds.length === 0) return [];
  const r = await pool.query<{
    driver_id: number;
    name: string | null;
    lastname: string | null;
    start_time: string | null;
  }>(
    `
    SELECT driver_id, name, lastname, start_time::text as start_time
    FROM lg_drivers
    WHERE work_date = $1 AND driver_id = ANY($2::int[])
    ORDER BY driver_id
    `,
    [workDate, driverIds]
  );
  return r.rows.map((row) => ({
    driverId: row.driver_id,
    name: row.name || '',
    lastname: row.lastname || '',
    startTime: row.start_time?.slice(0, 5) || '08:00'
  }));
}

export async function insertLogisticsOptimizerRun(
  runId: string,
  workDate: string,
  algorithmVersion: string,
  params: Record<string, unknown>,
  status: string,
  summary: Record<string, unknown> | null
): Promise<void> {
  await pool.query(
    `
    INSERT INTO optimizer.optimizer_run (run_id, work_date, algorithm_version, params, status, summary)
    VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb)
    `,
    [runId, workDate, algorithmVersion, JSON.stringify(params), status, summary ? JSON.stringify(summary) : null]
  );
}

export async function updateLogisticsOptimizerRun(
  runId: string,
  status: string,
  summary: Record<string, unknown> | null
): Promise<void> {
  await pool.query(
    `UPDATE optimizer.optimizer_run SET status = $2, summary = $3::jsonb WHERE run_id = $1`,
    [runId, status, summary ? JSON.stringify(summary) : null]
  );
}

export async function insertLogisticsDecisionsBatch(
  rows: { runId: string; phase: number; eventType: string; payload: Record<string, unknown> }[]
): Promise<number> {
  if (rows.length === 0) return 0;
  const BATCH = 200;
  let n = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const vals: unknown[] = [];
    const ph: string[] = [];
    batch.forEach((d, idx) => {
      const o = idx * 4;
      ph.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}::jsonb)`);
      vals.push(d.runId, d.phase, d.eventType, JSON.stringify(d.payload));
    });
    await pool.query(
      `INSERT INTO optimizer.optimizer_decision (run_id, phase, event_type, payload) VALUES ${ph.join(', ')}`,
      vals
    );
    n += batch.length;
  }
  return n;
}
