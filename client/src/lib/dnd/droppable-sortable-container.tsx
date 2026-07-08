import type {
  HTMLAttributes,
  ReactNode,
  RefCallback,
} from "react";
import { useDroppable } from "@dnd-kit/core";
import type { UniqueIdentifier } from "@dnd-kit/core";
import {
  horizontalListSortingStrategy,
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  summaryContainerDndId,
  timelineContainerDndId,
} from "./ids";
import { DND_CONTAINER_ID_ATTRIBUTE } from "./sensors";
import type {
  AppDndContainer,
  DndScope,
  DndStaffId,
} from "./types";

export type DndDroppableSortableContainerProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "children" | "className" | "id"
> & {
  scope: DndScope;
  type: "timeline" | "summary";
  staffId: DndStaffId;
  itemIds: UniqueIdentifier[];
  insertIndex: number;
  disabled?: boolean;
  orientation?: "horizontal" | "vertical";
  className?: string | ((state: { isOver: boolean }) => string);
  innerRef?: RefCallback<HTMLDivElement>;
  children:
    | ReactNode
    | ((state: { isOver: boolean }) => ReactNode);
};

export function DndDroppableSortableContainer({
  scope,
  type,
  staffId,
  itemIds,
  insertIndex,
  disabled = false,
  orientation = "horizontal",
  innerRef,
  children,
  className,
  ...props
}: DndDroppableSortableContainerProps) {
  const containerId =
    type === "timeline"
      ? timelineContainerDndId(scope, staffId)
      : summaryContainerDndId(scope, staffId);
  const containerData: AppDndContainer = {
    kind: "container",
    scope,
    type,
    staffId,
    accepts:
      type === "timeline"
        ? ["priority", "timeline", "summary"]
        : ["timeline", "summary"],
  };
  const { isOver, setNodeRef } = useDroppable({
    id: containerId,
    data: {
      ...containerData,
      insertIndex,
    },
    disabled,
  });

  const setRefs: RefCallback<HTMLDivElement> = (node) => {
    setNodeRef(node);
    innerRef?.(node);
  };

  const resolvedClassName =
    typeof className === "function" ? className({ isOver }) : className;

  return (
    <SortableContext
      items={itemIds}
      strategy={
        orientation === "horizontal"
          ? horizontalListSortingStrategy
          : verticalListSortingStrategy
      }
    >
      <div
        ref={setRefs}
        className={resolvedClassName}
        {...{ [DND_CONTAINER_ID_ATTRIBUTE]: String(containerId) }}
        {...props}
      >
        {typeof children === "function" ? children({ isOver }) : children}
      </div>
    </SortableContext>
  );
}
