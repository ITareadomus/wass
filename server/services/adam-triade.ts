import * as mysql from "mysql2/promise";
import { databaseConfig } from "../../config/database";

/** Livello Triade del dipendente, letto da ADAM. Null se il ruolo è fuori perimetro o il livello manca. */
export type CleanerTriadeLevel = {
  level_id: number;
  name: string;
  weight: number;
  color: string;
  color_bg: string | null;
};

const HEX = /^#[0-9A-Fa-f]{6}$/;

function readHex(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return HEX.test(text) ? text.toUpperCase() : null;
}

function readLevel(row: Record<string, unknown>): CleanerTriadeLevel | null {
  const levelId = Number(row.level_id);
  const weight = Number(row.weight);
  const name = String(row.name ?? "").trim();
  const color = readHex(row.color);
  if (!Number.isFinite(levelId) || levelId <= 0) return null;
  if (!Number.isInteger(weight) || weight < 1) return null;
  if (!name || !color) return null;
  return {
    level_id: levelId,
    name,
    weight,
    color,
    color_bg: readHex(row.color_bg),
  };
}

/**
 * Livello visibile del cleaner: app_users.triade_level_id, solo se il ruolo ha enable_triade = 1
 * e il livello del catalogo è attivo.
 */
export async function loadCleanerTriadeByIds(
  cleanerIds: number[]
): Promise<Map<number, CleanerTriadeLevel>> {
  const ids = [
    ...new Set(cleanerIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)),
  ];
  const out = new Map<number, CleanerTriadeLevel>();
  if (ids.length === 0 || !databaseConfig.isMysqlConfigured()) return out;

  let connection: mysql.Connection | null = null;
  try {
    connection = await mysql.createConnection({
      host: databaseConfig.mysql.host,
      port: databaseConfig.mysql.port,
      user: databaseConfig.mysql.user,
      password: databaseConfig.mysql.password,
      database: databaseConfig.mysql.database,
    });
    const placeholders = ids.map(() => "?").join(",");
    const [rows] = await connection.execute(
      `SELECT u.id AS user_id,
              l.id AS level_id,
              l.name,
              l.weight,
              l.color,
              l.color_bg
       FROM app_users u
       INNER JOIN app_user_roles r
         ON r.id = u.user_role_id AND r.enable_triade = 1
       INNER JOIN app_triade_levels l
         ON l.id = u.triade_level_id AND l.active = 1
       WHERE u.id IN (${placeholders})
         AND u.triade_level_id IS NOT NULL`,
      ids
    );
    for (const row of Array.isArray(rows) ? rows : []) {
      const record = row as Record<string, unknown>;
      const userId = Number(record.user_id);
      const level = readLevel(record);
      if (!Number.isFinite(userId) || !level) continue;
      out.set(userId, level);
    }
  } catch (error: any) {
    console.warn("⚠️ loadCleanerTriadeByIds:", error?.message || error);
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

/** Il peso è selezionabile nell'override solo se appartiene a un livello attivo del catalogo ADAM. */
export async function isActiveTriadeWeight(weight: number): Promise<boolean> {
  if (!Number.isInteger(weight) || weight < 1) return false;
  const levels = await loadActiveTriadeLevels();
  return levels.some((level) => level.weight === weight);
}

/** Catalogo attivo, dal peso più basso. Serve al selettore di giornata. */
export async function loadActiveTriadeLevels(): Promise<CleanerTriadeLevel[]> {
  if (!databaseConfig.isMysqlConfigured()) return [];
  let connection: mysql.Connection | null = null;
  try {
    connection = await mysql.createConnection({
      host: databaseConfig.mysql.host,
      port: databaseConfig.mysql.port,
      user: databaseConfig.mysql.user,
      password: databaseConfig.mysql.password,
      database: databaseConfig.mysql.database,
    });
    const [rows] = await connection.execute(
      `SELECT id AS level_id, name, weight, color, color_bg
       FROM app_triade_levels
       WHERE active = 1
       ORDER BY weight ASC, id ASC`
    );
    const levels: CleanerTriadeLevel[] = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const level = readLevel(row as Record<string, unknown>);
      if (level) levels.push(level);
    }
    return levels;
  } catch (error: any) {
    console.warn("⚠️ loadActiveTriadeLevels:", error?.message || error);
    return [];
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

export async function withCleanerTriade<T extends { id?: number | null }>(
  cleaners: T[]
): Promise<Array<T & { triade: CleanerTriadeLevel | null }>> {
  const levels = await loadCleanerTriadeByIds(cleaners.map((cleaner) => Number(cleaner.id)));
  return cleaners.map((cleaner) => ({
    ...cleaner,
    triade: levels.get(Number(cleaner.id)) ?? null,
  }));
}
