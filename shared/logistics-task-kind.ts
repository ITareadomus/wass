export type LogisticsTaskKind = "pick-up" | "delivery" | "delivery/pick-up";

export type LogisticsTaskKindSource = "auto" | "manual";

export interface ResolveLogisticsTaskKindInput {
  cleanerId?: number | null;
  cleanerSequence?: number | null;
  premium?: boolean | null;
  paxIn?: number | null;
  logisticsTaskKind?: LogisticsTaskKind | string | null;
  logisticsTaskKindSource?: LogisticsTaskKindSource | null;
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Normalizza valori persistiti (legacy `delivery` auto → D&P). */
export function normalizeLogisticsTaskKind(
  value: unknown,
  source?: LogisticsTaskKindSource | string | null
): LogisticsTaskKind | null {
  const raw = String(value ?? "").trim();
  if (raw === "pick-up") return "pick-up";
  if (raw === "delivery/pick-up") return "delivery/pick-up";
  if (raw === "delivery") {
    return source === "manual" ? "delivery" : "delivery/pick-up";
  }
  return null;
}

export function isCleanerHasBag(params: {
  cleanerSequence: number | null;
  isPremium: boolean;
  paxIn: number | null;
}): boolean {
  if (params.cleanerSequence !== 1) return false;
  if (params.isPremium) return false;
  const paxIn = params.paxIn ?? 0;
  return paxIn <= 4;
}

export function resolveAutoLogisticsTaskKind(input: {
  cleanerId?: number | null;
  cleanerSequence?: number | null;
  premium?: boolean | null;
  paxIn?: number | null;
}): Exclude<LogisticsTaskKind, "delivery"> | null {
  const cleanerId = toFiniteNumber(input.cleanerId);
  const cleanerSequence = toFiniteNumber(input.cleanerSequence);
  if (cleanerId === null || cleanerSequence === null) return null;

  const isPremium = input.premium === true;
  const paxIn = toFiniteNumber(input.paxIn) ?? 0;

  return isCleanerHasBag({ cleanerSequence, isPremium, paxIn }) ? "pick-up" : "delivery/pick-up";
}

export function requiresDriverBeforeCleaner(kind: LogisticsTaskKind | null): boolean {
  return kind === "delivery/pick-up";
}

/**
 * Codice per ADAM `app_housekeeping.lg_operation` (VARCHAR(10)):
 * `1` = delivery, `2` = pick-up, `3` = delivery/pick-up (D&P).
 */
export type AdamLogisticsOperationCode = "1" | "2" | "3";

export function toAdamLogisticsOperation(
  kind: LogisticsTaskKind | string | null | undefined
): AdamLogisticsOperationCode | null {
  switch (normalizeLogisticsTaskKind(kind, "manual")) {
    case "delivery":
      return "1";
    case "pick-up":
      return "2";
    case "delivery/pick-up":
      return "3";
    default:
      return null;
  }
}

export function fromAdamLogisticsOperation(value: unknown): LogisticsTaskKind | null {
  const raw = String(value ?? "").trim().toLowerCase();
  // Numeric codes written by WASS → ADAM.
  if (raw === "1") return "delivery";
  if (raw === "2") return "pick-up";
  if (raw === "3") return "delivery/pick-up";
  // Legacy textual codes (pre-numeric mapping).
  if (raw === "d&p") return "delivery/pick-up";
  return normalizeLogisticsTaskKind(raw, "manual");
}

export function resolveLogisticsTaskKind(
  input: ResolveLogisticsTaskKindInput
): LogisticsTaskKind | null {
  const persistedKind = normalizeLogisticsTaskKind(
    input.logisticsTaskKind,
    input.logisticsTaskKindSource
  );
  if (input.logisticsTaskKindSource === "manual" && persistedKind) {
    return persistedKind;
  }

  if (persistedKind) {
    return persistedKind;
  }

  return resolveAutoLogisticsTaskKind(input);
}

export function buildManualLogisticsTaskKindPayload(kind: LogisticsTaskKind): {
  logistics_task_kind: LogisticsTaskKind;
  logistics_task_kind_source: "manual";
} {
  return {
    logistics_task_kind: kind,
    logistics_task_kind_source: "manual",
  };
}

export function buildLogisticsTaskKindPayload(
  input: ResolveLogisticsTaskKindInput
): Partial<{
  logistics_task_kind: LogisticsTaskKind;
  logistics_task_kind_source: LogisticsTaskKindSource;
}> {
  if (input.logisticsTaskKindSource === "manual") {
    const manualKind = normalizeLogisticsTaskKind(
      input.logisticsTaskKind,
      "manual"
    );
    if (manualKind) {
      return buildManualLogisticsTaskKindPayload(manualKind);
    }
  }

  const kind = resolveLogisticsTaskKind(input);
  if (!kind) return {};

  return {
    logistics_task_kind: kind,
    logistics_task_kind_source: "auto",
  };
}

export function logisticsTaskKindBadge(kind: LogisticsTaskKind): {
  text: string;
  className: string;
} {
  if (kind === "delivery/pick-up") {
    return {
      text: "D&P",
      className:
        "bg-purple-500/30 text-purple-800 dark:bg-purple-500/40 dark:text-purple-200 border-purple-600 dark:border-purple-400",
    };
  }

  if (kind === "delivery") {
    return {
      text: "DELIVERY",
      className:
        "bg-purple-500/30 text-purple-800 dark:bg-purple-500/40 dark:text-purple-200 border-purple-600 dark:border-purple-400",
    };
  }

  return {
    text: "PICK-UP",
    className:
      "bg-sky-500/30 text-sky-800 dark:bg-sky-500/40 dark:text-sky-200 border-sky-600 dark:border-sky-400",
  };
}

export interface LogisticsContainerKindPatch {
  taskId: number;
  logistics_task_kind: LogisticsTaskKind;
  logistics_task_kind_source: "auto";
}

export function buildLogisticsContainerAutoKindPatches(
  rows: Array<{
    task_id: number;
    logistics_task_kind: string | null;
    logistics_task_kind_source: string | null;
  }>,
  enrichedTasksById: Map<
    number,
    { logistics_task_kind?: string | null; logistics_task_kind_source?: string | null }
  >
): LogisticsContainerKindPatch[] {
  const patches: LogisticsContainerKindPatch[] = [];

  for (const row of rows) {
    if (row.logistics_task_kind_source === "manual") continue;

    const taskId = Number(row.task_id);
    const enriched = enrichedTasksById.get(taskId);
    if (!enriched?.logistics_task_kind || enriched.logistics_task_kind_source !== "auto") {
      continue;
    }

    const nextKind = normalizeLogisticsTaskKind(enriched.logistics_task_kind, "auto");
    if (!nextKind) continue;

    const currentKind =
      row.logistics_task_kind != null ? String(row.logistics_task_kind) : null;
    const currentSource =
      row.logistics_task_kind_source != null
        ? String(row.logistics_task_kind_source)
        : null;

    if (currentKind === nextKind && currentSource === "auto") continue;

    patches.push({
      taskId,
      logistics_task_kind: nextKind,
      logistics_task_kind_source: "auto",
    });
  }

  return patches;
}
