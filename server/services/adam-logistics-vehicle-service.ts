import type { Connection } from "mysql2/promise";
import * as mysql from "mysql2/promise";
import { format } from "date-fns";
import { databaseConfig } from "../../config/database";

export type LogisticsVehicleRow = {
  id: number;
  name: string;
  pms_code: string | null;
};

/**
 * Catalogo veicoli ADAM (structure_kind_id = 6) per dropdown convocazioni.
 */
export async function loadLogisticsVehiclesCatalog(connection: Connection): Promise<LogisticsVehicleRow[]> {
  const run = async (table: string): Promise<any[]> => {
    const [rows]: any = await connection.execute(
      `
        SELECT id, name, pms_code
        FROM ${table}
        WHERE structure_kind_id = 6
          AND active = 1
        ORDER BY name ASC
      `
    );
    return Array.isArray(rows) ? rows : [];
  };

  let list: any[] = [];
  try {
    list = await run("app_structures");
  } catch {
    try {
      list = await run("app_structure");
    } catch {
      return [];
    }
  }

  return list
    .map((r: any) => ({
      id: Number(r?.id),
      name: String(r?.name ?? r?.alias ?? r?.title ?? "").trim() || `Veicolo ${r?.id}`,
      pms_code:
        r?.pms_code != null && String(r.pms_code).trim()
          ? String(r.pms_code).trim()
          : r?.customer_structure_reference != null && String(r.customer_structure_reference).trim()
            ? String(r.customer_structure_reference).trim()
            : null,
    }))
    .filter((v) => Number.isFinite(v.id));
}

/** Normalizza vehicle_id salvato: usa structure_id ADAM reale. */
export function normalizeVehicleStructureId(vehicleIdRaw: number | null | undefined): number | null {
  if (vehicleIdRaw == null || !Number.isFinite(Number(vehicleIdRaw))) return null;
  return Number(vehicleIdRaw);
}

async function detectStructuresTable(connection: Connection): Promise<string> {
  try {
    await connection.execute("SELECT 1 FROM app_structures LIMIT 1");
    return "app_structures";
  } catch {
    return "app_structure";
  }
}

/**
 * Per ogni structure_id veicolo, task ADAM del giorno con id massimo (policy confermata).
 */
export async function resolveVehicleStructureIdsToTaskIds(
  connection: Connection,
  workDate: string,
  structureIds: number[]
): Promise<{ map: Map<number, number>; warnings: string[] }> {
  const out = new Map<number, number>();
  const warnings: string[] = [];
  const ids = [...new Set(structureIds.filter((x) => Number.isFinite(x) && x > 0))];
  if (ids.length === 0) return { map: out, warnings };

  const structsTable = await detectStructuresTable(connection);
  const structPh = ids.map(() => "?").join(",");

  const params: any[] = [workDate, ...ids];
  const sql = `
    SELECT h.structure_id AS structure_id, MAX(h.id) AS task_id
    FROM app_housekeeping h
    INNER JOIN ${structsTable} s ON s.id = h.structure_id
    WHERE h.checkout = ?
      AND h.deleted_at IS NULL
      AND h.deleted_at_client IS NULL
      AND s.structure_kind_id = 6
      AND h.structure_id IN (${structPh})
    GROUP BY h.structure_id
  `;

  try {
    const [rows]: any = await connection.execute(sql, params);
    for (const r of Array.isArray(rows) ? rows : []) {
      const sid = Number(r?.structure_id);
      const tid = Number(r?.task_id);
      if (Number.isFinite(sid) && Number.isFinite(tid)) out.set(sid, tid);
    }
  } catch (e: any) {
    warnings.push(`resolveVehicleTasks query failed: ${e?.message || e}`);
    return { map: out, warnings };
  }

  for (const sid of ids) {
    if (!out.has(sid)) {
      warnings.push(`Nessun task app_housekeeping per veicolo structure_id=${sid} in data ${workDate}`);
    }
  }

  return { map: out, warnings };
}

/**
 * Tutti i task_id app_housekeeping "veicolo" per una work date (per sync cleaned_by_us nel transfer).
 */
export async function listVehicleHousekeepingTaskIdsForDate(
  connection: Connection,
  workDate: string
): Promise<number[]> {
  const structsTable = await detectStructuresTable(connection);
  const params: any[] = [workDate];
  const sql = `
    SELECT h.id AS task_id
    FROM app_housekeeping h
    INNER JOIN ${structsTable} s ON s.id = h.structure_id
    WHERE h.checkout = ?
      AND h.deleted_at IS NULL
      AND h.deleted_at_client IS NULL
      AND s.structure_kind_id = 6
  `;
  const [rows]: any = await connection.execute(sql, params);
  return (Array.isArray(rows) ? rows : [])
    .map((r: any) => Number(r?.task_id))
    .filter((n: number) => Number.isFinite(n));
}

export type VehicleDriverBindingPending = {
  structureId: number;
  driverId: number;
};

export type LogisticsDriverVehiclesAdamSyncResult = {
  success: boolean;
  message: string;
  vehicle_task_count: number;
  adam_updates_attempted: number;
  adam_update_errors: number;
  warnings: string[];
};

/**
 * Costruisce il mapping task veicolo → driver dalle assegnazioni PG.
 * Senza binding (convocazioni vuote / driver rimosso) il map resta vuoto:
 * il sync ADAM deve comunque girare e azzerare cleaned_by_us.
 */
