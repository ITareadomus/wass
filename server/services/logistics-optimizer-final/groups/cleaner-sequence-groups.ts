import type { TaskNode } from "../input-contract";
import { computeCleanerSequenceOrder } from "./business-group-semantics";
import type { CleanerSequenceGroup } from "./group-contract";
import { hasCleanerAssignment } from "./task-eligibility";

function hasCleanerTaskStartMin(task: TaskNode): boolean {
  const startMin = task.debug?.sourceTimes?.cleanerTaskStartMin;
  return startMin != null && Number.isFinite(startMin);
}

export function buildCleanerSequenceGroups(tasks: TaskNode[]): CleanerSequenceGroup[] {
  const byCleanerId = new Map<number, TaskNode[]>();

  for (const task of tasks) {
    if (!hasCleanerAssignment(task) || !hasCleanerTaskStartMin(task)) {
      continue;
    }
    const cleanerId = task.groupingHints.cleanerId!;
    const group = byCleanerId.get(cleanerId) ?? [];
    group.push(task);
    byCleanerId.set(cleanerId, group);
  }

  const groups: CleanerSequenceGroup[] = [];
  for (const [cleanerId, cleanerTasks] of byCleanerId) {
    if (cleanerTasks.length < 2) {
      continue;
    }

    const orderedTaskIds = computeCleanerSequenceOrder(cleanerTasks);
    groups.push({
      groupId: `cleaner-sequence:${cleanerId}`,
      type: "CLEANER_SEQUENCE",
      taskIds: orderedTaskIds,
      orderedTaskIds,
      confidence: "high",
      cleanerId,
      source: "cleaner_task_start_time",
    });
  }

  return groups.sort((a, b) => a.cleanerId - b.cleanerId);
}
