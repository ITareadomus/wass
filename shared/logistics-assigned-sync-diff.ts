import { formatHmTime } from "./logistics-task-windows";
import {
  logisticsTaskKindBadge,
  normalizeLogisticsTaskKind,
  type LogisticsTaskKind,
} from "./logistics-task-kind";

export type LogisticsAssignedFieldChange = {
  field: string;
  label: string;
  from: string;
  to: string;
};

export type LogisticsAssignedTaskChange = {
  taskId: number;
  logisticCode: string;
  removed: boolean;
  changes: LogisticsAssignedFieldChange[];
};

export type LogisticsAssignedSyncNotice = {
  syncedAt: string;
  tasks: LogisticsAssignedTaskChange[];
};

export const LOGISTICS_ASSIGNED_PROGRAM_FIELDS: ReadonlyArray<{ field: string; label: string }> = [
  { field: "logistic_code", label: "Codice" },
  { field: "client_id", label: "Cliente" },
  { field: "premium", label: "Premium" },
  { field: "address", label: "Indirizzo" },
  { field: "lat", label: "Latitudine" },
  { field: "lng", label: "Longitudine" },
  { field: "cleaning_time", label: "Durata pulizia" },
  { field: "checkin_date", label: "Data check-in" },
  { field: "checkout_date", label: "Data check-out" },
  { field: "checkin_time", label: "Ora check-in" },
  { field: "checkout_time", label: "Ora check-out" },
  { field: "pax_in", label: "Pax in" },
  { field: "pax_out", label: "Pax out" },
  { field: "small_equipment", label: "Attrezzatura" },
  { field: "operation_id", label: "Operazione" },
  { field: "confirmed_operation", label: "Operazione confermata" },
  { field: "straordinaria", label: "Straordinaria" },
  { field: "type_apt", label: "Tipo appartamento" },
  { field: "alias", label: "Alias" },
  { field: "customer_name", label: "Nome cliente" },
  { field: "customer_reference", label: "Riferimento cliente" },
  { field: "reasons", label: "Motivazioni" },
  { field: "base_cleaning_time", label: "Durata base" },
  { field: "priority", label: "Priorità" },
];

const BOOLEAN_FIELDS = new Set([
  "premium",
  "straordinaria",
  "confirmed_operation",
  "small_equipment",
]);

const TIME_FIELDS = new Set(["checkin_time", "checkout_time", "hk_start_time", "hk_end_time"]);
const COORD_FIELDS = new Set(["lat", "lng"]);

/** Stessa precisione di lg_timeline.lat/lng NUMERIC(9, 6). */
function roundedCoord6(value: unknown): string | null {
  if (value == null || value === "") return null;
  const parsed = Number(String(value).trim().replace(",", "."));
  if (!Number.isFinite(parsed)) return String(value);
  return (Math.round(parsed * 1e6) / 1e6).toFixed(6);
}

const NOTICE_HIDDEN_FIELDS = new Set([
  "cleaning_time",
  "base_cleaning_time",
  "small_equipment",
  "confirmed_operation",
  "type_apt",
  "reasons",
]);

const PRIORITY_LABELS: Record<string, string> = {
  early_out: "Early out",
  high_priority: "High priority",
  low_priority: "Low priority",
};

function logisticsBool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

export function sameLogisticsField(field: string, left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (BOOLEAN_FIELDS.has(field)) return logisticsBool(left) === logisticsBool(right);
  if (COORD_FIELDS.has(field)) return roundedCoord6(left) === roundedCoord6(right);
  if (TIME_FIELDS.has(field)) {
    const leftTime = formatHmTime(left);
    const rightTime = formatHmTime(right);
    if (leftTime || rightTime) return leftTime === rightTime;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  }
  return String(left ?? "") === String(right ?? "");
}

