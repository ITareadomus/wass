import * as workspaceFiles from "./workspace-files";

const EARTH_RADIUS_M = 6371000;
const DEFAULT_AVG_SPEED_KMH = 28;
const BASE_MINUTES = 3;
const MIN_LEG_MIN = 2;
const MAX_LEG_MIN = 180;

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r1 = (lat1 * Math.PI) / 180;
  const r2 = (lat2 * Math.PI) / 180;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(r1) * Math.cos(r2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

export function estimateCarTravelMinutes(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
  avgSpeedKmh: number = DEFAULT_AVG_SPEED_KMH
): number {
  const meters = haversineMeters(a.lat, a.lng, b.lat, b.lng);
  const km = meters / 1000;
  const hours = km / avgSpeedKmh;
  const minutes = BASE_MINUTES + hours * 60;
  return Math.round(Math.max(MIN_LEG_MIN, Math.min(MAX_LEG_MIN, minutes)));
}

export async function getDriverStartTime(driverId: number, workDate: string): Promise<string | null> {
  try {
    const sel = await workspaceFiles.loadSelectedLogisticsDrivers(workDate);
    if (sel?.drivers) {
      const d = sel.drivers.find((x: any) => x.id === driverId);
      if (d?.start_time) return d.start_time;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function hydrateTasksFromLogisticsContainers(driverData: any, workDate: string): Promise<any> {
  if (!driverData?.tasks || driverData.tasks.length === 0) {
    return driverData;
  }
  try {
    const { query } = await import("../../shared/pg-db");
    const taskIds = driverData.tasks.map((t: any) => t.task_id).filter((id: any) => id != null);
    if (taskIds.length === 0) return driverData;
    const result = await query(
      `
      SELECT task_id, lat, lng, address FROM (
        SELECT task_id, lat::numeric, lng::numeric, address FROM lg_timeline
        WHERE work_date = $1 AND task_id = ANY($2)
        UNION ALL
        SELECT task_id, lat::numeric, lng::numeric, address FROM lg_containers
        WHERE work_date = $1 AND task_id = ANY($2)
      ) combined
    `,
      [workDate, taskIds]
    );
    const coordsMap = new Map<number, { lat: number | null; lng: number | null; address: string | null }>();
    for (const row of result.rows) {
      const taskIdNum = parseInt(String(row.task_id), 10);
      if (!coordsMap.has(taskIdNum)) {
        const lat = row.lat != null ? parseFloat(String(row.lat)) : null;
        const lng = row.lng != null ? parseFloat(String(row.lng)) : null;
        coordsMap.set(taskIdNum, {
          lat: lat && !isNaN(lat) && Math.abs(lat) > 0.0001 ? lat : null,
          lng: lng && !isNaN(lng) && Math.abs(lng) > 0.0001 ? lng : null,
          address: row.address || null,
        });
      }
    }
    for (const task of driverData.tasks) {
      const taskIdNum = parseInt(String(task.task_id), 10);
      const geo = coordsMap.get(taskIdNum);
      if (geo) {
        if (geo.lat !== null) task.lat = geo.lat;
        if (geo.lng !== null) task.lng = geo.lng;
        if (geo.address && !task.address) task.address = geo.address;
      }
    }
  } catch (error: any) {
    console.warn(`⚠️ hydrateTasksFromLogisticsContainers: ${error.message}`);
  }
  return driverData;
}

function parseTimeToMinutes(value: unknown, fallback: number): number {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return fallback;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return fallback;
  return h * 60 + m;
}

function minutesToHHMM(totalMinutes: number): string {
  const bounded = Math.max(0, Math.min(24 * 60 - 1, Math.round(totalMinutes)));
  const h = Math.floor(bounded / 60);
  const m = bounded % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Logistics-only recalc: route travel + fixed 15m service window */
export async function recalculateLogisticsDriverTimes(entry: any, workDate?: string): Promise<any> {
  const dateToUse = workDate || new Date().toISOString().slice(0, 10);
  const driver = entry.driver || {};
  const startTime = await getDriverStartTime(driver.id, dateToUse);
  if (startTime) {
    entry.driver.start_time = startTime;
  }

  const tasks: any[] = Array.isArray(entry.tasks) ? entry.tasks : [];
  if (tasks.length === 0) {
    entry.tasks = [];
    return entry;
  }

  const driverStartMin = parseTimeToMinutes(entry.driver?.start_time, 10 * 60);
  let clockMin = driverStartMin;
  let prevLat: number | null = null;
  let prevLng: number | null = null;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const lat = toFiniteNumber(task?.lat);
    const lng = toFiniteNumber(task?.lng);
    let travel = 0;
    if (i > 0 && prevLat !== null && prevLng !== null && lat !== null && lng !== null) {
      travel = estimateCarTravelMinutes({ lat: prevLat, lng: prevLng }, { lat, lng });
    }
    const startMin = clockMin + travel;
    const endMin = startMin + 15;

    task.travel_time = travel;
    task.start_time = minutesToHHMM(startMin);
    task.end_time = minutesToHHMM(endMin);
    task.sequence = i + 1;
    task.followup = i > 0;

    clockMin = endMin;
    prevLat = lat;
    prevLng = lng;
  }

  entry.tasks = tasks;
  return entry;
}
