import type { TaskNode } from "../input-contract";

export function hasCleanerAssignment(task: TaskNode): boolean {
  return (
    task.groupingHints.cleanerId != null &&
    task.groupingHints.cleanerSequence != null
  );
}
