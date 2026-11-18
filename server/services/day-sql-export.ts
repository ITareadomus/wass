import { query } from "../../shared/pg-db";
import { findAdamWassEmployeeIdByEmail } from "./adam-wass-accounts";

/** Stato corrente della giornata. Lo storico delle revisioni non serve per riprodurla. */
const CURRENT_TABLES = [
  "cleaners",
  "daily_selected_cleaners",
  "daily_containers",
  "daily_assignments_current",
  "daily_task_locks",
  "daily_task_triade_override",
  "daily_cleaner_triade_override",
  "daily_operational_day",
  "task_collaborators",
  "hk_key_handovers",
  "lg_drivers",
  "lg_selected_drivers",
  "lg_containers",
  "lg_timeline",
] as const;

/** Vanno svuotate prima, se esistono: alcune puntano alle righe della giornata. */
const HISTORY_TABLES = [
  "cleaners_history",
  "selected_cleaners_revisions",
  "daily_assignments_revisions",
  "daily_assignments_history",
  "daily_containers_revisions",
  "daily_containers_history",
  "lg_selected_drivers_revision",
  "lg_timeline_revision",
  "lg_timeline_history",
  "lg_containers_revision",
  "lg_containers_history",
] as const;

type ColumnInfo = {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_identity: string;
  column_default: string | null;
};

const ARRAY_CAST: Record<string, string> = {
  _int2: "smallint[]",
  _int4: "integer[]",
  _int8: "bigint[]",
  _numeric: "numeric[]",
  _float4: "real[]",
  _float8: "double precision[]",
  _bool: "boolean[]",
  _text: "text[]",
  _varchar: "varchar[]",
  _bpchar: "char[]",
};

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function sqlCast(column: ColumnInfo): string | null {
  if (column.data_type === "ARRAY") return ARRAY_CAST[column.udt_name] ?? null;
  switch (column.data_type) {
    case "date":
      return "date";
    case "time without time zone":
      return "time";
    case "time with time zone":
      return "timetz";
    case "timestamp without time zone":
      return "timestamp";
    case "timestamp with time zone":
      return "timestamptz";
    case "boolean":
      return "boolean";
    case "smallint":
    case "integer":
    case "bigint":
    case "numeric":
    case "real":
    case "double precision":
    case "json":
    case "jsonb":
      return column.data_type;
    default:
      return null;
  }
}

function isSerial(column: ColumnInfo): boolean {
  if (column.column_name !== "id") return false;
  if (column.is_identity === "YES") return true;
  return String(column.column_default ?? "").includes("nextval(");
}

function literalExpr(column: ColumnInfo): string {
  const ref = `t.${quoteIdent(column.column_name)}`;
  const cast = sqlCast(column);
  const quoted = `quote_literal(${ref}::text)`;
  const value = cast ? `${quoted} || '::${cast}'` : quoted;
  return `CASE WHEN ${ref} IS NULL THEN 'NULL' ELSE ${value} END`;
}

async function existingTables(names: readonly string[]): Promise<Set<string>> {
  const result = await query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [names]
  );
  return new Set(result.rows.map((row) => String(row.table_name)));
}

