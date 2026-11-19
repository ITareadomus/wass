/** Lettura del file prodotto da «Scarica la giornata». Non esegue SQL. */

export type SqlCell = string | null;

export interface SqlInsertTable {
  table: string;
  columns: string[];
  rows: SqlCell[][];
}

export interface ComparisonTask {
  taskId: string;
  cleanerId: number;
  sequence: number;
  startMin: number | null;
  endMin: number | null;
  cleaningMin: number;
  travelMin: number;
  lat: number | null;
  lng: number | null;
  address: string;
  label: string;
  logisticCode: string;
  aptCode: string;
  alias: string;
  typeApt: string;
  customerReference: string;
  customerName: string;
  premium: boolean;
  straordinaria: boolean;
  confirmed: boolean;
  checkoutTime: string | null;
  checkinTime: string | null;
  priority: string | null;
  operationId: number | null;
  collaboratorCount: number;
  assigned: boolean;
}

export interface ComparisonCleaner {
  id: number;
  name: string;
  role: string;
  startMin: number;
  endMin: number;
}

export interface DaySnapshot {
  workDate: string | null;
  cleaners: ComparisonCleaner[];
  tasks: ComparisonTask[];
  assignedCount: number;
  containerCount: number;
  source: "housekeeping" | "logistics";
}

const INSERT_WORD = "insert into";

export function parseSqlInserts(sql: string): SqlInsertTable[] {
  const merged = new Map<string, SqlInsertTable>();
  let i = 0;
  let inString = false;
  while (i < sql.length) {
    if (inString) {
      if (sql[i] === "'") {
        if (sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        inString = false;
      }
      i += 1;
      continue;
    }
    if (sql[i] === "'") {
      inString = true;
      i += 1;
      continue;
    }
    if (isInsertAt(sql, i)) {
      const read = readInsert(sql, i);
      const existing = merged.get(read.table.table);
      if (!existing) {
        merged.set(read.table.table, read.table);
      } else if (existing.columns.join(",") === read.table.columns.join(",")) {
        existing.rows.push(...read.table.rows);
      } else {
        existing.rows.push(
          ...read.table.rows.map((row) => existing.columns.map((column) => row[read.table.columns.indexOf(column)] ?? null)),
        );
      }
      i = read.next;
      continue;
    }
    i += 1;
  }
  return [...merged.values()];
}

function isInsertAt(sql: string, index: number): boolean {
  if (sql.slice(index, index + INSERT_WORD.length).toLowerCase() !== INSERT_WORD) return false;
  return index === 0 || /[\s;]/.test(sql[index - 1]);
}

function readInsert(sql: string, start: number): { table: SqlInsertTable; next: number } {
  let i = skipSpace(sql, start + INSERT_WORD.length);
  if (sql.slice(i, i + 7).toLowerCase() === "public.") i += 7;
  const tableName = readIdent(sql, i);
  i = skipSpace(sql, tableName.next);
  if (sql[i] !== "(") throw new Error(`INSERT senza colonne in ${tableName.name}`);
  const columns = readIdentList(sql, i + 1);
  i = skipSpace(sql, columns.next);
  if (sql.slice(i, i + 6).toLowerCase() !== "values") throw new Error(`INSERT senza VALUES in ${tableName.name}`);
  i = skipSpace(sql, i + 6);
  const rows: SqlCell[][] = [];
  while (i < sql.length) {
    if (sql[i] !== "(") break;
    const tuple = readTuple(sql, i);
    if (tuple.values.length !== columns.names.length) {
      throw new Error(`Riga di ${tableName.name} con ${tuple.values.length} valori su ${columns.names.length} colonne`);
    }
    rows.push(tuple.values);
    i = skipSpace(sql, tuple.next);
    if (sql[i] === ",") {
      i = skipSpace(sql, i + 1);
      continue;
    }
    break;
  }
  i = skipStatement(sql, i);
  return { table: { table: tableName.name, columns: columns.names, rows }, next: i };
}

function readIdent(sql: string, start: number): { name: string; next: number } {
  if (sql[start] === '"') {
    let i = start + 1;
    let name = "";
    while (i < sql.length) {
      if (sql[i] === '"') {
        if (sql[i + 1] === '"') {
          name += '"';
          i += 2;
          continue;
        }
        return { name, next: i + 1 };
      }
      name += sql[i];
      i += 1;
    }
    throw new Error("Identificatore senza chiusura");
  }
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(start));
  if (!match) throw new Error("Nome tabella mancante");
  return { name: match[0], next: start + match[0].length };
}

