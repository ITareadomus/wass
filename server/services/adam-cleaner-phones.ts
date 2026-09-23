import * as mysql from "mysql2/promise";
import { databaseConfig } from "../../config/database";
import { pickCleanerPhone } from "../../shared/cleaner-phone";

const phoneCache = new Map<number, string | null>();

export async function loadCleanerPhonesByIds(
  cleanerIds: number[]
): Promise<Map<number, string>> {
  const ids = [
    ...new Set(cleanerIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)),
  ];
  const out = new Map<number, string>();
  const missing = ids.filter((id) => !phoneCache.has(id));
  if (missing.length === 0) {
    for (const id of ids) {
      const phone = phoneCache.get(id);
      if (phone) out.set(id, phone);
    }
    return out;
  }
  if (!databaseConfig.isMysqlConfigured()) return out;

  let connection: mysql.Connection | null = null;
  try {
    connection = await mysql.createConnection({
      host: databaseConfig.mysql.host,
      port: databaseConfig.mysql.port,
      user: databaseConfig.mysql.user,
      password: databaseConfig.mysql.password,
      database: databaseConfig.mysql.database,
    });
    const placeholders = missing.map(() => "?").join(",");
    const [rows] = await connection.execute(
      `SELECT id, phone, mobile FROM app_users WHERE id IN (${placeholders})`,
      missing
    );
    const seen = new Set<number>();
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = Number((row as { id?: unknown }).id);
      if (!Number.isFinite(id)) continue;
      seen.add(id);
      const phone = pickCleanerPhone(row as { phone?: unknown; mobile?: unknown });
      phoneCache.set(id, phone);
      if (phone) out.set(id, phone);
    }
    for (const id of missing) {
      if (!seen.has(id)) phoneCache.set(id, null);
    }
    for (const id of ids) {
      const phone = phoneCache.get(id);
      if (phone) out.set(id, phone);
    }
  } catch (error: any) {
    console.warn("⚠️ loadCleanerPhonesByIds:", error?.message || error);
  } finally {
    if (connection) {
      try {
        await connection.end();
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}
