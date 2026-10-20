import bcrypt from "bcrypt";
import mysql from "mysql2/promise";
import { databaseConfig } from "../../config/database";
import { query } from "../../shared/pg-db";

const WASS_ROLES = ["admin", "user", "viewer", "logistica"] as const;
export type AdamWassRole = (typeof WASS_ROLES)[number];

const BACKPACK_USER = "App\\Models\\Users\\BackpackUser";
const ADAM_ROLE_NAME = "wass";

export interface AdamWassAccount {
  id: number;
  username: string;
  role: AdamWassRole;
  source: "adam";
  displayName: string;
  adam_id: number;
}

function isWassRole(role: string): role is AdamWassRole {
  return (WASS_ROLES as readonly string[]).includes(role);
}

function displayName(name: unknown, lastname: unknown): string {
  return [name, lastname]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join(" ");
}

/** PHP/Laravel salva spesso hash $2y$; bcrypt di Node confronta $2a$/$2b$. */
function hashForCompare(hash: string): string {
  if (hash.startsWith("$2y$")) return `$2b$${hash.slice(4)}`;
  return hash;
}

async function withMysql<T>(run: (connection: mysql.Connection) => Promise<T>): Promise<T> {
  if (!databaseConfig.isMysqlConfigured()) {
    throw new Error("MySQL ADAM non configurato");
  }
  const connection = await mysql.createConnection({
    host: databaseConfig.mysql.host,
    port: databaseConfig.mysql.port,
    user: databaseConfig.mysql.user,
    password: databaseConfig.mysql.password,
    database: databaseConfig.mysql.database,
  });
  try {
    return await run(connection);
  } finally {
    await connection.end();
  }
}

export async function ensureAdamWassRoleTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS adam_wass_account_roles (
      employee_id INTEGER PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'user',
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function loadStoredRoles(): Promise<Map<number, AdamWassRole>> {
  await ensureAdamWassRoleTable();
  const result = await query("SELECT employee_id, role FROM adam_wass_account_roles");
  const roles = new Map<number, AdamWassRole>();
  for (const row of result.rows) {
    const id = Number(row.employee_id);
    const role = String(row.role ?? "");
    if (Number.isInteger(id) && isWassRole(role)) roles.set(id, role);
  }
  return roles;
}

const EMPLOYEE_JOIN = `
  FROM app_employees e
  INNER JOIN app_model_has_roles m
    ON m.model_id = e.id
   AND m.model_type = ?
  INNER JOIN app_roles r
    ON r.id = m.role_id
   AND r.name = ?
  WHERE e.deleted_at IS NULL
    AND e.active = 1
    AND e.email IS NOT NULL
    AND e.email <> ''
`;

export async function listAdamWassAccounts(): Promise<AdamWassAccount[]> {
  const roles = await loadStoredRoles();
  const employees = await withMysql(async (connection) => {
    const [rows] = await connection.execute(
      `SELECT e.id, e.email, e.name, e.lastname ${EMPLOYEE_JOIN} ORDER BY e.email`,
      [BACKPACK_USER, ADAM_ROLE_NAME]
    );
    return Array.isArray(rows) ? rows : [];
  });

  return employees.map((row) => {
    const record = row as { id?: unknown; email?: unknown; name?: unknown; lastname?: unknown };
    const id = Number(record.id);
    const email = String(record.email ?? "").trim();
    return {
      id,
      username: email,
      role: roles.get(id) ?? "user",
      source: "adam" as const,
      displayName: displayName(record.name, record.lastname),
      adam_id: id,
    };
  });
}

export async function setAdamWassAccountRole(
  employeeId: number,
  role: string
): Promise<"ok" | "invalid" | "missing"> {
  if (!Number.isInteger(employeeId) || employeeId <= 0 || !isWassRole(role)) return "invalid";
  const accounts = await listAdamWassAccounts();
  if (!accounts.some((account) => account.id === employeeId)) return "missing";
  await ensureAdamWassRoleTable();
  await query(
    `INSERT INTO adam_wass_account_roles (employee_id, role, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (employee_id) DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()`,
    [employeeId, role]
  );
  return "ok";
}

/** Id dipendente ADAM (ruolo wass) a partire dall'email di login. */
export async function findAdamWassEmployeeIdByEmail(email: string): Promise<number | null> {
  const normalized = email.trim();
  if (!normalized) return null;
  const row = await withMysql(async (connection) => {
    const [rows] = await connection.execute(
      `SELECT e.id ${EMPLOYEE_JOIN} AND LOWER(e.email) = LOWER(?) LIMIT 1`,
      [BACKPACK_USER, ADAM_ROLE_NAME, normalized]
    );
    const list = Array.isArray(rows) ? rows : [];
    return (list[0] as { id?: unknown } | undefined) ?? null;
  });
  const id = Number(row?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Valore per `updated_by` / `deleted_by` su ADAM.
 * Account WASS con adam_id → `E{id}`.
 * Account ADAM (username = email, assenti da `users`) → stesso codice, letto dal dipendente.
 * Altrimenti lo username corto degli account locali.
 */
export async function resolveAdamUpdatedBy(username: string | null | undefined): Promise<string> {
  const name = String(username ?? "").trim() || "system";
  try {
    const { pgUsersService } = await import("./pg-users-service");
    const userRecord = await pgUsersService.getUserByUsername(name);
    if (userRecord?.adam_id) return `E${userRecord.adam_id}`;
  } catch (error) {
    console.warn("resolveAdamUpdatedBy: lookup utenti WASS fallito", error);
  }
  if (name.includes("@")) {
    try {
      const employeeId = await findAdamWassEmployeeIdByEmail(name);
      if (employeeId) return `E${employeeId}`;
    } catch (error) {
      console.warn("resolveAdamUpdatedBy: lookup dipendente ADAM fallito", error);
    }
  }
  return name;
}

export async function loginAdamWassAccount(
  email: string,
  password: string
): Promise<AdamWassAccount | null> {
  const normalized = email.trim();
  if (!normalized || !password) return null;

  const row = await withMysql(async (connection) => {
    const [rows] = await connection.execute(
      `SELECT e.id, e.email, e.name, e.lastname, e.password ${EMPLOYEE_JOIN} AND LOWER(e.email) = LOWER(?) LIMIT 1`,
      [BACKPACK_USER, ADAM_ROLE_NAME, normalized]
    );
    const list = Array.isArray(rows) ? rows : [];
    return (list[0] as { id?: unknown; email?: unknown; name?: unknown; lastname?: unknown; password?: unknown } | undefined) ?? null;
  });
  if (!row) return null;

  const hash = typeof row.password === "string" ? row.password : "";
  if (!hash.startsWith("$2")) return null;
  const matches = await bcrypt.compare(password, hashForCompare(hash));
  if (!matches) return null;

  const id = Number(row.id);
  const roles = await loadStoredRoles();
  return {
    id,
    username: String(row.email ?? "").trim(),
    role: roles.get(id) ?? "user",
    source: "adam",
    displayName: displayName(row.name, row.lastname),
    adam_id: id,
  };
}
