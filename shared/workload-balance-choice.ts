export type WorkloadBalanceChoice = {
  mode: "average" | "custom";
  targets: Array<{ cleanerId: number; minutes: number }>;
};

const MIN_MINUTES = 30;
const MAX_MINUTES = 14 * 60;

export function parseWorkloadBalanceChoice(value: unknown): WorkloadBalanceChoice {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const mode = raw.mode === "custom" ? "custom" : "average";
  const targets: WorkloadBalanceChoice["targets"] = [];
  if (Array.isArray(raw.targets)) {
    for (const row of raw.targets) {
      if (!row || typeof row !== "object") continue;
      const cleanerId = Number((row as { cleanerId?: unknown }).cleanerId);
      const minutes = Number((row as { minutes?: unknown }).minutes);
      if (!Number.isInteger(cleanerId) || cleanerId <= 0) continue;
      if (!Number.isFinite(minutes)) continue;
      const rounded = Math.round(minutes);
      if (rounded < MIN_MINUTES || rounded > MAX_MINUTES) continue;
      targets.push({ cleanerId, minutes: rounded });
    }
  }
  return { mode: targets.length > 0 ? mode : "average", targets };
}
