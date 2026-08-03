import * as mysql from "mysql2/promise";
import { databaseConfig } from "../../config/database";
import {
  parseStructureAccessBundles,
  selectDriverAccessBundles,
  type StructureAccessBundle,
  type StructureKeyTypeLookup,
} from "../../shared/structure-access-keys";

export type { StructureAccessBundle };

async function loadActiveStructureKeyTypes(
  connection: mysql.Connection
): Promise<StructureKeyTypeLookup[]> {
  const [rows] = await connection.execute(
    `
      SELECT id, name, label, active
      FROM app_structure_keys
      WHERE active = 1
    `
  );
  return (rows as any[]).map((row) => ({
    id: Number(row.id),
    name: row.name != null ? String(row.name) : null,
    label: row.label != null ? String(row.label) : null,
  }));
}

export async function loadStructureAccessBundlesByLogisticCodes(
  logisticCodes: string[]
): Promise<Map<string, StructureAccessBundle[]>> {
  const codes = [
    ...new Set(logisticCodes.map((code) => String(code ?? "").trim()).filter(Boolean)),
  ];
  const out = new Map<string, StructureAccessBundle[]>();
  if (codes.length === 0) return out;

  let connection: mysql.Connection | null = null;
  try {
    connection = await mysql.createConnection({
      host: databaseConfig.mysql.host,
      port: databaseConfig.mysql.port,
      user: databaseConfig.mysql.user,
      password: databaseConfig.mysql.password,
      database: databaseConfig.mysql.database,
    });

    const keyTypes = await loadActiveStructureKeyTypes(connection);
    const placeholders = codes.map(() => "?").join(",");
    const [rows] = await connection.execute(
      `
        SELECT logistic_code, structure_keys
        FROM app_structures
        WHERE logistic_code IN (${placeholders})
          AND structure_keys IS NOT NULL
          AND structure_keys <> ''
      `,
      codes
    );

    for (const row of rows as any[]) {
      const code = String(row?.logistic_code ?? "").trim();
      if (!code) continue;
      const rawKeys = Buffer.isBuffer(row?.structure_keys)
        ? row.structure_keys.toString("utf8")
        : row?.structure_keys;
      const bundles = parseStructureAccessBundles(rawKeys, keyTypes);
      if (bundles.length > 0) {
        out.set(code, bundles);
      }
    }
  } catch (error: any) {
    console.warn(
      "loadStructureAccessBundlesByLogisticCodes:",
      error?.message || error
    );
  } finally {
    await connection?.end();
  }

  return out;
}

export async function enrichLogisticsTimelineStructureKeys(timeline: any): Promise<void> {
  if (!timeline?.drivers_assignments?.length) return;

  const codes: string[] = [];
  for (const entry of timeline.drivers_assignments) {
    for (const task of entry?.tasks || []) {
      const code = String(task?.logistic_code ?? task?.logisticCode ?? "").trim();
      if (code) codes.push(code);
    }
  }

  const byCode = await loadStructureAccessBundlesByLogisticCodes(codes);
  if (byCode.size === 0) return;

  for (const entry of timeline.drivers_assignments) {
    for (const task of entry?.tasks || []) {
      const code = String(task?.logistic_code ?? task?.logisticCode ?? "").trim();
      const bundles = byCode.get(code);
      if (!bundles?.length) continue;
      task.structure_access_bundles = bundles;
      task.driver_access_bundles = selectDriverAccessBundles(bundles);
    }
  }
}
