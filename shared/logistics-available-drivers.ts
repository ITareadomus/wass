import { resolveLogisticsLaneStaffId } from "./logistics-removed-leftover";

export function collectLiveLogisticsDriverIds(
  drivers: Array<{ id: number; isRemoved?: boolean; leftoverLane?: boolean }>,
  assignments: Array<{
    driver?: { id?: number; isRemoved?: boolean; leftoverLane?: boolean };
    tasks?: unknown[];
  }>
): number[] {
  const ids = new Set<number>();
  for (const driver of drivers) {
    const id = Number(driver.id);
    if (!Number.isFinite(id) || driver.isRemoved || driver.leftoverLane) continue;
    const lane = resolveLogisticsLaneStaffId(id);
    if (lane.leftoverLane) continue;
    ids.add(lane.driverId);
  }
  for (const row of assignments) {
    const id = Number(row.driver?.id);
    if (!Number.isFinite(id) || row.driver?.isRemoved || row.driver?.leftoverLane) continue;
    const lane = resolveLogisticsLaneStaffId(id);
    if (lane.leftoverLane) continue;
    if ((row.tasks?.length || 0) > 0) ids.add(lane.driverId);
  }
  return [...ids];
}

export function filterLogisticsDriversAvailableToAssign<T extends { id: number; active?: boolean }>(
  roster: T[],
  liveDriverIds: Iterable<number>,
  replaceDriverId?: number | null
): T[] {
  const live = new Set(
    [...liveDriverIds].map((id) => Number(id)).filter((id) => Number.isFinite(id))
  );

  return roster.filter((driver) => {
    if (driver.active === false) return false;
    const id = Number(driver.id);
    if (!Number.isFinite(id)) return false;
    return !live.has(id);
  });
}
