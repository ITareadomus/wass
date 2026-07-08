import type { UniqueIdentifier } from "@dnd-kit/core";
import type {
  AppDndContainer,
  AppDndItem,
  AppDndSource,
  DndDropOperation,
  DndTaskId,
} from "./types";

export const getDraggedTaskIds = (item: AppDndItem): DndTaskId[] => {
  if (item.selectedTaskIds && item.selectedTaskIds.length > 0) {
    return item.selectedTaskIds;
  }
  return [item.taskId];
};

export const isSameTimelineSource = (
  from: AppDndSource,
  to: AppDndContainer,
) => {
  return (
    from.type === "timeline" &&
    to.type === "timeline" &&
    from.staffId === to.staffId
  );
};

export const isSameSummarySource = (
  from: AppDndSource,
  to: AppDndContainer,
) => {
  return (
    from.type === "summary" &&
    to.type === "summary" &&
    from.staffId === to.staffId
  );
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
  const { container, index } = target;
  const sourceIndex = item.initialIndex ?? item.index;

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

  if (
    item.from.type === "timeline" &&
    container.type === "timeline" &&
    item.from.staffId === container.staffId
  ) {
    if (sourceIndex === index) return { type: "noop" };
    return {
      type: "reorder",
      taskIds,
      in: item.from,
      fromIndex: sourceIndex,
      toIndex: index,
    };
  }

  if (
    item.from.type === "summary" &&
    container.type === "summary" &&
    item.from.staffId === container.staffId
  ) {
    if (sourceIndex === index) return { type: "noop" };
    return {
      type: "reorder",
      taskIds,
      in: item.from,
      fromIndex: sourceIndex,
      toIndex: index,
    };
  }

  if (
    item.from.type === "timeline" &&
    (container.type === "priority" || container.type === "remove-zone")
  ) {
    return {
      type: "remove",
      taskIds,
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
      from: item.from,
      to: container,
    };
  }

  if (
    (item.from.type === "timeline" || item.from.type === "summary") &&
    (container.type === "timeline" || container.type === "summary")
  ) {
    return {
      type: "reassign",
      taskIds,
      from: item.from,
      to: container,
      index,
    };
  }

  return { type: "noop" };
};
