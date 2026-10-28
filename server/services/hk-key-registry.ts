import mysql from "mysql2/promise";
import { databaseConfig } from "../../config/database";
import { query } from "../../shared/pg-db";
import {
  buildKeyRegistry,
  calendarDateInRome,
  daysSinceWorkDate,
  hasClassicKey,
  isLostKeyVisible,
  keyHandoverStatus,
  logisticCodeKeys,
  type KeyHandoverStatus,
  type KeyPriorAlert,
  type KeyRegistryApartment,
  type KeyRegistryCleaner,
  type KeyRegistryCleanerInput,
  type KeyRegistryTaskInput,
} from "../../shared/key-registry";
import {
  loadStructureAccessBundlesByLogisticCodes,
  toDialogAccessBundles,
} from "./adam-structure-keys";
import type { StructureAccessBundle } from "../../shared/structure-access-keys";
import { loadTimeline } from "./workspace-files";

export type KeyRegistryPayload = {
  date: string;
  totals: { keys: number; warehouse: number; withCleaner: number; returned: number };
  cleaners: KeyRegistryCleaner[];
};

export type LostKeyRow = {
  workDate: string;
  taskId: number;
  logisticCode: string;
  cleanerId: number | null;
  cleanerName: string;
  matricola: string | null;
  aptCode: string | null;
  customerName: string | null;
  daysMissing: number;
};

export type LostKeysPayload = {
  today: string;
  keys: LostKeyRow[];
};

let tableReady = false;

