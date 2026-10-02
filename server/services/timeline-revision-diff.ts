export type TaskTier = "premium" | "standard" | "straordinaria";

export type AssignmentSnap = {
  taskId: number;
  label: string;
  staffId: number;
  staffLabel: string;
  sequence: number;
  startTime: string;
  endTime: string;
  tier: TaskTier;
};

export type AssignmentChange = {
  kind: "added" | "removed" | "moved" | "reordered";
  task: string;
  tier: TaskTier;
  from?: string;
  to?: string;
  fromSequence?: number;
  toSequence?: number;
};

export function diffAssignmentSnapshots(
  before: AssignmentSnap[] | null,
  after: AssignmentSnap[],
): AssignmentChange[] {
  if (!before) return [];

  const previous = indexByTask(before);
  const next = indexByTask(after);
  const ids = new Set<number>([...previous.keys(), ...next.keys()]);
  const changes: AssignmentChange[] = [];

  for (const taskId of ids) {
    const from = previous.get(taskId);
    const to = next.get(taskId);
    if (!from && to) {
      changes.push({ kind: "added", task: to.label, tier: to.tier, to: to.staffLabel, toSequence: to.sequence });
      continue;
    }
    if (from && !to) {
      changes.push({ kind: "removed", task: from.label, tier: from.tier, from: from.staffLabel, fromSequence: from.sequence });
      continue;
    }
    if (!from || !to) continue;
    if (from.staffId !== to.staffId) {
      changes.push({
        kind: "moved",
        task: to.label,
        tier: to.tier,
        from: from.staffLabel,
        to: to.staffLabel,
        fromSequence: from.sequence,
        toSequence: to.sequence,
      });
      continue;
    }
    if (from.sequence !== to.sequence) {
      changes.push({
        kind: "reordered",
        task: to.label,
        tier: to.tier,
        from: from.staffLabel,
        fromSequence: from.sequence,
        toSequence: to.sequence,
      });
    }
  }

  const kindOrder = { moved: 0, added: 1, removed: 2, reordered: 3 };
  return changes.sort(
    (a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.task.localeCompare(b.task, "it"),
  );
}

export function summarizeTimeChange(
  before: AssignmentSnap[] | null,
  after: AssignmentSnap[],
): { text: string; tier: TaskTier } | null {
  if (!before) return null;
  const previous = indexByTask(before);
  const changed: Array<{ from: AssignmentSnap; to: AssignmentSnap }> = [];
  for (const to of after) {
    const from = previous.get(to.taskId);
    if (!from) continue;
    if (clock(from.startTime) === clock(to.startTime) && clock(from.endTime) === clock(to.endTime)) continue;
    changed.push({ from, to });
  }
  if (changed.length === 0) return null;
  changed.sort((a, b) => a.to.sequence - b.to.sequence || a.to.label.localeCompare(b.to.label, "it"));
  const first = changed[0];
  const movedStart = first.from.startTime !== first.to.startTime;
  const line = movedStart
    ? `${first.to.label} dalle ${clock(first.from.startTime)} alle ${clock(first.to.startTime)}`
    : `${first.to.label} fine da ${clock(first.from.endTime)} a ${clock(first.to.endTime)}`;
  const text = changed.length > 1 ? `${line}, orari successivi aggiornati` : line;
  return { text, tier: first.to.tier };
}

function clock(value: string): string {
  const match = /^(\d{1,2}:\d{2})/.exec(value.trim());
  return match ? match[1] : value.trim() || "—";
}

function indexByTask(rows: AssignmentSnap[]): Map<number, AssignmentSnap> {
  const map = new Map<number, AssignmentSnap>();
  for (const row of rows) map.set(row.taskId, row);
  return map;
}
