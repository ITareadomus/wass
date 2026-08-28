import { useMemo } from "react";
import type { UniqueIdentifier } from "@dnd-kit/core";
import { SortableItem } from "@/lib/dnd";
import TaskCard, { type TaskCardProps } from "./task-card";
import type { AppDndItem } from "@/lib/dnd";
import { isHousekeepingTaskCleaned } from "@shared/housekeeping-task-execution-status";

function isHousekeepingMoveLocked(
  task: unknown,
  operationsScope?: TaskCardProps["operationsScope"],
): boolean {
  return operationsScope !== "logistics" && isHousekeepingTaskCleaned(task);
}

export type SortableTaskCardProps = Omit<
  TaskCardProps,
  | "dragWrapper"
  | "externalIsDragging"
  | "externalDragHandleProps"
  | "draggableId"
> & {
  dndId: UniqueIdentifier;
  dndData: AppDndItem;
  disableSortableTransform?: boolean;
  draggingOpacity?: number;
  hideWhileDragging?: boolean;
  collapsePullPx?: number;
};

export function SortableTaskCard({
  dndId,
  dndData,
  disableSortableTransform = false,
  draggingOpacity,
  hideWhileDragging = false,
  collapsePullPx,
  isDragDisabled = false,
  ...taskCardProps
}: SortableTaskCardProps) {
  const dragDisabled =
    isDragDisabled ||
    isHousekeepingMoveLocked(taskCardProps.task, taskCardProps.operationsScope);
  const sortableData = useMemo(
    () => ({
      ...dndData,
      getTask: () => taskCardProps.task,
    }),
    [dndData, taskCardProps.task],
  );

  return (
    <SortableItem
      id={dndId}
      data={sortableData}
      disabled={dragDisabled}
      disableTransform={disableSortableTransform}
      draggingOpacity={draggingOpacity}
      hideWhileDragging={hideWhileDragging}
      collapsePullPx={collapsePullPx}
    >
      {({ attributes, listeners, isDragging, setActivatorNodeRef, handleAttributes }) => (
        <TaskCard
          {...taskCardProps}
          isDragDisabled={dragDisabled}
          dragWrapper="none"
          externalIsDragging={isDragging}
          externalDragHandleProps={{
            ...attributes,
            ...listeners,
            ...handleAttributes,
            ref: setActivatorNodeRef,
          }}
        />
      )}
    </SortableItem>
  );
}

export default SortableTaskCard;