async function tableColumns(table: string): Promise<ColumnInfo[]> {
  const result = await query(
    `SELECT column_name, data_type, udt_name, is_identity, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table]
  );
  return result.rows as ColumnInfo[];
}

async function literalRows(table: string, columns: ColumnInfo[], workDate: string): Promise<string[][]> {
  const selectList = columns.map((column) => `${literalExpr(column)} AS ${quoteIdent(column.column_name)}`).join(", ");
  const result = await query(
    `SELECT ${selectList} FROM public.${quoteIdent(table)} t WHERE t.work_date = $1::date ORDER BY t.ctid`,
    [workDate]
  );
  return result.rows.map((row) => columns.map((column) => String(row[column.column_name])));
}

function insertStatements(
  table: string,
  columns: ColumnInfo[],
  rows: string[][],
  conflict?: { key: string; skip: string[] }
): string[] {
  if (rows.length === 0) return [];
  const names = columns.map((column) => quoteIdent(column.column_name)).join(", ");
  const update = conflict
    ? ` ON CONFLICT (${quoteIdent(conflict.key)}) DO UPDATE SET ${columns
        .filter((column) => column.column_name !== conflict.key && !conflict.skip.includes(column.column_name))
        .map((column) => `${quoteIdent(column.column_name)} = EXCLUDED.${quoteIdent(column.column_name)}`)
        .join(", ")}`
    : "";
  const statements: string[] = [];
  const chunkSize = 100;
  for (let index = 0; index < rows.length; index += chunkSize) {
    const values = rows
      .slice(index, index + chunkSize)
      .map((row) => `  (${row.join(", ")})`)
      .join(",\n");
    statements.push(`INSERT INTO public.${quoteIdent(table)} (${names})\nVALUES\n${values}${update};`);
  }
  return statements;
}

function guardedDelete(table: string, workDate: string): string {
  const date = workDate.replace(/'/g, "''");
  return `DO $$
BEGIN
  IF to_regclass('public.${table}') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.${table} WHERE work_date = DATE ''${date}''';
  END IF;
END $$;`;
}

async function aliasCleanerIds(present: Set<string>, workDate: string): Promise<number[]> {
  const parts: string[] = [];
  if (present.has("cleaners")) {
    parts.push(`SELECT cleaner_id FROM public.cleaners WHERE work_date = $1::date`);
  }
  if (present.has("daily_selected_cleaners")) {
    parts.push(`SELECT unnest(cleaners) AS cleaner_id FROM public.daily_selected_cleaners WHERE work_date = $1::date`);
  }
  if (present.has("daily_assignments_current")) {
    parts.push(`SELECT cleaner_id FROM public.daily_assignments_current WHERE work_date = $1::date`);
  }
  if (present.has("daily_cleaner_triade_override")) {
    parts.push(`SELECT cleaner_id FROM public.daily_cleaner_triade_override WHERE work_date = $1::date`);
  }
  if (present.has("task_collaborators")) {
    parts.push(`SELECT cleaner_id FROM public.task_collaborators WHERE work_date = $1::date`);
  }
  if (present.has("lg_drivers")) {
    parts.push(`SELECT driver_id AS cleaner_id FROM public.lg_drivers WHERE work_date = $1::date`);
  }
  if (present.has("lg_selected_drivers")) {
    parts.push(`SELECT unnest(drivers) AS cleaner_id FROM public.lg_selected_drivers WHERE work_date = $1::date`);
  }
  if (present.has("lg_timeline")) {
    parts.push(`SELECT driver_id AS cleaner_id FROM public.lg_timeline WHERE work_date = $1::date`);
  }
  if (parts.length === 0 || !present.has("aliases")) return [];
  const result = await query(
    `SELECT DISTINCT cleaner_id
     FROM (${parts.join(" UNION ")}) ids
     WHERE cleaner_id IS NOT NULL
     ORDER BY cleaner_id`,
    [workDate]
  );
  return result.rows.map((row) => Number(row.cleaner_id)).filter((id) => Number.isInteger(id));
}

async function aliasStatements(ids: number[]): Promise<{ statements: string[]; rows: number }> {
  if (ids.length === 0) return { statements: [], rows: 0 };
  const columns = (await tableColumns("aliases")).filter((column) => !isSerial(column));
  if (!columns.some((column) => column.column_name === "cleaner_id")) return { statements: [], rows: 0 };
  const selectList = columns.map((column) => `${literalExpr(column)} AS ${quoteIdent(column.column_name)}`).join(", ");
  const result = await query(
    `SELECT ${selectList}
     FROM public.aliases t
     WHERE t.cleaner_id = ANY($1::int[])
     ORDER BY t.cleaner_id`,
    [ids]
  );
  const rows = result.rows.map((row) => columns.map((column) => String(row[column.column_name])));
  return {
    statements: insertStatements("aliases", columns, rows, { key: "cleaner_id", skip: ["created_at"] }),
    rows: rows.length,
  };
}

export async function isDayExportAdmin(username: string): Promise<boolean> {
  const name = username.trim();
  if (!name) return false;
  const { pgUsersService } = await import("./pg-users-service");
  const user = await pgUsersService.getUserByUsername(name);
  if (user && String(user.role).toLowerCase() === "admin") return true;
  if (!name.includes("@")) return false;
  try {
    const employeeId = await findAdamWassEmployeeIdByEmail(name);
    if (!employeeId) return false;
    const role = await query(`SELECT role FROM adam_wass_account_roles WHERE employee_id = $1`, [employeeId]);
    return String(role.rows[0]?.role ?? "").toLowerCase() === "admin";
  } catch (error) {
    console.warn("isDayExportAdmin: lookup account ADAM fallito", error);
    return false;
  }
}

export async function buildDayExportSql(workDate: string): Promise<string> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
    throw new Error("Data non valida");
  }
  const present = await existingTables([...CURRENT_TABLES, "aliases"]);
  const lines: string[] = [
    "BEGIN;",
    "",
  ];

  for (const table of HISTORY_TABLES) {
    lines.push(guardedDelete(table, workDate));
  }
  lines.push("");

  const exported: string[] = [];
  for (const table of CURRENT_TABLES) {
    if (!present.has(table)) continue;
    const columns = (await tableColumns(table)).filter((column) => !isSerial(column));
    if (!columns.some((column) => column.column_name === "work_date")) continue;
    const rows = await literalRows(table, columns, workDate);
    lines.push(`DELETE FROM public.${quoteIdent(table)} WHERE work_date = DATE '${workDate}';`);
    lines.push(...insertStatements(table, columns, rows));
    lines.push("");
    exported.push(`${table} (${rows.length})`);
  }

  const aliasIds = await aliasCleanerIds(present, workDate);
  const aliases = await aliasStatements(aliasIds);
  if (aliases.statements.length > 0) {
    lines.push("-- Alias dei cleaner e dei driver presenti in questa giornata.");
    lines.push(...aliases.statements);
    lines.push("");
    exported.push(`aliases (${aliases.rows})`);
  }

  lines.push("COMMIT;");
  lines.push("");
  return [
    `-- Giornata WASS ${workDate}`,
    `-- Sostituisce, nel database di sviluppo, lo stato corrente di questa giornata:`,
    `-- roster, timeline housekeeping e ufficio, contenitori, lock, triade, chiavi, logistica e alias usati.`,
    `-- Lo storico delle revisioni di quel giorno viene svuotato e non viene ricopiato.`,
    `-- Eseguire sul database di sviluppo.`,
    `-- Tabelle: ${exported.join(", ") || "nessuna"}.`,
    "",
    lines.join("\n"),
  ].join("\n");
}
