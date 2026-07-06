import { isContinuazioneStraordinariaTask } from "@/lib/taskValidation";

/** Operazioni core gestite da WASS (housekeeping standard). */
export const CORE_WASS_OPERATION_IDS = new Set([1, 2, 3, 4, 37]);

export const CORE_WASS_OPERATION_NAMES = new Set([
  "fermata",
  "partenza",
  "pulizia straordinaria",
  "ripasso",
  "continuazione ps",
]);

const FALLBACK_OPERATION_NAMES: Record<number, string> = {
  1: "fermata",
  2: "partenza",
  3: "pulizia straordinaria",
  4: "ripasso",
  15: "pulizia uffici/altro",
  37: "continuazione ps",
  38: "pulizia uffici/altro straordinaria",
};

const OFFICE_OTHER_OPERATION_NAMES = new Set(["pulizia uffici/altro"]);

const OFFICE_STRAORDINARIA_OPERATION_NAMES = new Set([
  "pulizia uffici straordinaria",
  "pulizia uffici/altro straordinaria",
]);

export function normalizeOperationName(name: string | null | undefined): string {
  return (name || "").toLowerCase().trim();
}

export function getNormalizedOperationNameFromTask(
  task: any,
  operationNames: Record<number, string> = {}
): string {
  const explicit = normalizeOperationName(
    task?.operation_name ?? task?.operationName ?? task?.operation_label
  );
  if (explicit) return explicit;

  const opId = Number(task?.operation_id ?? task?.operationId);
  if (!Number.isFinite(opId)) return "";

  const fromMap = operationNames[opId];
  if (fromMap) return normalizeOperationName(fromMap);

  return normalizeOperationName(FALLBACK_OPERATION_NAMES[opId] ?? "");
}

export function isOfficeOtherOperation(
  task: any,
  operationNames?: Record<number, string>
): boolean {
  return OFFICE_OTHER_OPERATION_NAMES.has(
    getNormalizedOperationNameFromTask(task, operationNames)
  );
}

export function isOfficeStraordinariaOperation(
  task: any,
  operationNames?: Record<number, string>
): boolean {
  return OFFICE_STRAORDINARIA_OPERATION_NAMES.has(
    getNormalizedOperationNameFromTask(task, operationNames)
  );
}

export function isEquivalentStraordinariaTask(task: any): boolean {
  return (
    Boolean(task?.straordinaria) ||
    isContinuazioneStraordinariaTask(task) ||
    isOfficeStraordinariaOperation(task)
  );
}

/** Intervento esterno a WASS (logistica, pulizia uffici, lavaggio tessili, ecc.). */
export function isNonWassInterventionTask(
  task: any,
  operationNames?: Record<number, string>
): boolean {
  if (isEquivalentStraordinariaTask(task) || Boolean(task?.premium)) {
    return false;
  }

  const normalizedName = getNormalizedOperationNameFromTask(task, operationNames);
  const opId = Number(task?.operation_id ?? task?.operationId);
  const hasExternalOperationId =
    Number.isFinite(opId) && !CORE_WASS_OPERATION_IDS.has(opId);
  const hasExternalOperationName =
    normalizedName.length > 0 && !CORE_WASS_OPERATION_NAMES.has(normalizedName);

  if (isOfficeOtherOperation(task, operationNames)) return true;

  return hasExternalOperationId || hasExternalOperationName;
}

export type HousekeepingTypeTier = "straordinaria" | "premium" | "standard" | "altro";

export function getHousekeepingTypeTier(
  task: any,
  operationNames?: Record<number, string>
): HousekeepingTypeTier {
  if (isEquivalentStraordinariaTask(task)) return "straordinaria";
  if (Boolean(task?.premium)) return "premium";
  if (isNonWassInterventionTask(task, operationNames)) return "altro";
  return "standard";
}
