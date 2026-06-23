import * as mysql from "mysql2/promise";
import { databaseConfig } from "../../config/database";

export type StructureSofabeds = {
  single_sofabeds: number | null;
  double_sofabeds: number | null;
};

function toNullableInt(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export async function loadStructureSofabedsByLogisticCodes(
  logisticCodes: string[]
): Promise<Map<string, StructureSofabeds>> {
  const codes = [...new Set(logisticCodes.map((code) => String(code ?? "").trim()).filter(Boolean))];
  const out = new Map<string, StructureSofabeds>();
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

    const placeholders = codes.map(() => "?").join(",");
    const [rows] = await connection.execute(
      `
        SELECT logistic_code, single_sofabeds, double_sofabeds
        FROM app_structures
        WHERE logistic_code IN (${placeholders})
      `,
      codes
    );

    for (const row of rows as any[]) {
      const code = String(row?.logistic_code ?? "").trim();
      if (!code) continue;
      out.set(code, {
        single_sofabeds: toNullableInt(row.single_sofabeds),
        double_sofabeds: toNullableInt(row.double_sofabeds),
      });
    }
  } catch (error: any) {
    console.warn(
      "loadStructureSofabedsByLogisticCodes:",
      error?.message || error
    );
  } finally {
    await connection?.end();
  }

  return out;
}

export async function enrichLogisticsTimelineStructureSofabeds(timeline: any): Promise<void> {
  if (!timeline?.drivers_assignments?.length) return;

  const codes: string[] = [];
  for (const entry of timeline.drivers_assignments) {
    for (const task of entry?.tasks || []) {
      const code = String(task?.logistic_code ?? task?.logisticCode ?? "").trim();
      if (code) codes.push(code);
    }
  }

  const byCode = await loadStructureSofabedsByLogisticCodes(codes);
  if (byCode.size === 0) return;

  for (const entry of timeline.drivers_assignments) {
    for (const task of entry?.tasks || []) {
      const code = String(task?.logistic_code ?? task?.logisticCode ?? "").trim();
      const beds = byCode.get(code);
      if (!beds) continue;
      if (beds.single_sofabeds != null) task.single_sofabeds = beds.single_sofabeds;
      if (beds.double_sofabeds != null) task.double_sofabeds = beds.double_sofabeds;
    }
  }
}
