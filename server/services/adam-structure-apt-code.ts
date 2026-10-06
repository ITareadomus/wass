import * as mysql from "mysql2/promise";
import { databaseConfig } from "../../config/database";

type TaskWithLogisticCode = {
  logistic_code?: number | string | null;
  apt_code?: string | null;
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const QUERY_CHUNK = 400;

const aptCodeCache = new Map<number, { value: string | null; expiresAt: number }>();
let aptCodeColumnMissing = false;

function readCachedAptCode(logisticCode: number): string | null | undefined {
  const hit = aptCodeCache.get(logisticCode);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    aptCodeCache.delete(logisticCode);
    return undefined;
  }
  return hit.value;
}

function rememberAptCode(logisticCode: number, value: string | null) {
  aptCodeCache.set(logisticCode, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Attacca `app_structures.apt_code` alle task, risolto via `logistic_code`.
 * Non persiste il valore: lo rilegge da ADAM a ogni miss di cache.
 */
export async function attachAptCodesFromStructures(tasks: TaskWithLogisticCode[]): Promise<void> {
  if (aptCodeColumnMissing || tasks.length === 0) return;

  const codes = [
    ...new Set(
      tasks
        .map((task) => Number(task.logistic_code))
        .filter((code) => Number.isFinite(code) && code > 0)
    ),
  ];
  if (codes.length === 0) return;

  const missing = codes.filter((code) => readCachedAptCode(code) === undefined);
  if (missing.length > 0) {
    let connection: mysql.Connection | null = null;
    try {
      connection = await mysql.createConnection({
        host: databaseConfig.mysql.host,
        port: databaseConfig.mysql.port,
        user: databaseConfig.mysql.user,
        password: databaseConfig.mysql.password,
        database: databaseConfig.mysql.database,
      });

      for (let i = 0; i < missing.length; i += QUERY_CHUNK) {
        const chunk = missing.slice(i, i + QUERY_CHUNK);
        const [rows] = await connection.execute(
          `SELECT logistic_code, apt_code
           FROM app_structures
           WHERE logistic_code IN (${chunk.map(() => "?").join(",")})`,
          chunk
        );
        const found = new Set<number>();
        for (const row of rows as Array<{ logistic_code?: unknown; apt_code?: unknown }>) {
          const code = Number(row.logistic_code);
          if (!Number.isFinite(code)) continue;
          const apt = row.apt_code != null ? String(row.apt_code).trim() : "";
          if (!found.has(code)) {
            found.add(code);
            rememberAptCode(code, apt || null);
            continue;
          }
          if (apt && !readCachedAptCode(code)) rememberAptCode(code, apt);
        }
        for (const code of chunk) {
          if (!found.has(code) && readCachedAptCode(code) === undefined) {
            rememberAptCode(code, null);
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/unknown column/i.test(message) && /apt_code/i.test(message)) {
        aptCodeColumnMissing = true;
      }
      console.error("⚠️ ADAM: errore caricamento apt_code da app_structures:", error);
      return;
    } finally {
      if (connection) await connection.end();
    }
  }

  for (const task of tasks) {
    const code = Number(task.logistic_code);
    const apt = readCachedAptCode(code);
    if (apt) task.apt_code = apt;
  }
}
