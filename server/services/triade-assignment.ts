import { loadCleanerTriadeByIds } from "./adam-triade";
import { resolveTaskTriade } from "./adam-task-triade";
import { listDayTriadeOverrides } from "./pg-task-triade-override";
import { listDayCleanerTriadeOverrides } from "./pg-cleaner-triade-override";

/** Senza livello il task vale 1. Un cleaner senza livello vale 1 e prende solo quelli. */
export const TRIADE_BASE_WEIGHT = 1;

export function triadeWeightOrBase(value: unknown): number {
  const weight = Number(value);
  if (!Number.isInteger(weight) || weight < 1) return TRIADE_BASE_WEIGHT;
  return Math.min(3, weight);
}

/** Vincolo duro: il cleaner può prendere solo task del suo livello o più bassi. */
export function cleanerCanTakeTriadeTask(cleanerWeight: unknown, taskWeight: unknown): boolean {
  return triadeWeightOrBase(cleanerWeight) >= triadeWeightOrBase(taskWeight);
}

export async function loadTriadeAssignmentWeights(
  workDate: string,
  tasks: Array<{ taskId: number; clientId?: number | null; operationId?: number | null }>,
  cleanerIds: number[]
): Promise<{ taskWeight: Map<number, number>; cleanerWeight: Map<number, number> }> {
  const taskIds = [...new Set(tasks.map((task) => Number(task.taskId)).filter((id) => Number.isFinite(id) && id > 0))];
  const ids = [...new Set(cleanerIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  const [resolved, overrides, cleanerOverrides, cleaners] = await Promise.all([
    resolveTaskTriade(
      tasks
        .filter((task) => Number.isFinite(Number(task.taskId)) && Number(task.taskId) > 0)
        .map((task) => ({
          id: Number(task.taskId),
          operation_id: task.operationId ?? null,
          client_id: task.clientId ?? null,
        }))
    ),
    listDayTriadeOverrides(workDate).catch(() => []),
    listDayCleanerTriadeOverrides(workDate).catch(() => []),
    loadCleanerTriadeByIds(ids),
  ]);

  const overrideByTask = new Map(overrides.map((row) => [row.task_id, row.weight]));
  const taskWeight = new Map<number, number>();
  for (const id of taskIds) taskWeight.set(id, TRIADE_BASE_WEIGHT);
  for (const row of resolved) {
    const override = overrideByTask.get(row.id);
    taskWeight.set(row.id, triadeWeightOrBase(override ?? row.triade?.weight ?? TRIADE_BASE_WEIGHT));
  }
  for (const [taskId, weight] of overrideByTask) {
    if (taskWeight.has(taskId)) taskWeight.set(taskId, triadeWeightOrBase(weight));
  }

  const overrideByCleaner = new Map(cleanerOverrides.map((row) => [row.cleaner_id, row.weight]));
  const cleanerWeight = new Map<number, number>();
  for (const id of ids) {
    const override = overrideByCleaner.get(id);
    cleanerWeight.set(id, triadeWeightOrBase(override ?? cleaners.get(id)?.weight ?? TRIADE_BASE_WEIGHT));
  }
  return { taskWeight, cleanerWeight };
}

export async function triadeAssignmentBlock(
  workDate: string,
  cleanerId: number,
  taskId: number
): Promise<{ blocked: boolean; cleanerWeight: number; taskWeight: number }> {
  const weights = await loadTriadeAssignmentWeights(
    workDate,
    [{ taskId }],
    [cleanerId]
  );
  const cleanerWeight = weights.cleanerWeight.get(cleanerId) ?? TRIADE_BASE_WEIGHT;
  const taskWeight = weights.taskWeight.get(taskId) ?? TRIADE_BASE_WEIGHT;
  return {
    blocked: !cleanerCanTakeTriadeTask(cleanerWeight, taskWeight),
    cleanerWeight,
    taskWeight,
  };
}
