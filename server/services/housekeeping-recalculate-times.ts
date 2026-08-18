import path from "path";
import { spawn } from "child_process";
import * as workspaceFiles from "./workspace-files";
import { pgSettingsService } from "./pg-settings-service";
import {
  buildSchedulingWindows,
  parsePrioritySettings,
} from "../../shared/taskPriorityClassification";

async function getCleanerStartTime(
  cleanerId: number,
  workDate: string,
  scope: "housekeeping" | "office" = "housekeeping"
): Promise<string | null> {
  try {
    const selectedCleaners = await workspaceFiles.loadSelectedCleaners(workDate, scope);
    const cleaner = selectedCleaners?.cleaners?.find((c: any) => Number(c.id) === Number(cleanerId));
    return cleaner?.start_time || null;
  } catch {
    return null;
  }
}

async function getCleanerEndTime(
  cleanerId: number,
  workDate: string,
  scope: "housekeeping" | "office" = "housekeeping"
): Promise<string | null> {
  try {
    const selectedCleaners = await workspaceFiles.loadSelectedCleaners(workDate, scope);
    const cleaner = selectedCleaners?.cleaners?.find((c: any) => Number(c.id) === Number(cleanerId));
    return cleaner?.end_time || null;
  } catch {
    return null;
  }
}

/** Hydrate lat/lng/address from PG assignments + containers. */
export async function hydrateTasksFromContainers(
  cleanerData: any,
  workDate: string
): Promise<any> {
  if (!cleanerData?.tasks || cleanerData.tasks.length === 0) {
    return cleanerData;
  }

  try {
    const { query } = await import("../../shared/pg-db");
    const taskIds = cleanerData.tasks
      .map((t: any) => t.task_id)
      .filter((id: any) => id != null);
    if (taskIds.length === 0) return cleanerData;

    const result = await query(
      `
      SELECT task_id, lat, lng, address FROM (
        SELECT task_id, lat::numeric, lng::numeric, address FROM daily_assignments_current
        WHERE work_date = $1 AND task_id = ANY($2)
        UNION ALL
        SELECT task_id, lat::numeric, lng::numeric, address FROM daily_containers
        WHERE work_date = $1 AND task_id = ANY($2)
      ) combined
    `,
      [workDate, taskIds]
    );

    const coordsMap = new Map<
      number,
      { lat: number | null; lng: number | null; address: string | null }
    >();
    for (const row of result.rows) {
      const taskIdNum = parseInt(String(row.task_id), 10);
      if (coordsMap.has(taskIdNum)) continue;
      const lat = row.lat != null ? parseFloat(String(row.lat)) : null;
      const lng = row.lng != null ? parseFloat(String(row.lng)) : null;
      coordsMap.set(taskIdNum, {
        lat: lat && !isNaN(lat) && Math.abs(lat) > 0.0001 ? lat : null,
        lng: lng && !isNaN(lng) && Math.abs(lng) > 0.0001 ? lng : null,
        address: row.address || null,
      });
    }

    for (const task of cleanerData.tasks) {
      const taskIdNum = parseInt(String(task.task_id), 10);
      const geo = coordsMap.get(taskIdNum);
      if (!geo) continue;
      if (geo.lat !== null) task.lat = geo.lat;
      if (geo.lng !== null) task.lng = geo.lng;
      if (geo.address && !task.address) task.address = geo.address;
    }
  } catch (error: any) {
    console.warn(`⚠️ Could not hydrate tasks from PostgreSQL: ${error.message}`);
  }

  return cleanerData;
}

/**
 * Recalculate travel_time, start_time, end_time for a cleaner's tasks via Python.
 */
export async function recalculateCleanerTimes(
  cleanerData: any,
  workDate?: string,
  scope: "housekeeping" | "office" = "housekeeping"
): Promise<any> {
  const dateToUse = workDate || new Date().toISOString().slice(0, 10);
  const startTime = await getCleanerStartTime(cleanerData.cleaner.id, dateToUse, scope);
  const endTime = await getCleanerEndTime(cleanerData.cleaner.id, dateToUse, scope);
  if (startTime) cleanerData.cleaner.start_time = startTime;
  if (endTime) cleanerData.cleaner.end_time = endTime;

  let priorityWindows: Record<string, { start_min: number }> | undefined;
  try {
    await pgSettingsService.ensureTables();
    const appSettings = await pgSettingsService.getSettings("app_settings");
    const parsedPrioritySettings = parsePrioritySettings(appSettings ?? {});
    const windows = buildSchedulingWindows(parsedPrioritySettings);
    priorityWindows = {
      EO: { start_min: windows.EO.startMin },
      HP: { start_min: windows.HP.startMin },
      LP: { start_min: windows.LP.startMin },
    };
  } catch (settingsError) {
    console.warn(
      "⚠️ Unable to load priority windows from app_settings for manual recalc:",
      settingsError
    );
  }

  return new Promise((resolve, reject) => {
    const scriptPath = path.join(process.cwd(), "client/public/scripts/recalculate_times.py");
    const cleanerDataJson = JSON.stringify({
      ...cleanerData,
      ...(priorityWindows ? { priority_windows: priorityWindows } : {}),
    });

    const pythonProcess = spawn("python3", [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

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
        reject(new Error(`Python script exited with code ${code}: ${stderr}`));
        return;
      }
      if (stderr && stderr.trim()) {
        console.warn("Python stderr:", stderr);
      }
      try {
        const result = JSON.parse(stdout);
        if (!result.success) {
          reject(new Error(result.error || "Unknown error from Python script"));
          return;
        }
        resolve(result.cleaner_data);
      } catch (parseError: any) {
        reject(new Error(`Failed to parse Python output: ${parseError.message}`));
      }
    });

    pythonProcess.on("error", (error) => {
      reject(new Error(`Failed to spawn Python process: ${error.message}`));
    });

    try {
      pythonProcess.stdin.write(cleanerDataJson);
      pythonProcess.stdin.end();
    } catch (writeError: any) {
      reject(new Error(`Failed to write to Python stdin: ${writeError.message}`));
    }
  });
}
