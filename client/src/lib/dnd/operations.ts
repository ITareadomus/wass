import type { UniqueIdentifier } from "@dnd-kit/core";
import type {
  AppDndContainer,
  AppDndItem,
  DndDropOperation,
  DndTaskId,
} from "./types";

export const getDraggedTaskIds = (item: AppDndItem): DndTaskId[] => {
  if (item.selectedTaskIds && item.selectedTaskIds.length > 0) {
    return item.selectedTaskIds;
  }
  return [item.taskId];
};

export const buildDndDropOperation = (
  item: AppDndItem,
  target: {
    container: AppDndContainer;
    index: number;
    activeId?: UniqueIdentifier;
    overId?: UniqueIdentifier | null;
  } | null,
): DndDropOperation => {
  if (!target) return { type: "noop" };

  const taskIds = getDraggedTaskIds(item);
  const taskSources =
    item.selectedTaskSources && item.selectedTaskSources.length > 0
      ? item.selectedTaskSources
      : undefined;
  const { container, index } = target;
  const sourceIndex = item.initialIndex ?? item.index;
  const isGroupMove = taskIds.length > 1;

  if (item.from.type === "priority" && container.type === "timeline") {
    return {
      type: "assign",
      taskIds,
      from: item.from,
      to: container,
      index,
    };
  }

  if (item.from.type === "priority" && container.type === "priority") {
    return { type: "noop" };
  }

  if (item.from.type === "timeline" || item.from.type === "summary") {
    if (container.type === "timeline" || container.type === "summary") {
      if (item.from.staffId === container.staffId) {
        if (!isGroupMove && sourceIndex === index) {
          return { type: "noop" };
        }

        return {
          type: "reorder",
          taskIds,
          taskSources,
          in: item.from,
          fromIndex: sourceIndex,
          toIndex: index,
        };
      }

      return {
        type: "reassign",
        taskIds,
        taskSources,
        from: item.from,
        to: container,
        index,
      };
    }
  }

  if (
    item.from.type === "timeline" &&
    (container.type === "priority" || container.type === "remove-zone")
  ) {
    return {
      type: "remove",
      taskIds,
      taskSources,
      from: item.from,
      to: container,
    };
  }

  if (
    item.from.type === "summary" &&
    (container.type === "priority" || container.type === "remove-zone")
  ) {
    return {
      type: "remove",
      taskIds,
      taskSources,
      from: item.from,
      to: container,
    };
  }

  return { type: "noop" };
};