function readIdentList(sql: string, start: number): { names: string[]; next: number } {
  const names: string[] = [];
  let i = start;
  while (i < sql.length) {
    i = skipSpace(sql, i);
    if (sql[i] === ")") return { names, next: i + 1 };
    const ident = readIdent(sql, i);
    names.push(ident.name);
    i = skipSpace(sql, ident.next);
    if (sql[i] === ",") {
      i += 1;
      continue;
    }
    if (sql[i] === ")") return { names, next: i + 1 };
    throw new Error("Elenco colonne interrotto");
  }
  throw new Error("Elenco colonne senza chiusura");
}

function readTuple(sql: string, start: number): { values: SqlCell[]; next: number } {
  const values: SqlCell[] = [];
  let i = skipSpace(sql, start + 1);
  if (sql[i] === ")") return { values, next: i + 1 };
  while (i < sql.length) {
    const value = readValue(sql, i);
    values.push(value.value);
    i = skipSpace(sql, value.next);
    if (sql[i] === ",") {
      i = skipSpace(sql, i + 1);
      continue;
    }
    if (sql[i] === ")") return { values, next: i + 1 };
    throw new Error("Valore SQL non riconosciuto");
  }
  throw new Error("Riga SQL senza chiusura");
}

function readValue(sql: string, start: number): { value: SqlCell; next: number } {
  let i = skipSpace(sql, start);
  if (sql.slice(i, i + 4).toUpperCase() === "NULL" && (i + 4 >= sql.length || /[^A-Za-z0-9_]/.test(sql[i + 4]))) {
    return { value: null, next: skipCast(sql, i + 4) };
  }
  if (sql[i] !== "'") throw new Error("Valore SQL non riconosciuto");
  let text = "";
  i += 1;
  while (i < sql.length) {
    if (sql[i] === "'") {
      if (sql[i + 1] === "'") {
        text += "'";
        i += 2;
        continue;
      }
      i += 1;
      break;
    }
    text += sql[i];
    i += 1;
  }
  return { value: text, next: skipCast(sql, i) };
}

function skipCast(sql: string, start: number): number {
  const match = /^\s*::(?:\s*[A-Za-z_][A-Za-z0-9_]*|\[|\])+/.exec(sql.slice(start));
  return match ? start + match[0].length : start;
}

function skipSpace(sql: string, start: number): number {
  let i = start;
  while (i < sql.length && /\s/.test(sql[i])) i += 1;
  return i;
}