export function collectVehicleDriverBindings(
  vehicleAssignments: Record<string, any> | null | undefined
): {
  taskToDriver: Map<number, number>;
  pendingStructureResolve: VehicleDriverBindingPending[];
} {
  const taskToDriver = new Map<number, number>();
  const pendingStructureResolve: VehicleDriverBindingPending[] = [];

  for (const [driverIdStr, assignment] of Object.entries(vehicleAssignments || {})) {
    const driverId = Number(driverIdStr);
    if (!Number.isFinite(driverId) || !assignment || typeof assignment !== "object") continue;
    const structureId = normalizeVehicleStructureId(
      assignment.vehicle_id != null ? Number(assignment.vehicle_id) : null
    );
    if (!structureId) continue;

    const taskId =
      assignment.vehicle_task_id != null && Number.isFinite(Number(assignment.vehicle_task_id))
        ? Number(assignment.vehicle_task_id)
        : null;
    if (taskId != null) {
      taskToDriver.set(taskId, driverId);
    } else {
      pendingStructureResolve.push({ structureId, driverId });
    }
  }

  return { taskToDriver, pendingStructureResolve };
}

export function applyResolvedVehicleStructureBindings(
  pendingStructureResolve: VehicleDriverBindingPending[],
  structureToTask: Map<number, number>,
  taskToDriver: Map<number, number>
): void {
  for (const { structureId, driverId } of pendingStructureResolve) {
    const taskId = structureToTask.get(structureId);
    if (taskId != null) taskToDriver.set(taskId, driverId);
  }
}

/**
 * Allinea i task veicolo del giorno su ADAM a vehicle_assignments PG.
 * Lista vuota = cleaned_by_us NULL su tutti i task veicolo della data.
 */
export async function syncLogisticsDriverVehiclesToAdam(
  connection: Connection,
  params: {
    workDate: string;
    vehicleAssignments: Record<string, any> | null | undefined;
    adamUpdatedBy: string;
    nowRome: string;
  }
): Promise<LogisticsDriverVehiclesAdamSyncResult> {
  const { workDate, vehicleAssignments, adamUpdatedBy, nowRome } = params;
  const { taskToDriver, pendingStructureResolve } = collectVehicleDriverBindings(vehicleAssignments);
  const warnings: string[] = [];

  if (pendingStructureResolve.length > 0) {
    const uniqueStructureIds = [...new Set(pendingStructureResolve.map((item) => item.structureId))];
    const { map, warnings: resolveWarnings } = await resolveVehicleStructureIdsToTaskIds(
      connection,
      workDate,
      uniqueStructureIds
    );
    applyResolvedVehicleStructureBindings(pendingStructureResolve, map, taskToDriver);
    warnings.push(...resolveWarnings);
  }

  const allVehicleTaskIds = await listVehicleHousekeepingTaskIdsForDate(connection, workDate);
  let updated = 0;
  let errors = 0;

  for (const taskId of allVehicleTaskIds) {
    const cleanedBy = taskToDriver.get(taskId) ?? null;
    const assignedAtUs = cleanedBy != null ? nowRome : null;
    const assignedAtMilliseconds = cleanedBy != null ? Date.now() : null;
    try {
      await connection.execute(
        `UPDATE app_housekeeping
         SET
           cleaned_by_us = ?,
           sequence = NULL,
           updated_by = ?,
           updated_at = ?,
           assigned_at_us = ?,
           assigned_at_milliseconds = ?,
           collaboration = 0,
           collaboration_by = NULL,
           collaboration_at = NULL,
           collaboration_bypass = 0,
           helpwork = 0,
           helpwork_by = 0,
           helpwork_at = NULL,
           startwork = 0,
           startwork_at = NULL,
           startreport = 0,
           startreport_at = NULL,
           extratimes = ''
         WHERE id = ?`,
        [cleanedBy, adamUpdatedBy, nowRome, assignedAtUs, assignedAtMilliseconds, taskId]
      );
      updated++;
    } catch (error) {
      errors++;
      console.error(`sync-logistics-driver-vehicles-to-adam task ${taskId}:`, error);
    }
  }

  const assignedCount = taskToDriver.size;
  const message =
    assignedCount === 0
      ? `Liberati ${allVehicleTaskIds.length} task veicolo su ADAM`
      : `Sync driver-veicolo completata su ${allVehicleTaskIds.length} task veicolo`;

  return {
    success: true,
    message,
    vehicle_task_count: allVehicleTaskIds.length,
    adam_updates_attempted: updated,
    adam_update_errors: errors,
    warnings,
  };
}

export async function runLogisticsDriverVehiclesAdamSync(
  workDate: string,
  username: string
): Promise<LogisticsDriverVehiclesAdamSyncResult> {
  const { pgDailyAssignmentsService } = await import("./pg-daily-assignments-service");
  const { pgUsersService } = await import("./pg-users-service");

  const vehicleAssignments =
    await pgDailyAssignmentsService.loadSelectedLogisticsDriverVehicleAssignments(workDate);
  const userRecord = await pgUsersService.getUserByUsername(username);
  const adamUpdatedBy = userRecord?.adam_id ? `E${userRecord.adam_id}` : username;

  let connection: Connection | null = null;
  try {
    connection = await mysql.createConnection({
      host: databaseConfig.mysql.host,
      port: databaseConfig.mysql.port,
      user: databaseConfig.mysql.user,
      password: databaseConfig.mysql.password,
      database: databaseConfig.mysql.database,
    });
    return await syncLogisticsDriverVehiclesToAdam(connection, {
      workDate,
      vehicleAssignments,
      adamUpdatedBy,
      nowRome: format(new Date(), "yyyy-MM-dd HH:mm:ss"),
    });
  } finally {
    if (connection) {
      try {
        await connection.end();
      } catch {
        /* ignore */
      }
    }
  }
}
