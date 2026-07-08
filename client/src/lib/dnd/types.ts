import type { UniqueIdentifier } from "@dnd-kit/core";

export type DndScope = "housekeeping" | "logistics";

export type DndContainerType =
  | "priority"
  | "timeline"
  | "summary"
  | "remove-zone";

export type DndPriorityKey =
  | "early_out"
  | "high_priority"
  | "low_priority";

export type DndStaffId = number;
export type DndTaskId = string;

export type AppDndSource =
  | { type: "priority"; key: DndPriorityKey }
  | { type: "timeline"; staffId: DndStaffId }
  | { type: "summary"; staffId: DndStaffId };

export type AppDndItem = {
  kind: "task";
  scope: DndScope;
  taskId: DndTaskId;
  index: number;
  initialIndex?: number;
  from: AppDndSource;
  selectedTaskIds?: DndTaskId[];
  getDragOverlayRect?: () => { width: number; height: number } | null;
  getTask?: () => unknown;
};

export type AppDndContainer =
  | {
      kind: "container";
      scope: DndScope;
      type: "priority";
      key: DndPriorityKey;
      accepts: ReadonlyArray<AppDndSource["type"]>;
    }
  | {
      kind: "container";
      scope: DndScope;
      type: "timeline";
      staffId: DndStaffId;
      accepts: ReadonlyArray<AppDndSource["type"]>;
    }
  | {
      kind: "container";
      scope: DndScope;
      type: "summary";
      staffId: DndStaffId;
      accepts: ReadonlyArray<AppDndSource["type"]>;
    }
  | {
      kind: "container";
      scope: DndScope;
      type: "remove-zone";
      accepts: ReadonlyArray<AppDndSource["type"]>;
    };

export type DndInsertTarget = {
  containerId: UniqueIdentifier;
  container: AppDndContainer;
  index: number;
  isValid: boolean;
  reason?: string;
};

export type DndDropOperation =
  | {
      type: "noop";
    }
  | {
      type: "assign";
      taskIds: DndTaskId[];
      from: Extract<AppDndSource, { type: "priority" }>;
      to: Extract<AppDndContainer, { type: "timeline" }>;
      index: number;
    }
  | {
      type: "reorder";
      taskIds: DndTaskId[];
      in: Extract<AppDndSource, { type: "timeline" | "summary" }>;
      fromIndex: number;
      toIndex: number;
    }
  | {
      type: "reassign";
      taskIds: DndTaskId[];
      from: Extract<AppDndSource, { type: "timeline" | "summary" }>;
      to: Extract<AppDndContainer, { type: "timeline" | "summary" }>;
      index: number;
    }
  | {
      type: "remove";
      taskIds: DndTaskId[];
      from: Extract<AppDndSource, { type: "timeline" | "summary" }>;
      to: Extract<AppDndContainer, { type: "priority" | "remove-zone" }>;
    };

export type DndSortableRect = {
  id: UniqueIdentifier;
  index: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};

export const isAppDndItem = (value: unknown): value is AppDndItem => {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<AppDndItem>).kind === "task"
  );
};

export const isAppDndContainer = (value: unknown): value is AppDndContainer => {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<AppDndContainer>).kind === "container"
  );
};
