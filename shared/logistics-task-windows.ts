import { formatClockLabel } from "./clock-display";
import { minutesToHm } from "./logistics-scheduling-constraints";

export function formatHmTime(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
  }

  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{1,3}):(\d{2})/);
  if (!match) return null;
  return formatClockLabel(`${match[1]}:${match[2]}`);
}

export function formatWorkWindowLabel(start: unknown, end: unknown): string {
  const startLabel = formatHmTime(start);
  const endLabel = formatHmTime(end);
  if (startLabel && endLabel) return `${startLabel} - ${endLabel}`;
  return "-";
}

export function formatMinutesWorkWindowLabel(earliestMin: number, latestMin: number): string {
  if (!Number.isFinite(earliestMin) || !Number.isFinite(latestMin) || latestMin < earliestMin) {
    return "-";
  }
  return `${minutesToHm(earliestMin)} - ${minutesToHm(latestMin)}`;
}
