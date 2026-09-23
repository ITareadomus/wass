export const LG_REMOVED_LEFTOVER_REASON = "lg_removed_leftover";
export const LG_LEFTOVER_LANE_OFFSET = 1_000_000_000;

export function isLogisticsRemovedLeftoverTask(task: any): boolean {
  return Array.isArray(task?.reasons) && task.reasons.includes(LG_REMOVED_LEFTOVER_REASON);
}

export function markLogisticsRemovedLeftoverTaskInPlace(task: any): void {
  if (!task || typeof task !== "object") return;
  const reasons = Array.isArray(task.reasons) ? task.reasons : [];
  if (!reasons.includes(LG_REMOVED_LEFTOVER_REASON)) {
    task.reasons = [...reasons, LG_REMOVED_LEFTOVER_REASON];
  }
}

export function clearLogisticsRemovedLeftoverTaskInPlace(task: any): void {
  if (!task || !Array.isArray(task.reasons)) return;
  task.reasons = task.reasons.filter((reason: string) => reason !== LG_REMOVED_LEFTOVER_REASON);
}

export function logisticsLeftoverLaneStaffId(driverId: number): number {
  return LG_LEFTOVER_LANE_OFFSET + Number(driverId);
}

export function logisticsLaneStaffId(driver: { id: number; leftoverLane?: boolean }): number {
  return driver.leftoverLane ? logisticsLeftoverLaneStaffId(Number(driver.id)) : Number(driver.id);
}

export function markUnselectedLogisticsAssignmentsLeftover(
  assignments: Array<{ driver?: { id?: number }; tasks?: any[] }> | null | undefined,
  selectedIds: Iterable<number>
): boolean {
  const selected = new Set(
    [...selectedIds].map((id) => Number(id)).filter((id) => Number.isFinite(id))
  );
  let changed = false;
  for (const row of assignments || []) {
    const driverId = Number(row.driver?.id);
    if (!Number.isFinite(driverId) || selected.has(driverId)) continue;
    for (const task of row.tasks || []) {
      if (!isLogisticsRemovedLeftoverTask(task)) {
        markLogisticsRemovedLeftoverTaskInPlace(task);
        changed = true;
      }
    }
  }
  return changed;
}

export function resolveLogisticsLaneStaffId(staffId: number): {
  driverId: number;
  leftoverLane: boolean;
} {
  const id = Number(staffId);
  if (Number.isFinite(id) && id >= LG_LEFTOVER_LANE_OFFSET) {
    return { driverId: id - LG_LEFTOVER_LANE_OFFSET, leftoverLane: true };
  }
  return { driverId: id, leftoverLane: false };
}

export function logisticsDriverLaneKey(driver: { id: number; leftoverLane?: boolean }): string {
  return driver.leftoverLane ? `removed-${driver.id}` : String(driver.id);
}

export function splitLogisticsAssignmentLanes<
  T extends { driver?: { id?: number; isRemoved?: boolean }; tasks?: any[] },
>(assignments: T[]): T[] {
  const out: T[] = [];
  for (const row of assignments) {
    const tasks = Array.isArray(row.tasks) ? row.tasks : [];
    const leftover = tasks.filter(isLogisticsRemovedLeftoverTask);
    const live = tasks.filter((task) => !isLogisticsRemovedLeftoverTask(task));
    if (leftover.length > 0 && live.length > 0) {
      out.push({ ...row, tasks: live });
      out.push({
        ...row,
        tasks: leftover,
        driver: { ...(row.driver as object), isRemoved: true, leftoverLane: true },
      });
      continue;
    }
    if (leftover.length > 0) {
      if (!(row.driver as { isRemoved?: boolean } | undefined)?.isRemoved) {
        out.push({ ...row, tasks: live });
      }
      out.push({
        ...row,
        tasks: leftover,
        driver: { ...(row.driver as object), isRemoved: true, leftoverLane: true },
      });
      continue;
    }
    out.push(row);
  }
  return out;
}
