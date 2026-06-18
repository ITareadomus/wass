import type { TaskNode } from "../input-contract";
import type { SameCleanerGroup } from "./group-contract";
import { hasCleanerAssignment } from "./task-eligibility";

export function buildSameCleanerGroups(tasks: TaskNode[]): SameCleanerGroup[] {
  const byCleanerId = new Map<number, TaskNode[]>();

  for (const task of tasks) {
    if (!hasCleanerAssignment(task)) {
      continue;
    }
    const cleanerId = task.groupingHints.cleanerId!;
    const group = byCleanerId.get(cleanerId) ?? [];
    group.push(task);
    byCleanerId.set(cleanerId, group);
  }

  const groups: SameCleanerGroup[] = [];
  for (const [cleanerId, cleanerTasks] of byCleanerId) {
    if (cleanerTasks.length < 2) {
      continue;
    }
    const taskIds = cleanerTasks.map((task) => task.taskId).sort((a, b) => a - b);
    groups.push({
      groupId: `same-cleaner:${cleanerId}`,
      type: "SAME_CLEANER",
      taskIds,
      confidence: "medium",
      cleanerId,
      source: "cleaner_id",
    });
  }

  return groups.sort((a, b) => a.cleanerId - b.cleanerId);
}