function skipStatement(sql: string, start: number): number {
  let i = start;
  let inString = false;
  while (i < sql.length) {
    if (inString) {
      if (sql[i] === "'") {
        if (sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        inString = false;
      }
      i += 1;
      continue;
    }
    if (sql[i] === "'") {
      inString = true;
      i += 1;
      continue;
    }
    if (sql[i] === ";") return i + 1;
    i += 1;
  }
  return i;
}

function tableRows(tables: SqlInsertTable[], name: string): Array<Record<string, SqlCell>> {
  const table = tables.find((item) => item.table === name);
  if (!table) return [];
  return table.rows.map((row) => {
    const record: Record<string, SqlCell> = {};
    table.columns.forEach((column, index) => {
      record[column] = row[index] ?? null;
    });
    return record;
  });
}

function cell(row: Record<string, SqlCell>, key: string): string | null {
  const value = row[key];
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function intCell(row: Record<string, SqlCell>, key: string): number | null {
  const text = cell(row, key);
  if (text == null) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function boolCell(row: Record<string, SqlCell>, key: string): boolean {
  const text = cell(row, key)?.toLowerCase();
  return text === "true" || text === "t" || text === "1";
}

export function clockToMinutes(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 36 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function clockLabel(value: string | null): string | null {
  const minutes = clockToMinutes(value);
  if (minutes == null) return null;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function intArray(value: string | null): number[] {
  if (!value) return [];
  const body = value.replace(/^\{/, "").replace(/\}$/, "");
  if (!body.trim()) return [];
  return body
    .split(",")
    .map((part) => Number(part.trim().replace(/^"|"$/g, "")))
    .filter((item) => Number.isInteger(item));
}

function workDateOf(sql: string, rows: Array<Record<string, SqlCell>>): string | null {
  const header = sql.match(/--\s*Giornata WASS\s+(\d{4}-\d{2}-\d{2})/);
  if (header) return header[1];
  for (const row of rows) {
    const date = cell(row, "work_date");
    if (date && /^\d{4}-\d{2}-\d{2}/.test(date)) return date.slice(0, 10);
  }
  return null;
}

function rowsForScope(
  rows: Array<Record<string, SqlCell>>,
  scope: "housekeeping" | "alg-test",
): Array<Record<string, SqlCell>> {
  const hasScope = rows.some((row) => cell(row, "scope") != null);
  if (!hasScope) return scope === "housekeeping" ? rows : [];
  return rows.filter((row) => (cell(row, "scope") ?? "housekeeping") === scope);
}

export function snapshotFromDaySql(
  sql: string,
  scope: "housekeeping" | "alg-test" = "housekeeping",
): DaySnapshot {
  const tables = parseSqlInserts(sql);
  const usesAlgTestTables = scope === "alg-test" && tables.some((table) =>
    table.table === "alg_test_assignments" ||
    table.table === "alg_test_containers" ||
    table.table === "alg_test_selected_cleaners"
  );
  const assignments = usesAlgTestTables
    ? tableRows(tables, "alg_test_assignments")
    : rowsForScope(tableRows(tables, "daily_assignments_current"), scope);
  const logistics = tableRows(tables, "lg_timeline");
  const useLogistics = scope === "housekeeping" && assignments.length === 0 && logistics.length > 0;
  const sourceRows = useLogistics ? logistics : assignments;
  const containers = usesAlgTestTables
    ? tableRows(tables, "alg_test_containers")
    : rowsForScope(tableRows(tables, useLogistics ? "lg_containers" : "daily_containers"), scope);
  const cleanerRows = tableRows(tables, "cleaners");
  const aliasRows = tableRows(tables, "aliases");
  const selected = usesAlgTestTables
    ? tableRows(tables, "alg_test_selected_cleaners")
    : rowsForScope(tableRows(tables, useLogistics ? "lg_selected_drivers" : "daily_selected_cleaners"), scope);

  const aliasById = new Map<number, string>();
  for (const row of aliasRows) {
    const id = intCell(row, "cleaner_id");
    const alias = cell(row, "alias");
    if (id != null && alias) aliasById.set(id, alias);
  }

  const cleanerById = new Map<number, ComparisonCleaner>();
  const rememberCleaner = (id: number, name: string, role: string, start: string | null, end: string | null) => {
    const current = cleanerById.get(id);
    const alias = aliasById.get(id);
    const nextName = alias || name || current?.name || `ID ${id}`;
    cleanerById.set(id, {
      id,
      name: nextName,
      role: role || current?.role || "",
      startMin: clockToMinutes(start) ?? current?.startMin ?? 10 * 60,
      endMin: clockToMinutes(end) ?? current?.endMin ?? 20 * 60,
    });
  };

  for (const row of cleanerRows) {
    const id = intCell(row, "cleaner_id");
    if (id == null) continue;
    const name = [cell(row, "name"), cell(row, "lastname")].filter(Boolean).join(" ");
    rememberCleaner(id, name, cell(row, "role") ?? "", cell(row, "start_time"), cell(row, "end_time"));
  }

  const idKey = useLogistics ? "driver_id" : "cleaner_id";
  const nameKey = useLogistics ? "driver_name" : "cleaner_name";
  const lastKey = useLogistics ? "driver_lastname" : "cleaner_lastname";
  const roleKey = useLogistics ? "driver_role" : "cleaner_role";
  const startKey = useLogistics ? "driver_start_time" : "cleaner_start_time";
  const endKey = useLogistics ? "driver_end_time" : "cleaner_end_time";

  for (const row of sourceRows) {
    const id = intCell(row, idKey);
    if (id == null) continue;
    const name = [cell(row, nameKey), cell(row, lastKey)].filter(Boolean).join(" ");
    rememberCleaner(id, name, cell(row, roleKey) ?? "", cell(row, startKey), cell(row, endKey));
  }

  const selectedIds = selected.flatMap((row) => intArray(cell(row, useLogistics ? "drivers" : "cleaners")));
  for (const id of selectedIds) {
    if (!cleanerById.has(id)) rememberCleaner(id, "", "", null, null);
  }

  const assignedIds = new Set<string>();
  const tasks: ComparisonTask[] = sourceRows.flatMap((row) => {
    const cleanerId = intCell(row, idKey);
    const taskId = cell(row, "task_id");
    if (cleanerId == null || taskId == null) return [];
    assignedIds.add(taskId);
    const alias = cell(row, "alias") ?? "";
    const logistic = cell(row, "logistic_code") ?? "";
    return [{
      taskId,
      cleanerId,
      sequence: intCell(row, "sequence") ?? 0,
      startMin: clockToMinutes(cell(row, "start_time")),
      endMin: clockToMinutes(cell(row, "end_time")),
      cleaningMin: intCell(row, "cleaning_time") ?? 0,
      travelMin: intCell(row, "travel_time") ?? 0,
      lat: intCell(row, "lat"),
      lng: intCell(row, "lng"),
      address: cell(row, "address") ?? "",
      label: alias || logistic || taskId,
      logisticCode: logistic || taskId,
      aptCode: cell(row, "apt_code") ?? "",
      alias,
      typeApt: cell(row, "type_apt") ?? "",
      customerReference: cell(row, "customer_reference") ?? "",
      customerName: cell(row, "customer_name") ?? "",
      premium: boolCell(row, "premium"),
      straordinaria: boolCell(row, "straordinaria"),
      confirmed: cell(row, "confirmed_operation") == null ? true : boolCell(row, "confirmed_operation"),
      checkoutTime: clockLabel(cell(row, "checkout_time")),
      checkinTime: clockLabel(cell(row, "checkin_time")),
      priority: cell(row, "priority"),
      operationId: intCell(row, "operation_id"),
      collaboratorCount: 1,
      assigned: true,
    }];
  });
  const collaborators = new Map<string, number>();
  for (const task of tasks) {
    if (!task.assigned) continue;
    collaborators.set(task.taskId, (collaborators.get(task.taskId) ?? 0) + 1);
  }
  for (const task of tasks) {
    task.collaboratorCount = collaborators.get(task.taskId) ?? 1;
  }

  for (const row of containers) {
    const taskId = cell(row, "task_id");
    if (taskId == null || assignedIds.has(taskId)) continue;
    if (boolCell(row, "locked")) continue;
    const alias = cell(row, "alias") ?? "";
    const logistic = cell(row, "logistic_code") ?? "";
    tasks.push({
      taskId,
      cleanerId: 0,
      sequence: 0,
      startMin: null,
      endMin: null,
      cleaningMin: intCell(row, "cleaning_time") ?? 0,
      travelMin: 0,
      lat: intCell(row, "lat"),
      lng: intCell(row, "lng"),
      address: cell(row, "address") ?? "",
      label: alias || logistic || taskId,
      logisticCode: logistic || taskId,
      aptCode: cell(row, "apt_code") ?? "",
      alias,
      typeApt: cell(row, "type_apt") ?? "",
      customerReference: cell(row, "customer_reference") ?? "",
      customerName: cell(row, "customer_name") ?? "",
      premium: boolCell(row, "premium"),
      straordinaria: boolCell(row, "straordinaria"),
      confirmed: true,
      checkoutTime: clockLabel(cell(row, "checkout_time")),
      checkinTime: clockLabel(cell(row, "checkin_time")),
      priority: cell(row, "priority"),
      operationId: intCell(row, "operation_id"),
      collaboratorCount: 1,
      assigned: false,
    });
  }

  const selectedSet = new Set(selectedIds);
  const assignedCleaners = new Set(tasks.filter((task) => task.assigned).map((task) => task.cleanerId));
  const cleaners = [...cleanerById.values()]
    .filter((cleaner) => selectedSet.size === 0 || selectedSet.has(cleaner.id) || assignedCleaners.has(cleaner.id))
    .sort((a, b) => a.name.localeCompare(b.name, "it") || a.id - b.id);
  if (tables.length === 0) {
    throw new Error("Il file non contiene gli INSERT della giornata");
  }
  return {
    workDate: workDateOf(sql, [...sourceRows, ...containers, ...cleanerRows]),
    cleaners,
    tasks,
    assignedCount: tasks.filter((task) => task.assigned).length,
    containerCount: containers.length,
    source: useLogistics ? "logistics" : "housekeeping",
  };
}

export function comparisonPxPerMinute(days: Array<DaySnapshot | null>): number {
  let shortest = 30;
  let seen = false;
  for (const day of days) {
    if (!day) continue;
    for (const task of day.tasks) {
      if (!task.assigned) continue;
      const span = task.cleaningMin > 0
        ? task.cleaningMin
        : task.startMin != null && task.endMin != null && task.endMin > task.startMin
          ? task.endMin - task.startMin
          : 0;
      if (span <= 0) continue;
      shortest = seen ? Math.min(shortest, span) : span;
      seen = true;
    }
  }
  return 75 / Math.max(15, shortest);
}

export function comparisonWindow(days: Array<DaySnapshot | null>): { startMin: number; endMin: number } {
  let start = 8 * 60;
  let end = 20 * 60;
  let seen = false;
  for (const day of days) {
    if (!day) continue;
    for (const cleaner of day.cleaners) {
      start = seen ? Math.min(start, cleaner.startMin) : cleaner.startMin;
      end = seen ? Math.max(end, cleaner.endMin) : cleaner.endMin;
      seen = true;
    }
    for (const task of day.tasks) {
      if (task.startMin != null) start = Math.min(start, task.startMin);
      if (task.endMin != null) end = Math.max(end, task.endMin);
    }
  }
  start = Math.floor(start / 60) * 60;
  end = Math.ceil(end / 60) * 60;
  if (end <= start) end = start + 60;
  return { startMin: start, endMin: end };
}
