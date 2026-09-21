export const LOGISTICS_START_CHOICE_AUTO = "auto";

export interface LogisticsZoneStartTaskOption {
  taskId: number;
  logisticCode: number;
  address: string | null;
  priority: string | null;
}

export interface LogisticsDriverZoneStartChoice {
  driverId: number;
  driverName: string;
  zoneLabel: string;
  zoneColor: string;
  tasks: LogisticsZoneStartTaskOption[];
}

export interface LogisticsZoneStartPlan {
  workDate: string;
  drivers: LogisticsDriverZoneStartChoice[];
}

export type LogisticsPreferredStartsPayload = Record<string, number>;

export function parsePreferredStartByDriverId(
  raw: unknown
): Map<number, number> {
  const map = new Map<number, number>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return map;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const driverId = Number(key);
    const taskId = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(driverId) || driverId <= 0) continue;
    if (!Number.isFinite(taskId) || taskId <= 0) continue;
    map.set(driverId, taskId);
  }
  return map;
}

export function formatLogisticsDriverDisplayName(args: {
  id: number;
  name?: string | null;
  lastname?: string | null;
  operationalCode?: string | null;
}): string {
  const full = [args.name, args.lastname]
    .map((part) => String(part ?? "").trim())
    .filter((part) => part.length > 0)
    .join(" ");
  if (full) return full;
  const code = String(args.operationalCode ?? "").trim();
  if (code) return code;
  return `Autista ${args.id}`;
}
