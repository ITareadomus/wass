export type ConstraintMode = "off" | "soft" | "hard";

export interface HkConstraintSettings {
  triadeCeiling: ConstraintMode;
  triadeMatch: ConstraintMode;
  triadeMatchBonus: number;
  triadeOverqualPenalty: number;
  phase4LevelBonus: number;
  phase4OverqualPenalty: number;
  travel: ConstraintMode;
  travelWeight: number;
  travelHardMaxMin: number;
  loadCap: ConstraintMode;
  /** Percentuale dei minuti medi della giornata. 125 = 125%. */
  loadCapPercent: number;
  taskCount: ConstraintMode;
  longOt: ConstraintMode;
  shortOt: ConstraintMode;
  officeRole: ConstraintMode;
  apartmentType: ConstraintMode;
  formatorePriority: ConstraintMode;
  formatoreStandard: ConstraintMode;
  priorityWindow: ConstraintMode;
  checkout: ConstraintMode;
  checkin: ConstraintMode;
  /** Preferire un carico di minuti simile tra i cleaner. */
  workloadBalance: ConstraintMode;
  shiftEnd: ConstraintMode;
  shortenRoutes: boolean;
  rebalanceLoads: boolean;
  phase5Iterations: number;
  fairnessIterations: number;
  triadSwap: boolean;
}

export const HK_SOFT_PENALTY = {
  triadeCeilingPerLevel: 15000,
  office: 40000,
  apartment: 12000,
  formatore: 12000,
  longOt: 25000,
  shortOt: 12000,
  taskCountExtra: 8000,
  loadPerMinute: 20,
  checkin: 40000,
  shiftEnd: 40000,
} as const;

const MODES: ConstraintMode[] = ["off", "soft", "hard"];

export const HK_CONSTRAINT_PRESETS = {
  balanced: {
    triadeCeiling: "hard",
    triadeMatch: "soft",
    triadeMatchBonus: 8000,
    triadeOverqualPenalty: 3000,
    phase4LevelBonus: 10000,
    phase4OverqualPenalty: 4000,
    travel: "soft",
    travelWeight: 2,
    travelHardMaxMin: 45,
    loadCap: "hard",
    loadCapPercent: 125,
    taskCount: "hard",
    longOt: "hard",
    shortOt: "hard",
    officeRole: "hard",
    apartmentType: "hard",
    formatorePriority: "hard",
    formatoreStandard: "hard",
    priorityWindow: "soft",
    checkout: "hard",
    checkin: "hard",
    workloadBalance: "soft",
    shiftEnd: "hard",
    shortenRoutes: true,
    rebalanceLoads: true,
    phase5Iterations: 80,
    fairnessIterations: 30,
    triadSwap: true,
  },
  triade: {
    triadeCeiling: "hard",
    triadeMatch: "soft",
    triadeMatchBonus: 20000,
    triadeOverqualPenalty: 8000,
    phase4LevelBonus: 80000,
    phase4OverqualPenalty: 20000,
    travel: "off",
    travelWeight: 0.5,
    travelHardMaxMin: 45,
    loadCap: "hard",
    loadCapPercent: 125,
    taskCount: "hard",
    longOt: "hard",
    shortOt: "hard",
    officeRole: "hard",
    apartmentType: "hard",
    formatorePriority: "hard",
    formatoreStandard: "hard",
    priorityWindow: "soft",
    checkout: "hard",
    checkin: "hard",
    workloadBalance: "soft",
    shiftEnd: "hard",
    shortenRoutes: false,
    rebalanceLoads: false,
    phase5Iterations: 0,
    fairnessIterations: 0,
    triadSwap: true,
  },
  distance: {
    triadeCeiling: "off",
    triadeMatch: "off",
    triadeMatchBonus: 0,
    triadeOverqualPenalty: 0,
    phase4LevelBonus: 0,
    phase4OverqualPenalty: 0,
    travel: "hard",
    travelWeight: 8,
    travelHardMaxMin: 45,
    loadCap: "hard",
    loadCapPercent: 125,
    taskCount: "hard",
    longOt: "hard",
    shortOt: "hard",
    officeRole: "hard",
    apartmentType: "hard",
    formatorePriority: "hard",
    formatoreStandard: "hard",
    priorityWindow: "soft",
    checkout: "hard",
    checkin: "hard",
    workloadBalance: "soft",
    shiftEnd: "hard",
    shortenRoutes: true,
    rebalanceLoads: true,
    phase5Iterations: 80,
    fairnessIterations: 30,
    triadSwap: false,
  },
} as const satisfies Record<string, HkConstraintSettings>;

export type HkConstraintPresetId = keyof typeof HK_CONSTRAINT_PRESETS;

