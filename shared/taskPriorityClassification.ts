export type Priority = "EO" | "HP" | "LP";
export type ContainerPriority = "early_out" | "high_priority" | "low_priority";
export type DedupeStrategy = "eo_wins" | "hp_wins";

export interface PriorityWindow {
  startMin: number;
  endMin: number | null;
  graceMin: number;
}

export type PriorityWindows = Record<Priority, PriorityWindow>;

export interface PriorityClassificationSettings {
  globalStartTime: string;
  globalStartMin: number;
  hpStartTime: string;
  hpEndTime: string;
  hpStartMin: number;
  hpEndMin: number;
  eoClients: string[];
  hpClients: string[];
  dedupeStrategy: DedupeStrategy;
}

export interface ClassifyTaskInput {
  client_id?: unknown;
  clientId?: unknown;
  premium?: unknown;
  isPremium?: unknown;
  checkout_time?: unknown;
  checkoutTime?: unknown;
  checkin_time?: unknown;
  checkinTime?: unknown;
  checkout_date?: unknown;
  checkoutDate?: unknown;
  checkin_date?: unknown;
  checkinDate?: unknown;
}

export interface PriorityMatchReasons {
  eoMatch: boolean;
  hpMatch: boolean;
  eoReasons: string[];
  hpReasons: string[];
}

export class PrioritySettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrioritySettingsError";
  }
}

const HM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const HMS_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

function parseSettingsTime(value: unknown, key: string): { raw: string; minutes: number } {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PrioritySettingsError(`${key} is required for priority classification`);
  }

  const trimmed = value.trim();
  const match = HM_PATTERN.exec(trimmed);
  if (!match) {
    throw new PrioritySettingsError(`${key} must use HH:mm format`);
  }

  return {
    raw: trimmed,
    minutes: Number(match[1]) * 60 + Number(match[2]),
  };
}

export function parseTaskTimeToMinutes(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;

  const match = HMS_PATTERN.exec(value.trim());
  if (!match) return null;

  return Number(match[1]) * 60 + Number(match[2]);
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim().slice(0, 10);
}

function normalizeClientId(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value).trim();
}

function normalizeClientList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .map(normalizeClientId)
    .filter((clientId): clientId is string => Boolean(clientId));
}

function normalizeBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  return false;
}

export function parsePrioritySettings(appSettingsRaw: unknown): PriorityClassificationSettings {
  if (!appSettingsRaw || typeof appSettingsRaw !== "object") {
    throw new PrioritySettingsError("app_settings is required for priority classification");
  }

  const appSettings = appSettingsRaw as Record<string, any>;
  const highPriority = appSettings["high-priority"] ?? {};
  const earlyOut = appSettings["early-out"] ?? {};

  const globalStartRaw =
    typeof highPriority.global_start_time === "string" && highPriority.global_start_time.trim() !== ""
      ? highPriority.global_start_time
      : highPriority.hp_start_time;
  const globalStart = parseSettingsTime(
    globalStartRaw,
    "high-priority.global_start_time (or high-priority.hp_start_time for backward compatibility)"
  );
  const hpEnd = parseSettingsTime(highPriority.hp_end_time, "high-priority.hp_end_time");

  if (hpEnd.minutes < globalStart.minutes) {
    throw new PrioritySettingsError(
      "high-priority.hp_end_time must be greater than or equal to high-priority.global_start_time"
    );
  }

  const dedupeStrategy = appSettings.dedupe_strategy;
  if (dedupeStrategy !== "eo_wins" && dedupeStrategy !== "hp_wins") {
    throw new PrioritySettingsError("dedupe_strategy must be either eo_wins or hp_wins");
  }

  return {
    globalStartTime: globalStart.raw,
    globalStartMin: globalStart.minutes,
    hpStartTime: globalStart.raw,
    hpEndTime: hpEnd.raw,
    hpStartMin: globalStart.minutes,
    hpEndMin: hpEnd.minutes,
    eoClients: normalizeClientList(earlyOut.eo_clients),
    hpClients: normalizeClientList(highPriority.hp_clients),
    dedupeStrategy,
  };
}

export function getPriorityMatchReasons(
  task: ClassifyTaskInput,
  settings: PriorityClassificationSettings
): PriorityMatchReasons {
  const clientId = normalizeClientId(task.client_id ?? task.clientId);
  const checkoutTime = parseTaskTimeToMinutes(task.checkout_time ?? task.checkoutTime);
  const checkinTime = parseTaskTimeToMinutes(task.checkin_time ?? task.checkinTime);
  const checkoutDate = normalizeDate(task.checkout_date ?? task.checkoutDate);
  const checkinDate = normalizeDate(task.checkin_date ?? task.checkinDate);
  const isPremium = normalizeBoolean(task.premium ?? task.isPremium);

  const eoClientSet = new Set(settings.eoClients);
  const hpClientSet = new Set(settings.hpClients);
  const eoReasons: string[] = [];
  const hpReasons: string[] = [];

  if (checkoutTime !== null && checkoutTime < settings.globalStartMin) {
    eoReasons.push("checkout_before_hp_start");
  }

  if (clientId !== null && eoClientSet.has(clientId)) {
    eoReasons.push("client_forced_eo");
  }

  if (isPremium) {
    hpReasons.push("premium");
  }

  if (clientId !== null && hpClientSet.has(clientId)) {
    hpReasons.push("client_forced_hp");
  }

  const sameDayCheckinCheckout =
    checkinDate !== null &&
    checkoutDate !== null &&
    checkinDate === checkoutDate;

  if (
    sameDayCheckinCheckout &&
    checkinTime !== null &&
    checkinTime >= settings.globalStartMin &&
    checkinTime <= settings.hpEndMin
  ) {
    hpReasons.push("same_day_checkin_between_hp_start_hp_end");
  }

  return {
    eoMatch: eoReasons.length > 0,
    hpMatch: hpReasons.length > 0,
    eoReasons,
    hpReasons,
  };
}

export function classifyTaskPriority(
  task: ClassifyTaskInput,
  settings: PriorityClassificationSettings
): Priority {
  const { eoMatch, hpMatch } = getPriorityMatchReasons(task, settings);

  if (eoMatch && hpMatch) {
    return settings.dedupeStrategy === "eo_wins" ? "EO" : "HP";
  }

  if (eoMatch) return "EO";
  if (hpMatch) return "HP";
  return "LP";
}

export function priorityToContainerFormat(priority: Priority): ContainerPriority {
  if (priority === "EO") return "early_out";
  if (priority === "HP") return "high_priority";
  return "low_priority";
}

export function priorityToDbFormat(priority: Priority): ContainerPriority {
  return priorityToContainerFormat(priority);
}

export function buildSchedulingWindows(settings: PriorityClassificationSettings): PriorityWindows {
  return {
    EO: {
      startMin: 0,
      endMin: Math.max(0, settings.globalStartMin - 1),
      graceMin: 0,
    },
    HP: {
      startMin: settings.globalStartMin,
      endMin: settings.hpEndMin,
      graceMin: 0,
    },
    LP: {
      startMin: settings.globalStartMin,
      endMin: null,
      graceMin: 0,
    },
  };
}
