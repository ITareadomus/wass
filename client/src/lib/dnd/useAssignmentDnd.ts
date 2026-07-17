import { useCallback, useMemo, useRef, useState } from "react";
import type {
  CollisionDetection,
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import { getEventCoordinates } from "@dnd-kit/utilities";
import { buildDndDropOperation } from "./operations";
import { timelineFirstCollisionDetection } from "./collision";
import { constrainAssignedTimelineDragModifier } from "./modifiers";
import {
  DND_CONTAINER_ID_ATTRIBUTE,
  DND_DRAGGABLE_SELECTOR,
  DND_SORTABLE_ID_ATTRIBUTE,
  useAppDndSensors,
} from "./sensors";
import {
  parseDndId,
  summaryContainerDndId,
  timelineContainerDndId,
} from "./ids";
import type {
  AppDndContainer,
  AppDndItem,
  AppDndSource,
  DndDropOperation,
  DndInsertTarget,
  DndScope,
} from "./types";
import { isAppDndContainer, isAppDndItem } from "./types";

type DndEventData = {
  insertIndex?: number;
  target?: DndInsertTarget;
};

type DndLayoutEvent = DragOverEvent | DragEndEvent;

export type ActiveDndRect = {
  width: number;
  height: number;
  /** Offset cursore → top-left del node al momento del grab */
  grabOffsetX?: number;
  grabOffsetY?: number;
};

const sourceToContainer = (
  source: AppDndSource,
  scope: DndScope,
): AppDndContainer => {
  if (source.type === "priority") {
    return {
      kind: "container",
      scope,
      type: "priority",
      key: source.key,
      accepts: ["priority", "timeline", "summary"],
    };
  }

  if (source.type === "timeline") {
    return {
      kind: "container",
      scope,
      type: "timeline",
      staffId: source.staffId,
      accepts: ["priority", "timeline", "summary"],
    };
  }

  return {
    kind: "container",
    scope,
    type: "summary",
    staffId: source.staffId,
    accepts: ["timeline", "summary"],
  };
};

export type AssignmentDndHandlers = {
  onOperation: (operation: DndDropOperation) => void | Promise<void>;
  onDragStart?: (item: AppDndItem) => void;
  onDragOver?: (target: DndInsertTarget | null) => void;
  onDragCancel?: () => void;
  /** Fired as soon as the drag gesture ends (drop or invalid release), before onOperation. */
  onDragEnd?: () => void;
};

export type UseAssignmentDndOptions = AssignmentDndHandlers & {
  scope: DndScope;
  collisionDetection?: CollisionDetection;
};

const getContainerFromEvent = (event: DragOverEvent | DragEndEvent) => {
  const overData = event.over?.data.current;
  if (isAppDndContainer(overData)) return overData;
  if (isAppDndItem(overData)) {
    return sourceToContainer(overData.from, overData.scope);
  }

  const target = (overData as DndEventData | undefined)?.target;
  if (target?.container) return target.container;

  return null;
};

const escapeCssAttributeValue = (value: string) => {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }

  return value.replace(/["\\]/g, "\\$&");
};

const getActiveLayoutRect = (event: DndLayoutEvent) => {
  const rect = event.active.rect.current.translated;
  if (rect) return rect;

  const initial = event.active.rect.current.initial;
  if (!initial) return null;

  return {
    ...initial,
    left: initial.left + event.delta.x,
    right: initial.right + event.delta.x,
    top: initial.top + event.delta.y,
    bottom: initial.bottom + event.delta.y,
  };
};

const getPointerClientCoordinate = (
  event: DndLayoutEvent,
  axis: "x" | "y",
): number | null => {
  const activator = event.activatorEvent as
    | (Partial<MouseEvent> & { touches?: TouchList })
    | undefined;

  let base: number | null = null;
  if (activator) {
    if (
      typeof activator.clientX === "number" &&
      typeof activator.clientY === "number"
    ) {
      base = axis === "x" ? activator.clientX : activator.clientY;
    } else if (activator.touches && activator.touches.length > 0) {
      const touch = activator.touches[0];
      base = axis === "x" ? touch.clientX : touch.clientY;
    }
  }

  if (base === null) return null;
  return base + (axis === "x" ? event.delta.x : event.delta.y);
};

const getActiveInsertCoordinate = (
  event: DndLayoutEvent,
  axis: "x" | "y",
) => {
  const pointer = getPointerClientCoordinate(event, axis);
  if (pointer !== null) return pointer;

  const activeRect = getActiveLayoutRect(event);
  if (!activeRect) return null;

  return axis === "x"
    ? activeRect.left + activeRect.width / 2
    : activeRect.top + activeRect.height / 2;
};

const isAssignedSource = (
  source: AppDndSource,
): source is Extract<AppDndSource, { type: "timeline" | "summary" }> =>
  source.type === "timeline" || source.type === "summary";

const isAssignedContainer = (
  container: AppDndContainer,
): container is Extract<
  AppDndContainer,
  { type: "timeline" | "summary" }
> => container.type === "timeline" || container.type === "summary";

const isExcludedSortableElement = (
  element: HTMLElement,
  event: DndLayoutEvent,
  activeItem: unknown,
) => {
  const sortableId = element.getAttribute(DND_SORTABLE_ID_ATTRIBUTE);
  if (!sortableId) return false;
  if (sortableId === String(event.active.id)) return true;

  const parsed = parseDndId(sortableId);
  if (
    isAppDndItem(activeItem) &&
    parsed?.kind === "task" &&
    parsed.taskId === activeItem.taskId
  ) {
    return true;
  }

  return false;
};

const getLayoutInsertIndex = (
  event: DndLayoutEvent,
  target: DndInsertTarget,
): number | null => {
  if (
    target.container.type !== "timeline" &&
    target.container.type !== "summary"
  ) {
    return target.index;
  }

  const axis = target.container.type === "summary" ? "y" : "x";
  const activeEdge = getActiveInsertCoordinate(event, axis);
  if (activeEdge === null) return target.index;

  const container = document.querySelector<HTMLElement>(
    `[${DND_CONTAINER_ID_ATTRIBUTE}="${escapeCssAttributeValue(
      String(target.containerId),
    )}"]`,
  );
  if (!container) return target.index;

  const activeItem = event.active.data.current;
  const allElements = Array.from(
    container.querySelectorAll<HTMLElement>(DND_DRAGGABLE_SELECTOR),
  );
  const visibleElements = allElements.filter(
    (element) => !isExcludedSortableElement(element, event, activeItem),
  );

  const sortableRects = visibleElements
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .sort((a, b) =>
      target.container.type === "summary"
        ? a.top - b.top || a.left - b.left
        : a.left - b.left || a.top - b.top,
    );

  if (visibleElements.length > 0 && sortableRects.length === 0) {
    return null;
  }

  for (let index = 0; index < sortableRects.length; index += 1) {
    const rect = sortableRects[index];
    const midpoint =
      target.container.type === "summary"
        ? rect.top + rect.height / 2
        : rect.left + rect.width / 2;

    if (activeEdge < midpoint) return index;
  }

  return sortableRects.length;
};

const getInsertIndexFromOverItem = (
  event: DndLayoutEvent,
  activeItem: AppDndItem,
  overItem: AppDndItem,
  container: Extract<
    AppDndContainer,
    { type: "timeline" | "summary" }
  >,
) => {
  const axis = container.type === "summary" ? "y" : "x";
  const coordinate = getActiveInsertCoordinate(event, axis);
  const rect = event.over?.rect;

  if (coordinate === null || !rect) {
    return overItem.index;
  }

  const midpoint =
    axis === "x"
      ? rect.left + rect.width / 2
      : rect.top + rect.height / 2;

  let insertionSlot =
    overItem.index + (coordinate >= midpoint ? 1 : 0);

  const sameAssignedSequence =
    isAssignedSource(activeItem.from) &&
    activeItem.from.staffId === container.staffId;

  if (sameAssignedSequence) {
    const sourceIndex =
      activeItem.initialIndex ?? activeItem.index;

    if (sourceIndex < insertionSlot) {
      insertionSlot -= 1;
    }
  }

  return Math.max(0, insertionSlot);
};

const buildTargetFromLayout = (
  event: DragOverEvent | DragEndEvent,
): DndInsertTarget | null => {
  const activeItem = event.active.data.current;
  if (!isAppDndItem(activeItem)) return null;
  if (activeItem.from.type === "priority") return null;

  const container = sourceToContainer(activeItem.from, activeItem.scope);
  const containerId =
    container.type === "timeline"
      ? timelineContainerDndId(container.scope, container.staffId)
      : container.type === "summary"
        ? summaryContainerDndId(container.scope, container.staffId)
        : String(event.active.id);

  const target: DndInsertTarget = {
    containerId,
    container,
    index: activeItem.index,
    isValid: true,
  };

  const layoutIndex = getLayoutInsertIndex(event, target);
  if (layoutIndex === null) {
    return { ...target, isValid: false };
  }

  return {
    ...target,
    index: layoutIndex,
  };
};

const getCollisionInsertTarget = (
  event: DragOverEvent | DragEndEvent,
): DndInsertTarget | null => {
  const collisions = event.collisions;
  if (!collisions?.length) return null;

  for (const collision of collisions) {
    const data = collision.data as DndEventData | undefined;
    if (data?.target?.isValid) {
      return data.target;
    }
    if (
      typeof data?.insertIndex === "number" &&
      Number.isFinite(data.insertIndex)
    ) {
      const container = getContainerFromEvent(event);
      if (!container || !isAssignedContainer(container)) continue;
      return {
        containerId: collision.id,
        container,
        index: data.insertIndex,
        isValid: true,
      };
    }
  }

  return null;
};

const getTargetFromEvent = (
  event: DragOverEvent | DragEndEvent,
): DndInsertTarget | null => {
  if (!event.over) return null;

  // Prefer midpoint insert index computed during collision detection so the
  // drop slot matches the sortable transform (left/right of each card center).
  const collisionTarget = getCollisionInsertTarget(event);
  if (collisionTarget) {
    return collisionTarget;
  }

  if (event.over.id === event.active.id) {
    return buildTargetFromLayout(event);
  }

  const overData = event.over.data.current as DndEventData | undefined;
  if (overData?.target) {
    return overData.target;
  }

  const container = getContainerFromEvent(event);
  if (!container) return null;

  const activeItem = event.active.data.current;
  const overItem = event.over.data.current;
  const containerId =
    container.type === "timeline"
      ? timelineContainerDndId(container.scope, container.staffId)
      : container.type === "summary"
        ? summaryContainerDndId(container.scope, container.staffId)
        : event.over.id;

  let index =
    isAppDndItem(overItem)
      ? overItem.index
      : typeof overData?.insertIndex === "number"
        ? overData.insertIndex
        : 0;

  if (
    isAppDndItem(activeItem) &&
    isAppDndItem(overItem) &&
    isAssignedContainer(container)
  ) {
    index = getInsertIndexFromOverItem(
      event,
      activeItem,
      overItem,
      container,
    );
  } else {
    const target = {
      containerId,
      container,
      index,
      isValid: true,
    };
    const layoutIndex = getLayoutInsertIndex(event, target);
    if (layoutIndex === null) {
      return { ...target, isValid: false };
    }
    index = layoutIndex;
  }

  return {
    containerId,
    container,
    index,
    isValid: true,
  };
};

export function useAssignmentDnd({
  scope,
  collisionDetection = timelineFirstCollisionDetection,
  onOperation,
  onDragStart,
  onDragOver,
  onDragCancel,
  onDragEnd,
}: UseAssignmentDndOptions) {
  const sensors = useAppDndSensors();
  const [activeItem, setActiveItem] = useState<AppDndItem | null>(null);
  const [activeDragTask, setActiveDragTask] = useState<unknown>(null);
  const [activeRect, setActiveRect] = useState<ActiveDndRect | null>(null);
  const [insertTarget, setInsertTarget] = useState<DndInsertTarget | null>(
    null,
  );
  const lastPreviewTargetRef = useRef<DndInsertTarget | null>(null);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const item = event.active.data.current;

      if (!isAppDndItem(item) || item.scope !== scope) {
        setActiveItem(null);
        setActiveDragTask(null);
        lastPreviewTargetRef.current = null;
        return;
      }

      setActiveItem(item);
      setActiveDragTask(item.getTask?.() ?? null);
      const measuredRect = item.getDragOverlayRect?.() ?? null;
      const initialNodeRect = event.active.rect.current.initial;
      const width = measuredRect?.width ?? initialNodeRect?.width;
      const height = measuredRect?.height ?? initialNodeRect?.height;

      let grabOffsetX: number | undefined;
      let grabOffsetY: number | undefined;
      if (event.activatorEvent && initialNodeRect) {
        const coords = getEventCoordinates(event.activatorEvent);
        if (coords) {
          grabOffsetX = coords.x - initialNodeRect.left;
          grabOffsetY = coords.y - initialNodeRect.top;
        }
      }

      setActiveRect(
        width && height
          ? { width, height, grabOffsetX, grabOffsetY }
          : null,
      );
      onDragStart?.(item);
    },
    [onDragStart, scope],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const currentTarget = getTargetFromEvent(event);
      const activeData = event.active.data.current;
      const isAssignedDrag =
        isAppDndItem(activeData) &&
        (activeData.from.type === "timeline" ||
          activeData.from.type === "summary");

      if (currentTarget) {
        lastPreviewTargetRef.current = currentTarget;
        setInsertTarget(currentTarget);
        onDragOver?.(currentTarget);
        return;
      }

      // DnD controllato: niente sticky su target non più validi (es. cleaner non adiacente)
      if (isAssignedDrag) {
        lastPreviewTargetRef.current = null;
        setInsertTarget(null);
        onDragOver?.(null);
        return;
      }

      const previewTarget = lastPreviewTargetRef.current;
      setInsertTarget(previewTarget);
      onDragOver?.(previewTarget);
    },
    [onDragOver],
  );

  const resetDragState = useCallback(() => {
    setActiveItem(null);
    setActiveDragTask(null);
    setActiveRect(null);
    setInsertTarget(null);
    lastPreviewTargetRef.current = null;
  }, []);

  const handleDragCancel = useCallback(() => {
    resetDragState();
    onDragCancel?.();
  }, [onDragCancel, resetDragState]);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const item = event.active.data.current;

      if (!isAppDndItem(item) || item.scope !== scope) {
        resetDragState();
        onDragEnd?.();
        return;
      }

      const target = getTargetFromEvent(event);
      resetDragState();
      // Clear page UI (remove zone, route spacers) immediately — don't wait for API.
      onDragEnd?.();

      if (!target?.isValid) {
        await onOperation({ type: "noop" });
        return;
      }

      await onOperation(
        buildDndDropOperation(item, {
          container: target.container,
          index: target.index,
          activeId: event.active.id,
          overId: event.over?.id ?? null,
        }),
      );
    },
    [onDragEnd, onOperation, resetDragState, scope],
  );

  const modifiers = useMemo(
    () => [constrainAssignedTimelineDragModifier],
    [],
  );

  return useMemo(
    () => ({
      sensors,
      collisionDetection,
      modifiers,
      activeItem,
      activeDragTask,
      activeRect,
      insertTarget,
      handlers: {
        onDragStart: handleDragStart,
        onDragOver: handleDragOver,
        onDragCancel: handleDragCancel,
        onDragEnd: handleDragEnd,
      },
    }),
    [
      activeDragTask,
      activeItem,
      activeRect,
      collisionDetection,
      handleDragCancel,
      handleDragEnd,
      handleDragOver,
      handleDragStart,
      insertTarget,
      modifiers,
      sensors,
    ],
  );
}
