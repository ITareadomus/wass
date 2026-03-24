import type { Connection } from "mysql2/promise";

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
