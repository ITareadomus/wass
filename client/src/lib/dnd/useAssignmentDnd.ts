import { useCallback, useMemo, useRef, useState } from "react";
import type {
  CollisionDetection,
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
  Modifier,
} from "@dnd-kit/core";
import { buildDndDropOperation } from "./operations";
import { timelineFirstCollisionDetection } from "./collision";
import {
  DND_CONTAINER_ID_ATTRIBUTE,
  DND_DRAGGABLE_SELECTOR,
  DND_SORTABLE_ID_ATTRIBUTE,
  useAppDndSensors,
} from "./sensors";
import {
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

const rectsIntersect = (
  a: { left: number; right: number; top: number; bottom: number },
  b: { left: number; right: number; top: number; bottom: number },
) => {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
};

const getActiveTranslatedRect = (event: DragEndEvent) => {
  const translated = event.active.rect.current.translated;
  if (translated) return translated;

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

const getRemoveZoneTargetFromEvent = (
  event: DragEndEvent,
  item: AppDndItem,
  scope: DndScope,
): DndInsertTarget | null => {
  if (item.from.type !== "timeline" && item.from.type !== "summary") return null;

  const removeZone = document.querySelector<HTMLElement>(
    `[data-dnd-remove-zone-scope="${scope}"]`,
  );
  if (!removeZone) return null;

  const activeRect = getActiveTranslatedRect(event);
  if (!activeRect) return null;

  const removeZoneRect = removeZone.getBoundingClientRect();
  if (!rectsIntersect(activeRect, removeZoneRect)) return null;

  return {
    containerId: `container:${scope}:remove-zone`,
    container: {
      kind: "container",
      scope,
      type: "remove-zone",
      accepts: ["timeline", "summary"],
    },
    index: 0,
    isValid: true,
  };
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

// Posizione corrente del puntatore (cursore) = punto di presa iniziale
// (activatorEvent) + spostamento del drag (delta). La usiamo per l'indice di
// inserimento perché coincide con l'overlay (ancorato al cursore) e non risente
// del collasso dei gap, che invece falsa il rect tradotto dell'elemento.
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

// Coordinata usata per calcolare l'indice di inserimento. Preferisce la
// posizione del cursore (coerente con l'overlay); come fallback usa il centro
// del rettangolo trascinato.
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

const getLayoutInsertIndex = (
  event: DndLayoutEvent,
  target: DndInsertTarget,
) => {
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

  const sortableRects = Array.from(
    container.querySelectorAll<HTMLElement>(DND_DRAGGABLE_SELECTOR),
  )
    .filter(
      (element) =>
        element.getAttribute(DND_SORTABLE_ID_ATTRIBUTE) !== String(event.active.id),
    )
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .sort((a, b) =>
      target.container.type === "summary"
        ? a.top - b.top || a.left - b.left
        : a.left - b.left || a.top - b.top,
    );

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

const getTargetFromEvent = (
  event: DragOverEvent | DragEndEvent,
): DndInsertTarget | null => {
  if (!event.over) return null;

  const overData = event.over.data.current as DndEventData | undefined;
  if (overData?.target) {
    return {
      ...overData.target,
      index: getLayoutInsertIndex(event, overData.target),
    };
  }

  const container = getContainerFromEvent(event);
  if (!container) return null;
  const overItem = event.over.data.current;
  const containerId =
    container.type === "timeline"
      ? timelineContainerDndId(container.scope, container.staffId)
      : container.type === "summary"
      ? summaryContainerDndId(container.scope, container.staffId)
      : event.over.id;

  const target = {
    containerId,
    container,
    index:
      isAppDndItem(overItem)
        ? overItem.index
        : typeof overData?.insertIndex === "number"
        ? overData.insertIndex
        : 0,
    isValid: true,
  };

  return {
    ...target,
    index: getLayoutInsertIndex(event, target),
  };
};

export function useAssignmentDnd({
  scope,
  collisionDetection = timelineFirstCollisionDetection,
  onOperation,
  onDragStart,
  onDragOver,
  onDragCancel,
}: UseAssignmentDndOptions) {
  const sensors = useAppDndSensors();
  const [activeItem, setActiveItem] = useState<AppDndItem | null>(null);
  const [activeDragTask, setActiveDragTask] = useState<unknown>(null);
  const [activeRect, setActiveRect] = useState<ActiveDndRect | null>(null);
  const [insertTarget, setInsertTarget] = useState<DndInsertTarget | null>(
    null,
  );
  // Shift costante (px) per riportare l'overlay al punto di presa: quando i gap
  // collassano al dragStart, il nodo sorgente scivola a sinistra e con lui
  // l'overlay. Misuriamo lo scostamento reale del nodo (prima vs dopo il
  // collasso) via DOM e lo applichiamo come correzione fissa.
  const layoutShiftRef = useRef({ x: 0, y: 0 });
  const layoutShiftFrameRef = useRef<number | null>(null);

  const cancelLayoutShiftCapture = useCallback(() => {
    if (layoutShiftFrameRef.current !== null) {
      cancelAnimationFrame(layoutShiftFrameRef.current);
      layoutShiftFrameRef.current = null;
    }
  }, []);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const item = event.active.data.current;
      cancelLayoutShiftCapture();
      layoutShiftRef.current = { x: 0, y: 0 };

      if (!isAppDndItem(item) || item.scope !== scope) {
        setActiveItem(null);
        setActiveDragTask(null);
        return;
      }

      setActiveItem(item);
      setActiveDragTask(item.getTask?.() ?? null);
      const measuredRect = item.getDragOverlayRect?.() ?? null;
      const initialRect = measuredRect ?? event.active.rect.current.initial;
      setActiveRect(
        initialRect
          ? {
              width: initialRect.width,
              height: initialRect.height,
            }
          : null,
      );
      onDragStart?.(item);

      // Posizione del nodo sorgente PRIMA del collasso dei gap.
      const domInitialRect = event.active.rect.current.initial ?? null;
      const sortableId = String(event.active.id);

      if (domInitialRect && typeof document !== "undefined") {
        // Doppio rAF: attende che React abbia ricalcolato il layout (gap collassati).
        layoutShiftFrameRef.current = requestAnimationFrame(() => {
          layoutShiftFrameRef.current = requestAnimationFrame(() => {
            layoutShiftFrameRef.current = null;
            const node = document.querySelector<HTMLElement>(
              `[${DND_SORTABLE_ID_ATTRIBUTE}="${escapeCssAttributeValue(
                sortableId,
              )}"]`,
            );
            if (!node) return;
            const collapsedRect = node.getBoundingClientRect();
            layoutShiftRef.current = {
              x: domInitialRect.left - collapsedRect.left,
              y: domInitialRect.top - collapsedRect.top,
            };
          });
        });
      }
    },
    [cancelLayoutShiftCapture, onDragStart, scope],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const target = getTargetFromEvent(event);
      setInsertTarget(target);
      onDragOver?.(target);
    },
    [onDragOver],
  );

  const resetDragState = useCallback(() => {
    cancelLayoutShiftCapture();
    setActiveItem(null);
    setActiveDragTask(null);
    setActiveRect(null);
    setInsertTarget(null);
    layoutShiftRef.current = { x: 0, y: 0 };
  }, [cancelLayoutShiftCapture]);

  // Applica lo shift costante misurato via DOM: sposta l'overlay della stessa
  // quantità di cui il nodo sorgente è scivolato, riportandolo sotto il cursore.
  const overlayModifier = useCallback<Modifier>(({ transform }) => {
    return {
      ...transform,
      x: transform.x + layoutShiftRef.current.x,
      y: transform.y + layoutShiftRef.current.y,
    };
  }, []);

  const overlayModifiers = useMemo(() => [overlayModifier], [overlayModifier]);

  const handleDragCancel = useCallback(() => {
    resetDragState();
    onDragCancel?.();
  }, [onDragCancel, resetDragState]);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const item = event.active.data.current;

      if (!isAppDndItem(item) || item.scope !== scope) {
        resetDragState();
        return;
      }

      const target =
        getRemoveZoneTargetFromEvent(event, item, scope) ??
        getTargetFromEvent(event);
      resetDragState();

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
    [onOperation, resetDragState, scope],
  );

  return useMemo(
    () => ({
      sensors,
      collisionDetection,
      activeItem,
      activeDragTask,
      activeRect,
      insertTarget,
      overlayModifiers,
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
      overlayModifiers,
      sensors,
    ],
  );
}