export const HK_CONSTRAINT_FIELDS: Array<{
  id: keyof HkConstraintSettings;
  title: string;
  detail: string;
  group: string;
}> = [
  {
    id: "checkin",
    group: "Vincoli",
    title: "Finire prima del check-in",
    detail: "La pulizia deve chiudersi prima dell'arrivo dell'ospite.",
  },
  {
    id: "checkout",
    group: "Vincoli",
    title: "Partire dopo il checkout",
    detail: "La pulizia non inizia prima che l'ospite sia uscito.",
  },
  {
    id: "triadeCeiling",
    group: "Vincoli",
    title: "Livelli triade",
    detail: "Un cleaner prende solo appartamenti del suo livello o più bassi.",
  },
  {
    id: "travel",
    group: "Vincoli",
    title: "Distanza tra appartamenti",
    detail: "Il viaggio fra una tappa e l'altra resta entro il massimo di minuti.",
  },
  {
    id: "workloadBalance",
    group: "Vincoli",
    title: "Stesso carico di lavoro",
    detail: "I cleaner ricevono più o meno gli stessi minuti di lavoro.",
  },
];

function withStandardWeights(
  settings: HkConstraintSettings,
  presetId: HkConstraintPresetId | null,
): HkConstraintSettings {
  if (!presetId) return settings;
  const preset = HK_CONSTRAINT_PRESETS[presetId];
  return {
    ...settings,
    triadeMatchBonus: preset.triadeMatchBonus,
    triadeOverqualPenalty: preset.triadeOverqualPenalty,
    phase4LevelBonus: preset.phase4LevelBonus,
    phase4OverqualPenalty: preset.phase4OverqualPenalty,
    travelWeight: preset.travelWeight,
    travelHardMaxMin: preset.travelHardMaxMin,
  };
}