export function displayLogisticsFieldValue(field: string, value: unknown): string {
  if (value == null || value === "") return "—";
  if (BOOLEAN_FIELDS.has(field)) return logisticsBool(value) ? "Sì" : "No";
  if (field === "priority") {
    const key = String(value);
    return PRIORITY_LABELS[key] ?? key;
  }
  if (field === "logistics_task_kind") {
    const kind = normalizeLogisticsTaskKind(value, "manual");
    return kind ? logisticsTaskKindBadge(kind).text : "—";
  }
  if (TIME_FIELDS.has(field)) return formatHmTime(value) ?? String(value);
  if (Array.isArray(value)) {
    const joined = value.map((item) => String(item)).filter(Boolean).join(", ");
    return joined || "—";
  }
  return String(value);
}

export function diffLogisticsProgramFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): LogisticsAssignedFieldChange[] {
  const changes: LogisticsAssignedFieldChange[] = [];
  for (const { field, label } of LOGISTICS_ASSIGNED_PROGRAM_FIELDS) {
    if (NOTICE_HIDDEN_FIELDS.has(field)) continue;
    if (sameLogisticsField(field, before[field], after[field])) continue;
    changes.push({
      field,
      label,
      from: displayLogisticsFieldValue(field, before[field]),
      to: displayLogisticsFieldValue(field, after[field]),
    });
  }
  return changes;
}

export function logisticsCleanerDisplayLabel(parts: {
  alias?: string | null;
  name?: string | null;
  lastname?: string | null;
  cleanerId?: number | null;
}): string {
  const alias = String(parts.alias ?? "").trim();
  if (alias) return alias;
  const name = `${parts.name ?? ""} ${parts.lastname ?? ""}`.replace(/\s+/g, " ").trim();
  if (name) return name;
  const cleanerId = Number(parts.cleanerId);
  if (Number.isFinite(cleanerId) && cleanerId > 0) return `Cleaner ${cleanerId}`;
  return "";
}

export function diffAssignedLogisticsContext(input: {
  observed: boolean;
  manualKind: boolean;
  hadStoredKind: boolean;
  beforeKind: LogisticsTaskKind | null;
  afterKind: LogisticsTaskKind | null;
  beforeCleanerLabel: string;
  afterCleanerLabel: string;
  beforeSequence: number | null;
  afterSequence: number | null;
  beforeHkStart: string | null;
  afterHkStart: string | null;
  beforeHkEnd: string | null;
  afterHkEnd: string | null;
}): LogisticsAssignedFieldChange[] {
  const changes: LogisticsAssignedFieldChange[] = [];

  if (!input.manualKind && (input.observed || input.hadStoredKind) && input.beforeKind !== input.afterKind) {
    changes.push({
      field: "logistics_task_kind",
      label: "Operazione logistica",
      from: displayLogisticsFieldValue("logistics_task_kind", input.beforeKind),
      to: displayLogisticsFieldValue("logistics_task_kind", input.afterKind),
    });
  }

  const beforeCleaner = input.beforeCleanerLabel.trim();
  const afterCleaner = input.afterCleanerLabel.trim();
  if ((input.observed || beforeCleaner !== "") && beforeCleaner !== afterCleaner) {
    changes.push({
      field: "cleaner",
      label: "Cleaner",
      from: beforeCleaner || "—",
      to: afterCleaner || "—",
    });
  }

  if ((input.observed || input.beforeSequence != null) && input.beforeSequence !== input.afterSequence) {
    changes.push({
      field: "cleaner_sequence",
      label: "Sequenza cleaner",
      from: input.beforeSequence != null ? String(input.beforeSequence) : "—",
      to: input.afterSequence != null ? String(input.afterSequence) : "—",
    });
  }

  const canReportWindow = input.observed || input.beforeHkStart != null || input.beforeHkEnd != null;
  if (canReportWindow && input.beforeHkStart !== input.afterHkStart) {
    changes.push({
      field: "hk_start_time",
      label: "Inizio housekeeping",
      from: input.beforeHkStart || "—",
      to: input.afterHkStart || "—",
    });
  }
  if (canReportWindow && input.beforeHkEnd !== input.afterHkEnd) {
    changes.push({
      field: "hk_end_time",
      label: "Fine housekeeping",
      from: input.beforeHkEnd || "—",
      to: input.afterHkEnd || "—",
    });
  }

  return changes;
}
