import { useMemo } from "react";
import type { UniqueIdentifier } from "@dnd-kit/core";
import { SortableItem } from "@/lib/dnd";
import TaskCard, { type TaskCardProps } from "./task-card";
import type { AppDndItem } from "@/lib/dnd";

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
      disabled={isDragDisabled}
      disableTransform={disableSortableTransform}
      draggingOpacity={draggingOpacity}
      hideWhileDragging={hideWhileDragging}
      collapsePullPx={collapsePullPx}
    >
      {({ attributes, listeners, isDragging, setActivatorNodeRef, handleAttributes }) => (
        <TaskCard
          {...taskCardProps}
          isDragDisabled={isDragDisabled}
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
