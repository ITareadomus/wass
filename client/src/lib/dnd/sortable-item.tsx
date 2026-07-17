import { useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Data, UniqueIdentifier } from "@dnd-kit/core";
import {
  appDndDraggableAttributes,
  appDndHandleAttributes,
  DND_SORTABLE_ID_ATTRIBUTE,
} from "./sensors";

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

export type SortableItemRenderState = {
  attributes: ReturnType<typeof useSortable>["attributes"];
  listeners: ReturnType<typeof useSortable>["listeners"];
  isDragging: boolean;
  setActivatorNodeRef: ReturnType<typeof useSortable>["setActivatorNodeRef"];
  handleAttributes: typeof appDndHandleAttributes;
};

export type SortableItemProps = {
  id: UniqueIdentifier;
  data?: Data;
  disabled?: boolean;
  disableTransform?: boolean;
  draggingOpacity?: number;
  hideWhileDragging?: boolean;
  /**
   * Tirare i sibling a sinistra senza collassare il node misurato da dnd-kit
   * (width:0 rompeva active.rect e l'insert index cross-cleaner).
   */
  collapsePullPx?: number;
  className?: string;
  style?: CSSProperties;
  children:
    | ReactNode
    | ((state: SortableItemRenderState) => ReactNode);
};

export function SortableItem({
  id,
  data,
  disabled = false,
  disableTransform = false,
  draggingOpacity = 0,
  hideWhileDragging = false,
  collapsePullPx = 0,
  className = "",
  style,
  children,
}: SortableItemProps) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const dataWithOverlayRect = useMemo(
    () =>
      data
        ? {
            ...data,
            getDragOverlayRect: () => getTaskSurfaceRect(nodeRef.current),
          }
        : data,
    [data],
  );
  const sortable = useSortable({
    id,
    data: dataWithOverlayRect,
    disabled,
    transition: {
      duration: 180,
      easing: "cubic-bezier(0.25, 1, 0.5, 1)",
    },
  });

  const shouldPullSiblings =
    collapsePullPx > 0 && sortable.isDragging;

  const transformStyle: CSSProperties = {
    transform: disableTransform ? undefined : CSS.Transform.toString(sortable.transform),
    transition: disableTransform ? undefined : sortable.transition,
    opacity: sortable.isDragging && !hideWhileDragging ? draggingOpacity : undefined,
    visibility: sortable.isDragging && hideWhileDragging ? "hidden" : undefined,
    zIndex: sortable.isDragging ? 999 : undefined,
    // Mantieni la larghezza per active.rect; il margin negativo chiude il buco.
    ...(shouldPullSiblings ? { marginRight: -collapsePullPx } : null),
    ...style,
  };

  return (
    <div
      ref={(node) => {
        nodeRef.current = node;
        sortable.setNodeRef(node);
      }}
      style={transformStyle}
      className={className}
      {...appDndDraggableAttributes}
      {...{ [DND_SORTABLE_ID_ATTRIBUTE]: String(id) }}
    >
      {typeof children === "function"
        ? children({
            attributes: sortable.attributes,
            listeners: sortable.listeners,
            isDragging: sortable.isDragging,
            setActivatorNodeRef: sortable.setActivatorNodeRef,
            handleAttributes: appDndHandleAttributes,
          })
        : children}
    </div>
  );
}
