import type { UniqueIdentifier } from "@dnd-kit/core";
import { useDraggable } from "@dnd-kit/core";
import { useMemo, useRef } from "react";
import TaskCard, { type TaskCardProps } from "./task-card";
import type { AppDndItem } from "@/lib/dnd";
import {
  appDndDraggableAttributes,
  appDndHandleAttributes,
} from "@/lib/dnd";
import { isHousekeepingTaskCleaned } from "@shared/housekeeping-task-execution-status";

const getTaskSurfaceRect = (node: HTMLElement | null) => {
  const surface = node?.querySelector<HTMLElement>('[data-dnd-task-card-surface="true"]');
  const rect = (surface ?? node)?.getBoundingClientRect();

  return rect
    ? {
        width: rect.width,
        height: rect.height,
      }
    : null;
};

export type DraggableTaskCardProps = Omit<
  TaskCardProps,
  | "dragWrapper"
  | "externalIsDragging"
  | "externalDragHandleProps"
  | "draggableId"
> & {
  dndId: UniqueIdentifier;
  dndData: AppDndItem;
};

export function DraggableTaskCard({
  dndId,
  dndData,
  isDragDisabled = false,
  ...taskCardProps
}: DraggableTaskCardProps) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const dragDisabled =
    isDragDisabled ||
    (taskCardProps.operationsScope !== "logistics" &&
      isHousekeepingTaskCleaned(taskCardProps.task));
  const data = useMemo<AppDndItem>(
    () => ({
      ...dndData,
      getDragOverlayRect: () => getTaskSurfaceRect(nodeRef.current),
      getTask: () => taskCardProps.task,
    }),
    [dndData, taskCardProps.task],
  );
  const draggable = useDraggable({
    id: dndId,
    data,
    disabled: dragDisabled,
  });

  return (
    <div
      ref={(node) => {
        nodeRef.current = node;
        draggable.setNodeRef(node);
      }}
      style={{
        // Keep the source node in layout without showing a ghost under the overlay.
        opacity: draggable.isDragging ? 0 : undefined,
        zIndex: draggable.isDragging ? 999 : undefined,
      }}
      {...appDndDraggableAttributes}
    >
      <TaskCard
        {...taskCardProps}
        isDragDisabled={dragDisabled}
        dragWrapper="none"
        externalIsDragging={draggable.isDragging}
        externalDragHandleProps={{
          ...draggable.attributes,
          ...draggable.listeners,
          ...appDndHandleAttributes,
        }}
      />
    </div>
  );
}

export default DraggableTaskCard;
