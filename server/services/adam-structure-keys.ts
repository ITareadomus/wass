import * as mysql from "mysql2/promise";
import { databaseConfig } from "../../config/database";
import {
  parseStructureAccessBundles,
  selectDriverAccessBundles,
  type StructureAccessBundle,
  type StructureKeyTypeLookup,
} from "../../shared/structure-access-keys";

export type { StructureAccessBundle };

const BUNDLE_CACHE_TTL_MS = 10 * 60 * 1000;
const bundleCache = new Map<string, { bundles: StructureAccessBundle[]; expiresAt: number }>();

function readBundleCache(code: string): StructureAccessBundle[] | undefined {
  const hit = bundleCache.get(code);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    bundleCache.delete(code);
    return undefined;
  }
  return hit.bundles;
}

function rememberBundles(code: string, bundles: StructureAccessBundle[]) {
  bundleCache.set(code, { bundles, expiresAt: Date.now() + BUNDLE_CACHE_TTL_MS });
}

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

  const missing: string[] = [];
  for (const code of codes) {
    const cached = readBundleCache(code);
    if (cached) out.set(code, cached);
    else missing.push(code);
  }
  if (missing.length === 0) return out;

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
    const placeholders = missing.map(() => "?").join(",");
    const [rows] = await connection.execute(
      `
        SELECT logistic_code, structure_keys
        FROM app_structures
        WHERE logistic_code IN (${placeholders})
          AND structure_keys IS NOT NULL
          AND structure_keys <> ''
      `,
      missing
    );

    const found = new Set<string>();
    for (const row of rows as any[]) {
      const code = String(row?.logistic_code ?? "").trim();
      if (!code || found.has(code)) continue;
      found.add(code);
      const rawKeys = Buffer.isBuffer(row?.structure_keys)
        ? row.structure_keys.toString("utf8")
        : row?.structure_keys;
      const bundles = parseStructureAccessBundles(rawKeys, keyTypes);
      rememberBundles(code, bundles);
      if (bundles.length > 0) out.set(code, bundles);
    }
    for (const code of missing) {
      if (!found.has(code)) rememberBundles(code, []);
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

export async function loadDialogAccessBundles(
  logisticCode: string
): Promise<StructureAccessBundle[]> {
  const code = String(logisticCode ?? "").trim();
  if (!code) return [];
  const byCode = await loadStructureAccessBundlesByLogisticCodes([code]);
  return selectDriverAccessBundles(byCode.get(code) ?? []).map((bundle) => ({
    ...bundle,
    choices: bundle.choices.map((choice) => ({
      name: choice.name,
      type: choice.typeLabel ? choice.type : null,
      typeLabel: choice.typeLabel,
      value: null,
    })),
  }));
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
