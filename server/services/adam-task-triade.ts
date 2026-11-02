import * as mysql from "mysql2/promise";
import { databaseConfig } from "../../config/database";
import type { CleanerTriadeLevel } from "./adam-triade";

export type TaskTriadeInput = {
  id: number;
  operation_id?: number | null;
  client_id?: number | null;
};

export type TaskTriadeResult = {
  id: number;
  operation_id: number | null;
  triade: CleanerTriadeLevel | null;
  customer_triade: CleanerTriadeLevel | null;
};

const HEX = /^#[0-9A-Fa-f]{6}$/;

type LevelRow = CleanerTriadeLevel;

function readHex(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return HEX.test(text) ? text.toUpperCase() : null;
}

function readLevel(row: Record<string, unknown>): LevelRow | null {
  const levelId = Number(row.id ?? row.level_id);
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

function asId(value: unknown): number | null {
  if (value == null || value === "") return null;
  const id = Number(value);
  return Number.isFinite(id) ? id : null;
}

/** Stessa convenzione di create_containers: operation 0 è la standard (id 2). */
function resolveOperationId(requested: number | null, housekeeping: number | null): number | null {
  const raw = requested != null ? requested : housekeeping;
  if (raw == null || !Number.isFinite(raw) || raw < 0) return null;
  return raw === 0 ? 2 : raw;
}

function higherLevel(left: LevelRow | null, right: LevelRow | null): LevelRow | null {
  if (!left) return right;
  if (!right) return left;
  return right.weight > left.weight ? right : left;
}

async function queryRows(
  connection: mysql.Connection,
  sql: string,
  ids: number[]
): Promise<Record<string, unknown>[]> {
  if (ids.length === 0) return [];
  const unique = [...new Set(ids)];
  const rows: Record<string, unknown>[] = [];
  const chunkSize = 300;
  for (let offset = 0; offset < unique.length; offset += chunkSize) {
    const chunk = unique.slice(offset, offset + chunkSize);
    const placeholders = chunk.map(() => "?").join(",");
    const [result] = await connection.execute(sql.replace("/*IDS*/", placeholders), chunk);
    for (const row of Array.isArray(result) ? result : []) {
      rows.push(row as Record<string, unknown>);
    }
  }
  return rows;
}

/**
 * Livello del task = peso massimo tra:
 * - livello struttura, oppure livello cliente se la struttura non ne ha uno attivo
 * - livello intervento, solo se l'operation ha enable_triade = 1
 * null se nessuno dei due lati è determinabile.
 */
export async function resolveTaskTriade(inputs: TaskTriadeInput[]): Promise<TaskTriadeResult[]> {
  const tasks = inputs
    .map((input) => ({
      id: Number(input.id),
      operation_id: asId(input.operation_id),
      client_id: asId(input.client_id),
    }))
    .filter((input) => Number.isFinite(input.id) && input.id > 0);

  const empty = tasks.map((input) => ({
    id: input.id,
    operation_id: input.operation_id,
    triade: null as CleanerTriadeLevel | null,
    customer_triade: null as CleanerTriadeLevel | null,
  }));
  if (tasks.length === 0 || !databaseConfig.isMysqlConfigured()) return empty;

  let connection: mysql.Connection | null = null;
  try {
    connection = await mysql.createConnection({
      host: databaseConfig.mysql.host,
      port: databaseConfig.mysql.port,
      user: databaseConfig.mysql.user,
      password: databaseConfig.mysql.password,
      database: databaseConfig.mysql.database,
    });

    const [catalogRows] = await connection.execute(
      `SELECT id, name, weight, color, color_bg
       FROM app_triade_levels
       WHERE active = 1`
    );
    const catalog = new Map<number, LevelRow>();
    for (const row of Array.isArray(catalogRows) ? catalogRows : []) {
      const level = readLevel(row as Record<string, unknown>);
      if (level) catalog.set(level.level_id, level);
    }

    const housekeepingRows = await queryRows(
      connection,
      `SELECT h.id AS task_id,
              s.triade_level_id AS structure_level_id,
              c.triade_level_id AS customer_level_id,
              h.operation_id AS hk_operation_id
       FROM app_housekeeping h
       INNER JOIN app_structures s ON s.id = h.structure_id
       LEFT JOIN app_customers c ON c.id = s.customer_id
       WHERE h.id IN (/*IDS*/)`,
      tasks.map((task) => task.id)
    );
    const housekeeping = new Map<
      number,
      { structure_level_id: number | null; customer_level_id: number | null; hk_operation_id: number | null }
    >();
    for (const row of housekeepingRows) {
      const taskId = Number(row.task_id);
      if (!Number.isFinite(taskId)) continue;
      housekeeping.set(taskId, {
        structure_level_id: asId(row.structure_level_id),
        customer_level_id: asId(row.customer_level_id),
        hk_operation_id: asId(row.hk_operation_id),
      });
    }

    const operationIds: number[] = [];
    const fallbackCustomerIds: number[] = [];
    for (const task of tasks) {
      const hk = housekeeping.get(task.id);
      const operationId = resolveOperationId(task.operation_id, hk?.hk_operation_id ?? null);
      if (operationId != null) operationIds.push(operationId);
      if (!hk && task.client_id != null) fallbackCustomerIds.push(task.client_id);
    }

    const operationRows = await queryRows(
      connection,
      `SELECT id, enable_triade, triade_level_id
       FROM app_structure_operation
       WHERE id IN (/*IDS*/)`,
      operationIds
    );
    const operations = new Map<number, { enable_triade: number; triade_level_id: number | null }>();
    for (const row of operationRows) {
      const id = Number(row.id);
      if (!Number.isFinite(id)) continue;
      operations.set(id, {
        enable_triade: Number(row.enable_triade) || 0,
        triade_level_id: asId(row.triade_level_id),
      });
    }

    const customerRows = await queryRows(
      connection,
      `SELECT id, triade_level_id FROM app_customers WHERE id IN (/*IDS*/)`,
      fallbackCustomerIds
    );
    const customers = new Map<number, number | null>();
    for (const row of customerRows) {
      const id = Number(row.id);
      if (!Number.isFinite(id)) continue;
      customers.set(id, asId(row.triade_level_id));
    }

    const active = (levelId: number | null | undefined) =>
      levelId == null ? null : catalog.get(levelId) ?? null;

    return tasks.map((task) => {
      const hk = housekeeping.get(task.id);
      const location = hk
        ? active(hk.structure_level_id) ?? active(hk.customer_level_id)
        : active(task.client_id != null ? customers.get(task.client_id) ?? null : null);
      const operationId = resolveOperationId(task.operation_id, hk?.hk_operation_id ?? null);
      const operation = operationId == null ? null : operations.get(operationId);
      const intervention =
        operation && operation.enable_triade === 1 ? active(operation.triade_level_id) : null;
      const customerTriade = hk
        ? active(hk.customer_level_id)
        : active(task.client_id != null ? customers.get(task.client_id) ?? null : null);
      return {
        id: task.id,
        operation_id: task.operation_id,
        triade: higherLevel(location, intervention),
        customer_triade: customerTriade,
      };
    });
  } catch (error: any) {
    console.warn("⚠️ resolveTaskTriade:", error?.message || error);
    return empty;
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