export async function ensureHkKeyHandoverTable(): Promise<void> {
  if (tableReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS hk_key_handovers (
      work_date DATE NOT NULL,
      task_id INTEGER NOT NULL,
      cleaner_id INTEGER NOT NULL,
      logistic_code TEXT NOT NULL,
      delivered BOOLEAN NOT NULL DEFAULT FALSE,
      delivered_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (work_date, task_id)
    )
  `);
  await query(`ALTER TABLE hk_key_handovers ADD COLUMN IF NOT EXISTS lost BOOLEAN NOT NULL DEFAULT FALSE`);
  await query(`ALTER TABLE hk_key_handovers ADD COLUMN IF NOT EXISTS lost_at TIMESTAMPTZ`);
  await query(`ALTER TABLE hk_key_handovers ADD COLUMN IF NOT EXISTS cleaner_name TEXT`);
  await query(`ALTER TABLE hk_key_handovers ADD COLUMN IF NOT EXISTS matricola TEXT`);
  await query(`ALTER TABLE hk_key_handovers ADD COLUMN IF NOT EXISTS apt_code TEXT`);
  await query(`ALTER TABLE hk_key_handovers ADD COLUMN IF NOT EXISTS customer_name TEXT`);
  await query(`ALTER TABLE hk_key_handovers ADD COLUMN IF NOT EXISTS returned BOOLEAN NOT NULL DEFAULT FALSE`);
  await query(`ALTER TABLE hk_key_handovers ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ`);
  await query(`ALTER TABLE hk_key_handovers ADD COLUMN IF NOT EXISTS driver_key BOOLEAN NOT NULL DEFAULT FALSE`);
  await query(`ALTER TABLE hk_key_handovers ADD COLUMN IF NOT EXISTS driver_key_at TIMESTAMPTZ`);
  tableReady = true;
  console.log("✅ PG: Tabella hk_key_handovers verificata");
}

function asText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function operationIdOf(task: any): number | null {
  const id = Number(task?.operation_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function isConfirmedOperation(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function asClock(value: unknown): string | null {
  const text = asText(value);
  if (!text) return null;
  const match = text.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return text;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function readTimelineInputs(timeline: any): {
  cleaners: KeyRegistryCleanerInput[];
  tasks: KeyRegistryTaskInput[];
} {
  const cleaners: KeyRegistryCleanerInput[] = [];
  const tasks: KeyRegistryTaskInput[] = [];
  const seenCleaners = new Set<number>();

  for (const entry of timeline?.cleaners_assignments ?? []) {
    const cleanerId = Number(entry?.cleaner?.id);
    if (!Number.isInteger(cleanerId) || cleanerId <= 0) continue;
    if (!seenCleaners.has(cleanerId)) {
      seenCleaners.add(cleanerId);
      cleaners.push({
        id: cleanerId,
        name: asText(entry.cleaner?.name) ?? "",
        lastname: asText(entry.cleaner?.lastname) ?? "",
      });
    }

    for (const task of entry?.tasks ?? []) {
      const taskId = Number(task?.task_id);
      const logisticCode = asText(task?.logistic_code);
      if (!Number.isInteger(taskId) || taskId <= 0 || !logisticCode) continue;
      const isPrimary =
        task?.is_primary === true ? true : task?.is_primary === false ? false : null;
      const sequence = Number(task?.sequence);
      tasks.push({
        taskId,
        logisticCode,
        cleanerId,
        sequence: Number.isFinite(sequence) ? sequence : 0,
        startTime: asClock(task?.start_time),
        address: asText(task?.address),
        aptCode: asText(task?.apt_code),
        customerName: asText(task?.customer_name),
        interventionType: null,
        isPrimary,
        operationId: operationIdOf(task),
        confirmedOperation: isConfirmedOperation(task?.confirmed_operation),
      });
    }
  }

  return { cleaners, tasks };
}

async function loadMatricole(cleanerIds: number[]): Promise<Map<number, string>> {
  const ids = [...new Set(cleanerIds.filter((id) => Number.isInteger(id) && id > 0))];
  const out = new Map<number, string>();
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
      `SELECT id, logistic_number FROM app_users WHERE id IN (${placeholders})`,
      ids
    );
    for (const row of Array.isArray(rows) ? rows : []) {
      const record = row as { id?: unknown; logistic_number?: unknown };
      const id = Number(record.id);
      const matricola = asText(record.logistic_number);
      if (Number.isInteger(id) && matricola) out.set(id, matricola);
    }
  } catch (error: any) {
    console.warn("⚠️ Registro chiavi: matricole non caricate:", error?.message || error);
  } finally {
    await connection?.end();
  }
  return out;
}

async function loadHandoverFlags(workDate: string): Promise<{
  deliveredTaskIds: Set<number>;
  returnedTaskIds: Set<number>;
  lostTaskIds: Set<number>;
  driverTaskIds: Set<number>;
}> {
  const result = await query(
    `SELECT task_id, delivered, returned, lost, driver_key FROM hk_key_handovers WHERE work_date = $1`,
    [workDate]
  );
  const deliveredTaskIds = new Set<number>();
  const returnedTaskIds = new Set<number>();
  const lostTaskIds = new Set<number>();
  const driverTaskIds = new Set<number>();
  for (const row of result.rows) {
    const taskId = Number(row.task_id);
    if (!Number.isInteger(taskId)) continue;
    if (row.delivered === true) deliveredTaskIds.add(taskId);
    if (row.returned === true) returnedTaskIds.add(taskId);
    if (row.lost === true) lostTaskIds.add(taskId);
    if (row.driver_key === true) driverTaskIds.add(taskId);
  }
  return { deliveredTaskIds, returnedTaskIds, lostTaskIds, driverTaskIds };
}

async function loadOperationNames(operationIds: number[]): Promise<Map<number, string>> {
  const ids = [...new Set(operationIds.filter((id) => Number.isInteger(id) && id > 0))];
  const out = new Map<number, string>();
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
      `SELECT o.id, l.name
       FROM app_structure_operation o
       LEFT JOIN app_structure_operation_langs l
         ON l.structure_operation_id = o.id AND l.id_lang = 1
       WHERE o.id IN (${placeholders})`,
      ids
    );
    for (const row of Array.isArray(rows) ? rows : []) {
      const record = row as { id?: unknown; name?: unknown };
      const id = Number(record.id);
      const name = asText(record.name);
      if (Number.isInteger(id) && name) out.set(id, name);
    }
  } catch (error: any) {
    console.warn("⚠️ Registro chiavi: tipologie intervento non caricate:", error?.message || error);
  } finally {
    await connection?.end();
  }
  return out;
}

function bundlesForCode(
  logisticCode: string,
  byCode: Map<string, StructureAccessBundle[]>
): StructureAccessBundle[] {
  for (const key of logisticCodeKeys(logisticCode)) {
    const bundles = byCode.get(key);
    if (bundles?.length) return bundles;
  }
  return [];
}

async function accessFor(logisticCodes: string[]): Promise<{
  classicCodes: Set<string>;
  dialogBundles: Map<string, StructureAccessBundle[]>;
}> {
  const byCode = await loadStructureAccessBundlesByLogisticCodes(logisticCodes);
  const classicCodes = new Set<string>();
  const dialogBundles = new Map<string, StructureAccessBundle[]>();
  for (const [code, bundles] of byCode) {
    if (hasClassicKey(bundles)) {
      for (const key of logisticCodeKeys(code)) classicCodes.add(key);
    }
    const dialog = toDialogAccessBundles(bundles);
    if (dialog.length === 0) continue;
    for (const key of logisticCodeKeys(code)) dialogBundles.set(key, dialog);
  }
  return { classicCodes, dialogBundles };
}

export async function loadKeyRegistry(workDate: string): Promise<KeyRegistryPayload> {
  await ensureHkKeyHandoverTable();
  const timeline = await loadTimeline(workDate, "housekeeping");
  const { cleaners, tasks } = readTimelineInputs(timeline);
  const operationIds = tasks
    .filter((task) => task.confirmedOperation && task.operationId)
    .map((task) => task.operationId as number);
  const [access, handover, matricole, operationNames] = await Promise.all([
    accessFor(tasks.map((task) => task.logisticCode)),
    loadHandoverFlags(workDate),
    loadMatricole(cleaners.map((cleaner) => cleaner.id)),
    loadOperationNames(operationIds),
  ]);
  const { classicCodes, dialogBundles } = access;

  for (const task of tasks) {
    const operationId = task.operationId;
    task.interventionType =
      task.confirmedOperation && operationId ? operationNames.get(operationId) ?? null : null;
    task.keyBundles = bundlesForCode(task.logisticCode, dialogBundles);
  }

  for (const cleaner of cleaners) {
    cleaner.matricola = matricole.get(cleaner.id) ?? null;
  }

  const rows = buildKeyRegistry({
    cleaners,
    tasks,
    classicCodes,
    deliveredTaskIds: handover.deliveredTaskIds,
    returnedTaskIds: handover.returnedTaskIds,
    lostTaskIds: handover.lostTaskIds,
    driverTaskIds: handover.driverTaskIds,
  });
  const priorAlerts = await loadPriorAlerts(
    workDate,
    rows.flatMap((cleaner) => cleaner.apartments.map((apartment) => apartment.logisticCode))
  );
  attachPriorAlerts(rows, priorAlerts);
  const apartments = rows.flatMap((cleaner) => cleaner.apartments);
  const totals = {
    keys: apartments.length,
    warehouse: apartments.filter((apartment) => keyHandoverStatus(apartment) === "warehouse").length,
    withCleaner: apartments.filter((apartment) => keyHandoverStatus(apartment) === "with_cleaner").length,
    returned: apartments.filter((apartment) => keyHandoverStatus(apartment) === "returned").length,
  };

  return { date: workDate, totals, cleaners: rows };
}

async function loadPriorAlerts(workDate: string, logisticCodes: string[]): Promise<Map<string, KeyPriorAlert[]>> {
  const codes = [...new Set(logisticCodes.flatMap((code) => logisticCodeKeys(code)))];
  const byCode = new Map<string, KeyPriorAlert[]>();
  if (codes.length === 0) return byCode;
  const result = await query(
    `
      SELECT to_char(work_date, 'YYYY-MM-DD') AS work_date, logistic_code, cleaner_name, matricola, apt_code, customer_name, lost
      FROM hk_key_handovers
      WHERE work_date < $1::date
        AND logistic_code = ANY($2::text[])
        AND (lost = TRUE OR (delivered = TRUE AND returned = FALSE AND lost = FALSE))
      ORDER BY work_date DESC, logistic_code ASC
    `,
    [workDate, codes]
  );
  for (const row of result.rows) {
    const logisticCode = String(row.logistic_code ?? "");
    const workDay = asWorkDate(row.work_date);
    if (!logisticCode || !workDay) continue;
    const alert: KeyPriorAlert = {
      kind: row.lost === true ? "lost" : "unreturned",
      workDate: workDay,
      logisticCode,
      cleanerName: asText(row.cleaner_name) ?? "",
      matricola: asText(row.matricola),
      aptCode: asText(row.apt_code),
      customerName: asText(row.customer_name),
    };
    for (const key of logisticCodeKeys(logisticCode)) {
      const list = byCode.get(key) ?? [];
      list.push(alert);
      byCode.set(key, list);
    }
  }
  return byCode;
}

function attachPriorAlerts(rows: KeyRegistryCleaner[], byCode: Map<string, KeyPriorAlert[]>): void {
  for (const cleaner of rows) {
    for (const apartment of cleaner.apartments) {
      const seen = new Set<string>();
      const alerts: KeyPriorAlert[] = [];
      for (const key of logisticCodeKeys(apartment.logisticCode)) {
        for (const alert of byCode.get(key) ?? []) {
          const id = `${alert.kind}|${alert.workDate}|${alert.logisticCode}`;
          if (seen.has(id)) continue;
          seen.add(id);
          alerts.push(alert);
        }
      }
      alerts.sort((a, b) => b.workDate.localeCompare(a.workDate) || a.kind.localeCompare(b.kind));
      apartment.priorAlerts = alerts;
    }
  }
}

function findRegistryApartment(
  registry: KeyRegistryPayload,
  taskId: number
): { cleaner: KeyRegistryCleaner; apartment: KeyRegistryApartment } | null {
  for (const cleaner of registry.cleaners) {
    const apartment = cleaner.apartments.find((item) => item.taskId === taskId);
    if (apartment) return { cleaner, apartment };
  }
  return null;
}

export async function setKeyLost(
  workDate: string,
  taskId: number
): Promise<{ taskId: number; lost: true }> {
  const registry = await loadKeyRegistry(workDate);
  const found = findRegistryApartment(registry, taskId);
  if (!found) {
    throw new Error("Appartamento non presente nel registro di questa giornata");
  }
  const cleanerName = [found.cleaner.name, found.cleaner.lastname].filter(Boolean).join(" ").trim();
  await query(
    `
      INSERT INTO hk_key_handovers (
        work_date, task_id, cleaner_id, logistic_code, delivered, lost, lost_at,
        cleaner_name, matricola, apt_code, customer_name, updated_at
      ) VALUES (
        $1, $2, $3, $4, FALSE, TRUE, NOW(), $5, $6, $7, $8, NOW()
      )
      ON CONFLICT (work_date, task_id) DO UPDATE SET
        cleaner_id = EXCLUDED.cleaner_id,
        logistic_code = EXCLUDED.logistic_code,
        lost = TRUE,
        lost_at = COALESCE(hk_key_handovers.lost_at, NOW()),
        returned = FALSE,
        returned_at = NULL,
        cleaner_name = EXCLUDED.cleaner_name,
        matricola = EXCLUDED.matricola,
        apt_code = EXCLUDED.apt_code,
        customer_name = EXCLUDED.customer_name,
        updated_at = NOW()
    `,
    [
      workDate,
      taskId,
      found.cleaner.cleanerId,
      found.apartment.logisticCode,
      cleanerName || null,
      found.cleaner.matricola,
      found.apartment.aptCode,
      found.apartment.customerName,
    ]
  );
  return { taskId, lost: true };
}

export async function setKeyDriver(
  workDate: string,
  taskId: number,
  taken: boolean
): Promise<{ taskId: number; driverKey: boolean }> {
  const registry = await loadKeyRegistry(workDate);
  const found = findRegistryApartment(registry, taskId);
  if (!found) {
    throw new Error("Appartamento non presente nel registro di questa giornata");
  }
  const cleanerName = [found.cleaner.name, found.cleaner.lastname].filter(Boolean).join(" ").trim();
  await query(
    `
      INSERT INTO hk_key_handovers (
        work_date, task_id, cleaner_id, logistic_code, delivered, delivered_at, returned, returned_at,
        driver_key, driver_key_at, cleaner_name, matricola, apt_code, customer_name, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, CASE WHEN $5 THEN NOW() ELSE NULL END, FALSE, NULL,
        $5, CASE WHEN $5 THEN NOW() ELSE NULL END, $6, $7, $8, $9, NOW()
      )
      ON CONFLICT (work_date, task_id) DO UPDATE SET
        cleaner_id = EXCLUDED.cleaner_id,
        logistic_code = EXCLUDED.logistic_code,
        driver_key = EXCLUDED.driver_key,
        driver_key_at = CASE
          WHEN EXCLUDED.driver_key THEN COALESCE(hk_key_handovers.driver_key_at, NOW())
          ELSE NULL
        END,
        delivered = CASE WHEN EXCLUDED.driver_key THEN TRUE ELSE hk_key_handovers.delivered END,
        delivered_at = CASE
          WHEN EXCLUDED.driver_key THEN COALESCE(hk_key_handovers.delivered_at, NOW())
          ELSE hk_key_handovers.delivered_at
        END,
        returned = CASE WHEN EXCLUDED.driver_key THEN FALSE ELSE hk_key_handovers.returned END,
        returned_at = CASE WHEN EXCLUDED.driver_key THEN NULL ELSE hk_key_handovers.returned_at END,
        cleaner_name = EXCLUDED.cleaner_name,
        matricola = EXCLUDED.matricola,
        apt_code = EXCLUDED.apt_code,
        customer_name = EXCLUDED.customer_name,
        updated_at = NOW()
    `,
    [
      workDate,
      taskId,
      found.cleaner.cleanerId,
      found.apartment.logisticCode,
      taken,
      cleanerName || null,
      found.cleaner.matricola,
      found.apartment.aptCode,
      found.apartment.customerName,
    ]
  );
  return { taskId, driverKey: taken };
}

export async function setKeyRecovered(
  workDate: string,
  taskId: number
): Promise<{ taskId: number; lost: false; delivered: true }> {
  await ensureHkKeyHandoverTable();
  const result = await query(
    `
      UPDATE hk_key_handovers
      SET lost = FALSE,
          lost_at = NULL,
          delivered = TRUE,
          delivered_at = COALESCE(delivered_at, NOW()),
          returned = TRUE,
          returned_at = COALESCE(returned_at, NOW()),
          updated_at = NOW()
      WHERE work_date = $1 AND task_id = $2 AND lost = TRUE
    `,
    [workDate, taskId]
  );
  if (!result.rowCount) {
    throw new Error("Chiave smarrita non presente");
  }
  return { taskId, lost: false, delivered: true };
}

function asWorkDate(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const text = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

export async function loadLostKeys(now = new Date()): Promise<LostKeysPayload> {
  return loadOutstandingKeys("lost", now);
}

export async function loadUnreturnedKeys(now = new Date()): Promise<LostKeysPayload> {
  return loadOutstandingKeys("unreturned", now);
}

async function loadOutstandingKeys(
  kind: "lost" | "unreturned",
  now = new Date()
): Promise<LostKeysPayload> {
  await ensureHkKeyHandoverTable();
  const today = calendarDateInRome(now);
  const filter =
    kind === "lost"
      ? "lost = TRUE"
      : "delivered = TRUE AND returned = FALSE AND lost = FALSE";
  const result = await query(
    `
      SELECT to_char(work_date, 'YYYY-MM-DD') AS work_date, task_id, cleaner_id, logistic_code, cleaner_name, matricola, apt_code, customer_name
      FROM hk_key_handovers
      WHERE ${filter}
        AND work_date < $1::date
      ORDER BY work_date ASC, cleaner_name ASC NULLS LAST, logistic_code ASC
    `,
    [today]
  );
  const keys: LostKeyRow[] = [];
  for (const row of result.rows) {
    const workDate = asWorkDate(row.work_date);
    if (!isLostKeyVisible(workDate, today)) continue;
    const cleanerId = Number(row.cleaner_id);
    keys.push({
      workDate,
      taskId: Number(row.task_id),
      logisticCode: String(row.logistic_code ?? ""),
      cleanerId: Number.isInteger(cleanerId) && cleanerId > 0 ? cleanerId : null,
      cleanerName: asText(row.cleaner_name) ?? "",
      matricola: asText(row.matricola),
      aptCode: asText(row.apt_code),
      customerName: asText(row.customer_name),
      daysMissing: daysSinceWorkDate(workDate, today),
    });
  }
  return { today, keys };
}

export async function setKeyDelivered(
  workDate: string,
  taskId: number,
  delivered: boolean
): Promise<{ taskId: number; delivered: boolean }> {
  const registry = await loadKeyRegistry(workDate);
  let cleanerId = 0;
  let logisticCode = "";
  for (const cleaner of registry.cleaners) {
    const apartment = cleaner.apartments.find((item) => item.taskId === taskId);
    if (!apartment) continue;
    cleanerId = cleaner.cleanerId;
    logisticCode = apartment.logisticCode;
    break;
  }
  if (!cleanerId || !logisticCode) {
    throw new Error("Appartamento non presente nel registro di questa giornata");
  }

  await query(
    `
      INSERT INTO hk_key_handovers (
        work_date, task_id, cleaner_id, logistic_code, delivered, delivered_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, CASE WHEN $5 THEN NOW() ELSE NULL END, NOW()
      )
      ON CONFLICT (work_date, task_id) DO UPDATE SET
        cleaner_id = EXCLUDED.cleaner_id,
        logistic_code = EXCLUDED.logistic_code,
        delivered = EXCLUDED.delivered,
        delivered_at = CASE
          WHEN EXCLUDED.delivered THEN COALESCE(hk_key_handovers.delivered_at, NOW())
          ELSE NULL
        END,
        updated_at = NOW()
    `,
    [workDate, taskId, cleanerId, logisticCode, delivered]
  );

  return { taskId, delivered };
}

const HANDOVER_FLAGS: Record<KeyHandoverStatus, { delivered: boolean; returned: boolean }> = {
  warehouse: { delivered: false, returned: false },
  with_cleaner: { delivered: true, returned: false },
  returned: { delivered: true, returned: true },
};

export async function setKeyHandover(
  workDate: string,
  taskId: number,
  status: KeyHandoverStatus
): Promise<{ taskId: number; status: KeyHandoverStatus }> {
  const registry = await loadKeyRegistry(workDate);
  const found = findRegistryApartment(registry, taskId);
  if (!found) {
    throw new Error("Appartamento non presente nel registro di questa giornata");
  }
  const flags = HANDOVER_FLAGS[status];
  const cleanerName = [found.cleaner.name, found.cleaner.lastname].filter(Boolean).join(" ").trim();
  await query(
    `
      INSERT INTO hk_key_handovers (
        work_date, task_id, cleaner_id, logistic_code, delivered, delivered_at,
        returned, returned_at, lost, lost_at,
        cleaner_name, matricola, apt_code, customer_name, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, CASE WHEN $5 THEN NOW() ELSE NULL END,
        $6, CASE WHEN $6 THEN NOW() ELSE NULL END, FALSE, NULL,
        $7, $8, $9, $10, NOW()
      )
      ON CONFLICT (work_date, task_id) DO UPDATE SET
        cleaner_id = EXCLUDED.cleaner_id,
        logistic_code = EXCLUDED.logistic_code,
        delivered = EXCLUDED.delivered,
        delivered_at = CASE
          WHEN EXCLUDED.delivered THEN COALESCE(hk_key_handovers.delivered_at, NOW())
          ELSE NULL
        END,
        returned = EXCLUDED.returned,
        returned_at = CASE
          WHEN EXCLUDED.returned THEN COALESCE(hk_key_handovers.returned_at, NOW())
          ELSE NULL
        END,
        lost = FALSE,
        lost_at = NULL,
        cleaner_name = EXCLUDED.cleaner_name,
        matricola = EXCLUDED.matricola,
        apt_code = EXCLUDED.apt_code,
        customer_name = EXCLUDED.customer_name,
        updated_at = NOW()
    `,
    [
      workDate,
      taskId,
      found.cleaner.cleanerId,
      found.apartment.logisticCode,
      flags.delivered,
      flags.returned,
      cleanerName || null,
      found.cleaner.matricola,
      found.apartment.aptCode,
      found.apartment.customerName,
    ]
  );
  return { taskId, status };
}
