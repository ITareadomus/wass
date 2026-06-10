import type { TaskNode } from "../input-contract";
import { computePriorityWindowOverlap } from "./business-group-semantics";
import type { PriorityCompatibleGroup } from "./group-contract";
import { BUSINESS_GROUP_THRESHOLDS } from "./group-weights";
import { unionFindGroups } from "./geo-utils";

function pairOverlapMinutes(left: TaskNode, right: TaskNode): number {
  const overlapStart = Math.max(left.hardWindow.earliestStartMin, right.hardWindow.earliestStartMin);
  const overlapEnd = Math.min(left.hardWindow.latestStartMin, right.hardWindow.latestStartMin);
  return overlapEnd - overlapStart;
}

export function buildPriorityCompatibleGroups(tasks: TaskNode[]): PriorityCompatibleGroup[] {
  const minOverlap = BUSINESS_GROUP_THRESHOLDS.PRIORITY_COMPATIBLE_MIN_OVERLAP_MIN;
  const components = unionFindGroups(tasks, (left, right) => {
    return pairOverlapMinutes(left, right) >= minOverlap;
  });

  const groups: PriorityCompatibleGroup[] = [];
  for (const component of components) {
    if (component.length < 2) {
      continue;
    }

    const windowOverlap = computePriorityWindowOverlap(component);
    if (!windowOverlap) {
      continue;
    }

    const taskIds = component.map((task) => task.taskId).sort((a, b) => a - b);
    groups.push({
      groupId: `priority-compatible:${taskIds.join(",")}`,
      type: "PRIORITY_COMPATIBLE",
      taskIds,
      confidence: "medium",
      windowOverlap,
      source: "priority_window",
    });
  }

  return groups;
}
