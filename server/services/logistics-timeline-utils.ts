import path from "path";
import { format } from "date-fns";
import * as workspaceFiles from "./workspace-files";

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
        SELECT task_id, lat::numeric, lng::numeric, address FROM daily_logistics_assignments_current
        WHERE work_date = $1 AND task_id = ANY($2)
        UNION ALL
        SELECT task_id, lat::numeric, lng::numeric, address FROM daily_logistics_containers
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

/** Stesso script Python di HK; payload con chiave `cleaner` per compatibilità */
export async function recalculateLogisticsDriverTimes(entry: any, workDate?: string): Promise<any> {
  try {
    const { spawn } = await import("child_process");
    const dateToUse = workDate || format(new Date(), "yyyy-MM-dd");
    const driver = entry.driver || {};
    const startTime = await getDriverStartTime(driver.id, dateToUse);
    if (startTime) {
      entry.driver.start_time = startTime;
    }
    const cleanerData = {
      tasks: entry.tasks,
      cleaner: entry.driver,
      work_date: dateToUse,
      priority_windows: entry.priority_windows,
    };
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(process.cwd(), "client/public/scripts/recalculate_times.py");
      const cleanerDataJson = JSON.stringify(cleanerData);
      const pythonProcess = spawn("python3", [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      pythonProcess.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      pythonProcess.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      pythonProcess.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Python exited ${code}: ${stderr}`));
          return;
        }
        try {
          const result = JSON.parse(stdout);
          if (!result.success) {
            reject(new Error(result.error || "recalculate_times error"));
            return;
          }
          const updated = result.cleaner_data;
          entry.tasks = updated.tasks;
          resolve(entry);
        } catch (e: any) {
          reject(new Error(`Parse python output: ${e.message}`));
        }
      });
      pythonProcess.on("error", (error) => reject(error));
      try {
        pythonProcess.stdin.write(cleanerDataJson);
        pythonProcess.stdin.end();
      } catch (e: any) {
        reject(e);
      }
    });
  } catch (error: any) {
    console.error("Error in recalculateLogisticsDriverTimes:", error);
    throw error;
  }
}
