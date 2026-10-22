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
  taskCount: ConstraintMode;
  longOt: ConstraintMode;
  shortOt: ConstraintMode;
  officeRole: ConstraintMode;
  apartmentType: ConstraintMode;
  formatorePriority: ConstraintMode;
  formatoreStandard: ConstraintMode;
  priorityWindow: ConstraintMode;
  checkin: ConstraintMode;
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
    taskCount: "hard",
    longOt: "hard",
    shortOt: "hard",
    officeRole: "hard",
    apartmentType: "hard",
    formatorePriority: "hard",
    formatoreStandard: "hard",
    priorityWindow: "soft",
    checkin: "hard",
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
    travel: "soft",
    travelWeight: 0.5,
    travelHardMaxMin: 45,
    loadCap: "hard",
    taskCount: "hard",
    longOt: "hard",
    shortOt: "hard",
    officeRole: "hard",
    apartmentType: "hard",
    formatorePriority: "hard",
    formatoreStandard: "hard",
    priorityWindow: "soft",
    checkin: "hard",
    shiftEnd: "hard",
    shortenRoutes: false,
    rebalanceLoads: false,
    phase5Iterations: 0,
    fairnessIterations: 0,
    triadSwap: true,
  },
  distance: {
    triadeCeiling: "hard",
    triadeMatch: "off",
    triadeMatchBonus: 0,
    triadeOverqualPenalty: 0,
    phase4LevelBonus: 0,
    phase4OverqualPenalty: 0,
    travel: "soft",
    travelWeight: 8,
    travelHardMaxMin: 45,
    loadCap: "hard",
    taskCount: "hard",
    longOt: "hard",
    shortOt: "hard",
    officeRole: "hard",
    apartmentType: "hard",
    formatorePriority: "hard",
    formatoreStandard: "hard",
    priorityWindow: "soft",
    checkin: "hard",
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
    id: "triadeCeiling",
    group: "Livello",
    title: "Non superare la triade",
    detail: "Un cleaner prende solo appartamenti del suo livello o più bassi.",
  },
  {
    id: "triadeMatch",
    group: "Livello",
    title: "Preferire lo stesso livello",
    detail: "A parità di copertura, un cleaner alto prende gli appartamenti del suo livello.",
  },
  {
    id: "travel",
    group: "Giornata",
    title: "Giri corti",
    detail: "Tiene vicini gli appartamenti dello stesso cleaner.",
  },
  {
    id: "loadCap",
    group: "Giornata",
    title: "Tetto di carico",
    detail: "Il cleaner non supera il 125% dei minuti medi della giornata.",
  },
  {
    id: "taskCount",
    group: "Giornata",
    title: "Numero massimo di task",
    detail: "Limite di appartamenti per cleaner, calcolato sui task del giorno.",
  },
  {
    id: "longOt",
    group: "Straordinarie",
    title: "Straordinaria lunga da sola",
    detail: "Da 6 ore in su il cleaner non riceve altri task.",
  },
  {
    id: "shortOt",
    group: "Straordinarie",
    title: "Straordinaria corta con un solo extra",
    detail: "Sotto le 6 ore può stare con un solo task, di al massimo 2 ore e 25 minuti.",
  },
  {
    id: "officeRole",
    group: "Ruoli",
    title: "Ufficio solo ai cleaner ufficio",
    detail: "I task ufficio restano sui cleaner ufficio, e quelli non prendono appartamenti.",
  },
  {
    id: "apartmentType",
    group: "Ruoli",
    title: "Tipo appartamento per ruolo",
    detail: "Ogni ruolo tiene solo i tipi appartamento abilitati nelle impostazioni.",
  },
  {
    id: "formatorePriority",
    group: "Ruoli",
    title: "Priorità del formatore",
    detail: "Il formatore riceve solo le priorità abilitate per il suo ruolo.",
  },
  {
    id: "formatoreStandard",
    group: "Ruoli",
    title: "Task standard del formatore",
    detail: "Il formatore riceve un task standard solo se quel tipo è abilitato.",
  },
  {
    id: "priorityWindow",
    group: "Orari",
    title: "Finestre Early Out, High e Low",
    detail: "Rispetta l'orario di partenza e la finestra della priorità.",
  },
  {
    id: "checkin",
    group: "Orari",
    title: "Finire prima del check-in",
    detail: "La pulizia deve chiudersi prima dell'arrivo dell'ospite.",
  },
  {
    id: "shiftEnd",
    group: "Orari",
    title: "Finire dentro il turno",
    detail: "Nessun task può terminare dopo l'orario di fine del cleaner.",
  },
];

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
    taskCount: asMode(source.taskCount, base.taskCount),
    longOt: asMode(source.longOt, base.longOt),
    shortOt: asMode(source.shortOt, base.shortOt),
    officeRole: asMode(source.officeRole, base.officeRole),
    apartmentType: asMode(source.apartmentType, base.apartmentType),
    formatorePriority: asMode(source.formatorePriority, base.formatorePriority),
    formatoreStandard: asMode(source.formatoreStandard, base.formatoreStandard),
    priorityWindow: asMode(source.priorityWindow, base.priorityWindow),
    checkin: asMode(source.checkin, base.checkin),
    shiftEnd: asMode(source.shiftEnd, base.shiftEnd),
    shortenRoutes: asBool(source.shortenRoutes, base.shortenRoutes),
    rebalanceLoads: asBool(source.rebalanceLoads, base.rebalanceLoads),
    phase5Iterations: asNumber(source.phase5Iterations, base.phase5Iterations, 0, 200),
    fairnessIterations: asNumber(source.fairnessIterations, base.fairnessIterations, 0, 100),
    triadSwap: asBool(source.triadSwap, base.triadSwap),
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
  { id: "balanced", name: "Bilanciato", detail: "Prima assegna, poi il livello, poi la distanza." },
  { id: "triade", name: "Triade", detail: "Il livello pesa molto. I giri non vengono accorciati dopo." },
  { id: "distance", name: "Distanza", detail: "I giri restano compatti. Il match di livello è spento." },
];

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
    const builtin =
      row.builtin === "balanced" || row.builtin === "triade" || row.builtin === "distance" ? row.builtin : null;
    const id = cleanProfileId(row.id) || builtin || "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const fallbackName = HK_BUILTIN_PROFILES.find((preset) => preset.id === builtin)?.name ?? "Profilo";
    profiles.push({
      id,
      name: cleanProfileName(row.name, fallbackName),
      builtin,
      settings: parseHkConstraintSettings(row.settings),
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