function asMode(value: unknown, fallback: ConstraintMode): ConstraintMode {
  return MODES.includes(value as ConstraintMode) ? (value as ConstraintMode) : fallback;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function parseHkConstraintSettings(raw: unknown): HkConstraintSettings {
  const base = HK_CONSTRAINT_PRESETS.balanced;
  const source = raw && typeof raw === "object" ? (raw as Partial<HkConstraintSettings>) : {};
  return {
    triadeCeiling: asMode(source.triadeCeiling, base.triadeCeiling),
    triadeMatch: asMode(source.triadeMatch, base.triadeMatch),
    triadeMatchBonus: asNumber(source.triadeMatchBonus, base.triadeMatchBonus, 0, 200000),
    triadeOverqualPenalty: asNumber(source.triadeOverqualPenalty, base.triadeOverqualPenalty, 0, 200000),
    phase4LevelBonus: asNumber(source.phase4LevelBonus, base.phase4LevelBonus, 0, 200000),
    phase4OverqualPenalty: asNumber(source.phase4OverqualPenalty, base.phase4OverqualPenalty, 0, 200000),
    travel: asMode(source.travel, base.travel),
    travelWeight: asNumber(source.travelWeight, base.travelWeight, 0, 50),
    travelHardMaxMin: asNumber(source.travelHardMaxMin, base.travelHardMaxMin, 5, 180),
    loadCap: asMode(source.loadCap, base.loadCap),
    loadCapPercent: asNumber(source.loadCapPercent, base.loadCapPercent, 100, 200),
    priorityWindow: asMode(source.priorityWindow, base.priorityWindow),
    checkout: asMode(source.checkout, base.checkout),
    checkin: asMode(source.checkin, base.checkin),
    workloadBalance: asMode(source.workloadBalance, base.workloadBalance),
    shiftEnd: asMode(source.shiftEnd, base.shiftEnd),
    shortenRoutes: asBool(source.shortenRoutes, base.shortenRoutes),
    rebalanceLoads: asBool(source.rebalanceLoads, base.rebalanceLoads),
    phase5Iterations: asNumber(source.phase5Iterations, base.phase5Iterations, 0, 200),
    fairnessIterations: asNumber(source.fairnessIterations, base.fairnessIterations, 0, 100),
    triadSwap: asBool(source.triadSwap, base.triadSwap),
    taskCount: asMode(source.taskCount, base.taskCount),
    longOt: asMode(source.longOt, base.longOt),
    shortOt: asMode(source.shortOt, base.shortOt),
    officeRole: asMode(source.officeRole, base.officeRole),
    apartmentType: asMode(source.apartmentType, base.apartmentType),
    formatorePriority: asMode(source.formatorePriority, base.formatorePriority),
    formatoreStandard: asMode(source.formatoreStandard, base.formatoreStandard),
  };
}

export function hkSettingsForHypothesis(id: string | null | undefined): HkConstraintSettings {
  if (id === "triade" || id === "distance" || id === "balanced") {
    return { ...HK_CONSTRAINT_PRESETS[id] };
  }
  return { ...HK_CONSTRAINT_PRESETS.balanced };
}

export function sameHkConstraintSettings(a: HkConstraintSettings, b: HkConstraintSettings): boolean {
  return (Object.keys(HK_CONSTRAINT_PRESETS.balanced) as Array<keyof HkConstraintSettings>).every(
    (key) => a[key] === b[key],
  );
}

export const HK_BUILTIN_PROFILES: Array<{ id: HkConstraintPresetId; name: string; detail: string }> = [
  { id: "balanced", name: "Bilanciato", detail: "Check-in, checkout e livello prima. Distanza e carico restano preferibili." },
];

const RETIRED_BUILTIN_IDS = new Set(["triade", "distance"]);

export interface HkNamedProfile {
  id: string;
  name: string;
  builtin: HkConstraintPresetId | null;
  settings: HkConstraintSettings;
}

export interface HkProfileLibrary {
  activeId: string;
  profiles: HkNamedProfile[];
}

const MAX_PROFILES = 12;
const MAX_PROFILE_NAME = 40;

function cleanProfileId(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

function cleanProfileName(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, MAX_PROFILE_NAME);
}

function builtinProfile(id: HkConstraintPresetId, name = ""): HkNamedProfile {
  const meta = HK_BUILTIN_PROFILES.find((profile) => profile.id === id);
  return {
    id,
    name: cleanProfileName(name, meta?.name ?? "Profilo"),
    builtin: id,
    settings: { ...HK_CONSTRAINT_PRESETS[id] },
  };
}

export function defaultHkProfileLibrary(active?: HkConstraintSettings): HkProfileLibrary {
  const profiles = HK_BUILTIN_PROFILES.map((preset) => builtinProfile(preset.id));
  if (!active) return { activeId: "balanced", profiles };
  const match = profiles.find((profile) => sameHkConstraintSettings(profile.settings, active));
  if (match) return { activeId: match.id, profiles };
  const custom: HkNamedProfile = {
    id: "personalizzato",
    name: "Personalizzato",
    builtin: null,
    settings: { ...active },
  };
  return { activeId: custom.id, profiles: [...profiles, custom] };
}

export function parseHkProfileLibrary(raw: unknown, activeSettings?: unknown): HkProfileLibrary {
  const active = parseHkConstraintSettings(activeSettings);
  const source = raw && typeof raw === "object" ? (raw as { activeId?: unknown; profiles?: unknown }) : null;
  if (!source || !Array.isArray(source.profiles)) return defaultHkProfileLibrary(active);

  const seen = new Set<string>();
  const profiles: HkNamedProfile[] = [];
  for (const item of source.profiles) {
    if (!item || typeof item !== "object") continue;
    const row = item as Partial<HkNamedProfile>;
    const rawBuiltin = row.builtin === "balanced" || row.builtin === "triade" || row.builtin === "distance" ? row.builtin : null;
    const rawId = cleanProfileId(row.id) || rawBuiltin || "";
    if (RETIRED_BUILTIN_IDS.has(rawId) || (rawBuiltin != null && RETIRED_BUILTIN_IDS.has(rawBuiltin))) continue;
    const builtin = rawBuiltin === "balanced" ? rawBuiltin : null;
    const id = rawId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const fallbackName = HK_BUILTIN_PROFILES.find((preset) => preset.id === builtin)?.name ?? "Profilo";
    profiles.push({
      id,
      name: cleanProfileName(row.name, fallbackName),
      builtin,
      settings: withStandardWeights(parseHkConstraintSettings(row.settings), builtin),
    });
    if (profiles.length >= MAX_PROFILES) break;
  }

  for (const preset of [...HK_BUILTIN_PROFILES].reverse()) {
    if (!profiles.some((profile) => profile.id === preset.id || profile.builtin === preset.id)) {
      profiles.unshift(builtinProfile(preset.id));
    }
  }

  if (profiles.length === 0) return defaultHkProfileLibrary(active);
  const requested = cleanProfileId(source.activeId);
  const activeId = profiles.some((profile) => profile.id === requested) ? requested : profiles[0].id;
  return { activeId, profiles };
}

export function nextCustomProfileId(existing: HkNamedProfile[]): string {
  const ids = new Set(existing.map((profile) => profile.id));
  let n = existing.length + 1;
  let id = `custom-${n}`;
  while (ids.has(id)) {
    n += 1;
    id = `custom-${n}`;
  }
  return id;
}

export function constraintDecision(
  mode: ConstraintMode,
  violated: boolean,
  softPenalty: number,
): { blocked: boolean; penalty: number } {
  if (!violated || mode === "off") return { blocked: false, penalty: 0 };
  if (mode === "soft") return { blocked: false, penalty: softPenalty };
  return { blocked: true, penalty: 0 };
}
