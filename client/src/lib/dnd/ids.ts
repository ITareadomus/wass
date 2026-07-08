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

export type ParsedTaskDndId = {
  kind: "task";
  scope: DndScope;
  taskId: DndTaskId;
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
) => {
  const segments = ["task", scope, encodeSegment(taskId)];
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

export const parseDndId = (id: string): ParsedDndId | null => {
  const [kind, rawScope, type, value, staffMarker, rawStaffId] =
    id.split(SEPARATOR);
  const scope = parseScope(rawScope);
  if (!scope) return null;

  if (kind === "task") {
    if (!type) return null;
    const parsed: ParsedTaskDndId = {
      kind: "task",
      scope,
      taskId: decodeSegment(type),
    };
    if (staffMarker === "staff") {
      const staffId = parseStaffId(rawStaffId);
      if (staffId === null) return null;
      parsed.staffId = staffId;
    }
    return parsed;
  }

  if (kind !== "container") return null;

  if (type === "priority") {
    const key = parsePriorityKey(value);
    if (!key) return null;
    return { kind: "container", scope, type, key };
  }

  if (type === "timeline" || type === "summary") {
    const staffId = parseStaffId(value);
    if (staffId === null) return null;
    return { kind: "container", scope, type, staffId };
  }

  if (type === "remove-zone") {
    return { kind: "container", scope, type };
  }

  return null;
};
