import type { TaskNode } from "../input-contract";
import type { RoutingBusinessGroup } from "./group-contract";
import { BUSINESS_GROUP_THRESHOLDS } from "./group-weights";
import { haversineMeters, unionFindGroups } from "./geo-utils";
import { effectiveTravelMin } from "./travel-matrix-utils";
import { hasCleanerAssignment } from "./task-eligibility";

export function computePriorityWindowOverlap(
  tasks: TaskNode[]
): { startMin: number; endMin: number } | null {
  if (tasks.length === 0) {
    return null;
  }
  const overlapStart = Math.max(...tasks.map((task) => task.hardWindow.earliestStartMin));
  const overlapEnd = Math.min(...tasks.map((task) => task.hardWindow.latestStartMin));
  const overlapMinutes = overlapEnd - overlapStart;
  if (overlapMinutes < BUSINESS_GROUP_THRESHOLDS.PRIORITY_COMPATIBLE_MIN_OVERLAP_MIN) {
    return null;
  }
  return { startMin: overlapStart, endMin: overlapEnd };
}

function hasCleanerTaskStartMin(task: TaskNode): boolean {
  const startMin = task.debug?.sourceTimes?.cleanerTaskStartMin;
  return startMin != null && Number.isFinite(startMin);
}

function compareSequenceTasks(left: TaskNode, right: TaskNode): number {
  const leftStart = left.debug!.sourceTimes!.cleanerTaskStartMin!;
  const rightStart = right.debug!.sourceTimes!.cleanerTaskStartMin!;
  if (leftStart !== rightStart) {
    return leftStart - rightStart;
  }

  const leftSequence = left.groupingHints.cleanerSequence ?? Number.MAX_SAFE_INTEGER;
  const rightSequence = right.groupingHints.cleanerSequence ?? Number.MAX_SAFE_INTEGER;
  if (leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }

  return left.taskId - right.taskId;
}

export function computeCleanerSequenceOrder(tasks: TaskNode[]): number[] {
  return [...tasks].sort(compareSequenceTasks).map((task) => task.taskId);
}

function isConnectedWithinTolerance(tasks: TaskNode[], toleranceMeters: number): boolean {
  if (tasks.length < 2) {
    return false;
  }
  const components = unionFindGroups(tasks, (left, right) => {
    const distance = haversineMeters(
      left.location.lat,
      left.location.lng,
      right.location.lat,
      right.location.lng
    );
    return distance <= toleranceMeters;
  });
  return components.length === 1;
}

export type BusinessGroupSemanticIssue = {
  message: string;
  taskId?: number;
  expected?: unknown;
  actual?: unknown;
};

function resolveGroupTasks(
  group: RoutingBusinessGroup,
  taskById: Map<number, TaskNode>
): TaskNode[] {
  return group.taskIds
    .map((taskId) => taskById.get(taskId))
    .filter((task): task is TaskNode => task !== undefined);
}

