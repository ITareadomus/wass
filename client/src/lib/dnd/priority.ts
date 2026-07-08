import type { DndPriorityKey } from "./types";

export const LEGACY_PRIORITY_DROPPABLE_TO_KEY: Record<string, DndPriorityKey> = {
  "early-out": "early_out",
  high: "high_priority",
  low: "low_priority",
};

export const priorityKeyFromLegacyDroppableId = (
  droppableId: string,
): DndPriorityKey | null => {
  return LEGACY_PRIORITY_DROPPABLE_TO_KEY[droppableId] ?? null;
};

export const getTaskDndKey = (task: unknown) => {
  const candidate = task as {
    id?: string | number | null;
    task_id?: string | number | null;
    taskId?: string | number | null;
    logistic_code?: string | number | null;
    name?: string | number | null;
  };

  return String(
    candidate.id ??
      candidate.task_id ??
      candidate.taskId ??
      candidate.logistic_code ??
      candidate.name ??
      "",
  );
};
