import * as workspaceFiles from "../workspace-files";
import { pgDailyAssignmentsService } from "../pg-daily-assignments-service";
import { parsePreAssignedTimelineEntries } from "./timeline-assignment-hints";

export const AUTO_CONVOKED_PREASSIGNED_ACTION = "AUTO_CONVOKED_PREASSIGNED" as const;

export interface AutoConvokeLogisticsDriversResult {
  workDate: string;
  autoConvokedDriverIds: number[];
  alreadySelectedDriverIds: number[];
  missingInDbDriverIds: number[];
  saved: boolean;
}

export interface AutoConvokeLogisticsDriversOptions {
  performedBy?: string;
  saveSelectedDrivers?: boolean;
}

export interface AutoConvokeDriverPlan {
  autoConvokedDriverIds: number[];
  missingInDbDriverIds: number[];
  mergedDriverIds: number[];
}

export function computeAutoConvokeDriverPlan(args: {
  timelineDriverIds: number[];
  selectedDriverIds: number[];
  foundInDbDriverIds: number[];
}): AutoConvokeDriverPlan {
  const selectedSet = new Set(args.selectedDriverIds);
  const foundInDbSet = new Set(args.foundInDbDriverIds);
  const autoConvokedDriverIds = args.timelineDriverIds.filter((driverId) => !selectedSet.has(driverId));
  const missingInDbDriverIds = autoConvokedDriverIds.filter((driverId) => !foundInDbSet.has(driverId));
  const convokableDriverIds = autoConvokedDriverIds.filter((driverId) => foundInDbSet.has(driverId));
  const mergedDriverIds = [...args.selectedDriverIds];

  for (const driverId of convokableDriverIds) {
    if (!mergedDriverIds.includes(driverId)) {
      mergedDriverIds.push(driverId);
    }
  }

  return {
    autoConvokedDriverIds: convokableDriverIds,
    missingInDbDriverIds,
    mergedDriverIds,
  };
}

function buildDriverPayloadFromRow(id: number, row: any | undefined) {
  const startTime = row?.start_time ?? "10:00";
  const endTime = row?.end_time ?? "20:00";
  return {
    id,
    name: row?.name ?? "Driver",
    lastname: row?.lastname ?? String(id),
    role: row?.role ?? "Driver",
    premium: row?.role === "Premium",
    start_time: startTime,
    end_time: endTime,
    active: row?.active !== false,
    available: row?.available !== false,
    counter_hours: row?.counter_hours ?? 0,
    counter_days: row?.counter_days ?? 0,
    contract_type: row?.contract_type ?? null,
    alias: row?.alias ?? undefined,
    assigned_vehicle_id: null as number | null,
    assigned_vehicle_name: null as string | null,
    assigned_vehicle_pms_code: null as string | null,
    assigned_vehicle_task_id: null as number | null,
  };
}

function mergeSelectedDriverPayloads(
  existingDrivers: any[],
  mergedDriverIds: number[],
  rowsById: Map<number, any>
): any[] {
  const existingById = new Map<number, any>(
    existingDrivers
      .map((driver) => [Number(driver?.id), driver] as const)
      .filter(([id]) => Number.isFinite(id))
  );

  return mergedDriverIds.map((driverId) => {
    const existing = existingById.get(driverId);
    if (existing) return existing;
    return buildDriverPayloadFromRow(driverId, rowsById.get(driverId));
  });
}

export async function autoConvokeLogisticsDriversWithPreAssignedTasks(
  workDate: string,
  options: AutoConvokeLogisticsDriversOptions = {}
): Promise<AutoConvokeLogisticsDriversResult> {
  const saveSelectedDrivers = options.saveSelectedDrivers !== false;
  const performedBy = options.performedBy ?? "logistics-optimizer-final";

  const timeline = await workspaceFiles.loadLogisticsTimeline(workDate);
  const { driverIdsWithPreAssignedTasks } = parsePreAssignedTimelineEntries(timeline);

  const selectedData = (await workspaceFiles.loadSelectedLogisticsDrivers(workDate)) ?? {
    drivers: [],
    total_selected: 0,
  };
  const existingDrivers = Array.isArray(selectedData.drivers) ? selectedData.drivers : [];
  const alreadySelectedDriverIds = existingDrivers
    .map((driver: any) => Number(driver?.id))
    .filter((id: number) => Number.isFinite(id));

  const timelineDriverIds = driverIdsWithPreAssignedTasks;
  const missingFromSelected = timelineDriverIds.filter(
    (driverId) => !alreadySelectedDriverIds.includes(driverId)
  );

  if (missingFromSelected.length === 0) {
    return {
      workDate,
      autoConvokedDriverIds: [],
      alreadySelectedDriverIds,
      missingInDbDriverIds: [],
      saved: false,
    };
  }

  const rows = await pgDailyAssignmentsService.loadLgDriversByIds(missingFromSelected, workDate);
  const rowsById = new Map<number, any>((rows || []).map((row: any) => [Number(row.id), row]));
  const foundInDbDriverIds = missingFromSelected.filter((driverId) => rowsById.has(driverId));

  const plan = computeAutoConvokeDriverPlan({
    timelineDriverIds,
    selectedDriverIds: alreadySelectedDriverIds,
    foundInDbDriverIds,
  });

  if (plan.autoConvokedDriverIds.length === 0) {
    return {
      workDate,
      autoConvokedDriverIds: [],
      alreadySelectedDriverIds,
      missingInDbDriverIds: plan.missingInDbDriverIds,
      saved: false,
    };
  }

  if (!saveSelectedDrivers) {
    return {
      workDate,
      autoConvokedDriverIds: plan.autoConvokedDriverIds,
      alreadySelectedDriverIds,
      missingInDbDriverIds: plan.missingInDbDriverIds,
      saved: false,
    };
  }

  const mergedDrivers = mergeSelectedDriverPayloads(existingDrivers, plan.mergedDriverIds, rowsById);
  const saved = await workspaceFiles.saveSelectedLogisticsDrivers(
    workDate,
    {
      drivers: mergedDrivers,
      total_selected: mergedDrivers.length,
      metadata: { date: workDate },
    },
    false,
    performedBy,
    AUTO_CONVOKED_PREASSIGNED_ACTION
  );

  if (!saved) {
    console.warn(
      `⚠️ auto-convoke logistics drivers failed to persist selected drivers for ${workDate}`
    );
  }

  if (plan.missingInDbDriverIds.length > 0) {
    console.warn(
      `⚠️ auto-convoke logistics: timeline references drivers missing from lg_drivers: ${plan.missingInDbDriverIds.join(", ")}`
    );
  }

  return {
    workDate,
    autoConvokedDriverIds: plan.autoConvokedDriverIds,
    alreadySelectedDriverIds,
    missingInDbDriverIds: plan.missingInDbDriverIds,
    saved,
  };
}