export function validateBusinessGroupSemantics(
  group: RoutingBusinessGroup,
  taskById: Map<number, TaskNode>,
  travelMatrixMin: number[][]
): BusinessGroupSemanticIssue[] {
  const issues: BusinessGroupSemanticIssue[] = [];
  const groupTasks = resolveGroupTasks(group, taskById);

  if (groupTasks.length !== group.taskIds.length) {
    return issues;
  }

  switch (group.type) {
    case "SAME_CLEANER": {
      for (const task of groupTasks) {
        if (!hasCleanerAssignment(task)) {
          issues.push({
            message: `SAME_CLEANER ${group.groupId} includes task ${task.taskId} without cleaner assignment`,
            taskId: task.taskId,
          });
          continue;
        }
        if (task.groupingHints.cleanerId !== group.cleanerId) {
          issues.push({
            message: `SAME_CLEANER ${group.groupId} task ${task.taskId} cleanerId mismatch`,
            taskId: task.taskId,
            expected: group.cleanerId,
            actual: task.groupingHints.cleanerId,
          });
        }
      }
      break;
    }
    case "CLEANER_SEQUENCE": {
      for (const task of groupTasks) {
        if (!hasCleanerAssignment(task)) {
          issues.push({
            message: `CLEANER_SEQUENCE ${group.groupId} includes task ${task.taskId} without cleaner assignment`,
            taskId: task.taskId,
          });
          continue;
        }
        if (!hasCleanerTaskStartMin(task)) {
          issues.push({
            message: `CLEANER_SEQUENCE ${group.groupId} includes task ${task.taskId} without cleanerTaskStartMin`,
            taskId: task.taskId,
          });
          continue;
        }
        if (task.groupingHints.cleanerId !== group.cleanerId) {
          issues.push({
            message: `CLEANER_SEQUENCE ${group.groupId} task ${task.taskId} cleanerId mismatch`,
            taskId: task.taskId,
            expected: group.cleanerId,
            actual: task.groupingHints.cleanerId,
          });
        }
      }

      const expectedOrder = computeCleanerSequenceOrder(groupTasks);
      if (
        expectedOrder.length !== group.orderedTaskIds.length ||
        expectedOrder.some((taskId, index) => taskId !== group.orderedTaskIds[index])
      ) {
        issues.push({
          message: `CLEANER_SEQUENCE ${group.groupId} orderedTaskIds do not match cleanerTaskStartMin ordering`,
          expected: expectedOrder,
          actual: group.orderedTaskIds,
        });
      }
      break;
    }
    case "PRIORITY_COMPATIBLE": {
      const expectedOverlap = computePriorityWindowOverlap(groupTasks);
      if (!expectedOverlap) {
        issues.push({
          message: `PRIORITY_COMPATIBLE ${group.groupId} tasks do not share ${BUSINESS_GROUP_THRESHOLDS.PRIORITY_COMPATIBLE_MIN_OVERLAP_MIN} minute overlap`,
          actual: group.windowOverlap,
        });
        break;
      }
      if (
        expectedOverlap.startMin !== group.windowOverlap.startMin ||
        expectedOverlap.endMin !== group.windowOverlap.endMin
      ) {
        issues.push({
          message: `PRIORITY_COMPATIBLE ${group.groupId} windowOverlap does not match task hard windows`,
          expected: expectedOverlap,
          actual: group.windowOverlap,
        });
      }
      break;
    }
    case "NEARBY_CLUSTER": {
      const hubTask = taskById.get(group.hubTaskId);
      if (!hubTask) {
        break;
      }
      if (!group.taskIds.includes(group.hubTaskId)) {
        issues.push({
          message: `NEARBY_CLUSTER ${group.groupId} hubTaskId is not in taskIds`,
          taskId: group.hubTaskId,
          actual: group.taskIds,
        });
      }

      const hubNodeIndex = hubTask.nodeIndex;
      for (const member of groupTasks) {
        if (member.taskId === group.hubTaskId) {
          continue;
        }
        const travelMinutes = effectiveTravelMin(
          travelMatrixMin,
          hubNodeIndex,
          member.nodeIndex
        );
        if (
          travelMinutes === null ||
          travelMinutes > group.maxTravelMin
        ) {
          issues.push({
            message: `NEARBY_CLUSTER ${group.groupId} member ${member.taskId} exceeds maxTravelMin from hub ${group.hubTaskId}`,
            taskId: member.taskId,
            expected: `<= ${group.maxTravelMin}`,
            actual: travelMinutes,
          });
        }
      }
      break;
    }
    case "SAME_COORDINATES_BUILDING": {
      const allHaveCoordinates = groupTasks.every(
        (task) =>
          Number.isFinite(task.location.lat) && Number.isFinite(task.location.lng)
      );
      if (!allHaveCoordinates) {
        issues.push({
          message: `SAME_COORDINATES_BUILDING ${group.groupId} includes tasks without finite coordinates`,
        });
        break;
      }
      if (!isConnectedWithinTolerance(groupTasks, group.toleranceMeters)) {
        issues.push({
          message: `SAME_COORDINATES_BUILDING ${group.groupId} tasks are not connected within ${group.toleranceMeters}m`,
          expected: "single connected component",
        });
      }
      break;
    }
  }

  return issues;
}
