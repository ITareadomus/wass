import type {
  DndPriorityKey,
  DndScope,
  DndStaffId,
  DndTaskId,
} from "./types";

const SEPARATOR = ":";

const encodeSegment = (value: string | number) =>
  encodeURIComponent(String(value));

const decodeSegment = (value: string) => decodeURIComponent(value);

export type DndTaskSurface = "priority" | "timeline" | "summary";

export type ParsedTaskDndId = {
  kind: "task";
  scope: DndScope;
  taskId: DndTaskId;
  surface?: DndTaskSurface;
  staffId?: DndStaffId;
};

export type ParsedContainerDndId =
  | {
      kind: "container";
      scope: DndScope;
      type: "priority";
      key: DndPriorityKey;
    }
  | {
      kind: "container";
      scope: DndScope;
      type: "timeline" | "summary";
      staffId: DndStaffId;
    }
  | {
      kind: "container";
      scope: DndScope;
      type: "remove-zone";
    };

export type ParsedDndId = ParsedTaskDndId | ParsedContainerDndId;

export const taskDndId = (
  scope: DndScope,
  taskId: DndTaskId | number,
  staffId?: DndStaffId,
  surface?: DndTaskSurface,
) => {
  const resolvedSurface =
    surface ?? (staffId !== undefined ? "timeline" : "priority");

  const segments = ["task", scope, resolvedSurface, encodeSegment(taskId)];

  if (staffId !== undefined) {
    segments.push("staff", encodeSegment(staffId));
  }

  return segments.join(SEPARATOR);
};

export const priorityContainerDndId = (
  scope: DndScope,
  key: DndPriorityKey,
) => ["container", scope, "priority", key].join(SEPARATOR);

export const timelineContainerDndId = (
  scope: DndScope,
  staffId: DndStaffId,
) => ["container", scope, "timeline", encodeSegment(staffId)].join(SEPARATOR);

export const summaryContainerDndId = (
  scope: DndScope,
  staffId: DndStaffId,
) => ["container", scope, "summary", encodeSegment(staffId)].join(SEPARATOR);

export const removeZoneContainerDndId = (scope: DndScope) =>
  ["container", scope, "remove-zone"].join(SEPARATOR);

const parseScope = (value: string | undefined): DndScope | null => {
  if (value === "housekeeping" || value === "logistics") return value;
  return null;
};

const parsePriorityKey = (value: string | undefined): DndPriorityKey | null => {
  if (
    value === "early_out" ||
    value === "high_priority" ||
    value === "low_priority"
  ) {
    return value;
  }
  return null;
};

const parseStaffId = (value: string | undefined): DndStaffId | null => {
  if (!value) return null;
  const staffId = Number(decodeSegment(value));
  return Number.isFinite(staffId) ? staffId : null;
};

const parseTaskSurface = (
  value: string | undefined,
): DndTaskSurface | null => {
  if (value === "priority" || value === "timeline" || value === "summary") {
    return value;
  }
  return null;
};

export const parseDndId = (id: string): ParsedDndId | null => {
  const [kind, rawScope, segment3, segment4, staffMarker, rawStaffId] =
    id.split(SEPARATOR);
  const scope = parseScope(rawScope);
  if (!scope) return null;

  if (kind === "task") {
    const surface = parseTaskSurface(segment3);
    if (surface) {
      if (!segment4) return null;
      const parsed: ParsedTaskDndId = {
        kind: "task",
        scope,
        surface,
        taskId: decodeSegment(segment4),
      };
      if (staffMarker === "staff") {
        const staffId = parseStaffId(rawStaffId);
        if (staffId === null) return null;
        parsed.staffId = staffId;
      }
      return parsed;
    }

    if (!segment3) return null;
    const parsed: ParsedTaskDndId = {
      kind: "task",
      scope,
      taskId: decodeSegment(segment3),
    };
    if (segment4 === "staff") {
      const staffId = parseStaffId(staffMarker);
      if (staffId === null) return null;
      parsed.staffId = staffId;
    }
    return parsed;
  }

  if (kind !== "container") return null;

  if (segment3 === "priority") {
    const key = parsePriorityKey(segment4);
    if (!key) return null;
    return { kind: "container", scope, type: segment3, key };
  }

  if (segment3 === "timeline" || segment3 === "summary") {
    const staffId = parseStaffId(segment4);
    if (staffId === null) return null;
    return { kind: "container", scope, type: segment3, staffId };
  }

  if (segment3 === "remove-zone") {
    return { kind: "container", scope, type: segment3 };
  }

  return null;
};
