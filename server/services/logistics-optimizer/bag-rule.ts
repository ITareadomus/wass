export type LogisticsBagPolicy =
  | "NORMAL_TASK"
  | "DRIVER_BRINGS_BAG"
  | "CLEANER_HAS_BAG";

export interface ComputeBagPolicyInput {
  cleanerId?: number | null;
  sequence?: number | null;
  premium?: boolean | null;
  paxIn?: number | null;
}

function toFiniteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Il driver deve consegnare la borsone prima che inizi l'HK su quel task. */
export function requiresDriverBeforeCleaner(bagPolicy: LogisticsBagPolicy): boolean {
  return bagPolicy === "DRIVER_BRINGS_BAG";
}

export function computeBagPolicy(input: ComputeBagPolicyInput): LogisticsBagPolicy {
  const cleanerId = toFiniteNumber(input.cleanerId);
  const sequence = toFiniteNumber(input.sequence);
  const paxIn = toFiniteNumber(input.paxIn) ?? 0;
  const isPremium = input.premium === true;

  // Without cleaner or sequence this task follows normal behavior.
  if (cleanerId === null || sequence === null) return "NORMAL_TASK";
  if (sequence !== 1) return "NORMAL_TASK";
  if (isPremium || paxIn > 4) return "DRIVER_BRINGS_BAG";
  return "CLEANER_HAS_BAG";
}
