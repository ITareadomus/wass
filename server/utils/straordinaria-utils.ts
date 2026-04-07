export const CONTINUAZIONE_PS_OPERATION_ID = 37;
const CONTINUAZIONE_PS_OPERATION_NAME = "continuazione ps";

function normalizeOperationName(value: unknown): string {
  return String(value ?? "").toLowerCase().trim();
}

export function isContinuazionePsTask(task: any): boolean {
  if (!task || typeof task !== "object") return false;

  const rawOperationId =
    task.operationId ??
    task.operation_id;
  const operationId = rawOperationId != null ? Number(rawOperationId) : NaN;
  if (!Number.isFinite(operationId) || operationId !== CONTINUAZIONE_PS_OPERATION_ID) {
    return false;
  }

  const rawOperationName =
    task.operationName ??
    task.operation_name ??
    task.operation_label;
  if (rawOperationName == null || rawOperationName === "") {
    return true;
  }

  return normalizeOperationName(rawOperationName) === CONTINUAZIONE_PS_OPERATION_NAME;
}

export function isTaskEquivalentToStraordinaria(task: any): boolean {
  return Boolean(task?.straordinaria) || isContinuazionePsTask(task);
}
