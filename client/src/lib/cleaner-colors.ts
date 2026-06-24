export type PersonnelColorScope = "housekeeping" | "logistics";

// Palette base condivisa; ogni scope usa un sottoinsieme filtrato.
const ALL_DISTINCT_COLORS = [
  "#E6194B", // Rosso
  "#3CB44B", // Verde
  "#4363D8", // Blu
  "#F58231", // Arancione
  "#911EB4", // Viola
  "#46F0F0", // Turchese
  "#F032E6", // Fucsia
  "#BCF60C", // Lime
  "#FABEBE", // Rosa chiaro
  "#008080", // Teal
  "#E6BEFF", // Lavanda
  "#9A6324", // Marrone
  "#800000", // Bordeaux
  "#AAFFC3", // Menta
  "#808000", // Oliva
  "#FFD8B1", // Pesca
  "#000075", // Blu notte
  "#FF4500", // Arancione rosso
  "#2E8B57", // Verde mare
  "#1E90FF", // Blu dodger
  "#FFD700", // Oro
  "#6A5ACD", // Blu ardesia
  "#20B2AA", // Verde acqua
  "#DC143C", // Cremisi
  "#00CED1", // Turchese scuro
  "#FF69B4", // Rosa shocking
  "#7FFF00", // Chartreuse
  "#B22222", // Rosso mattone
  "#4682B4", // Blu acciaio
  "#32CD32", // Verde lime
  "#FF8C00", // Arancione scuro
  "#9400D3", // Viola scuro
  "#00FA9A", // Verde primavera
  "#4169E1", // Blu reale
  "#CD853F", // Sabbia
  "#FF1493", // Magenta intenso
  "#2F4F4F", // Grigio ardesia
  "#8B4513", // Marrone cuoio
  "#00BFFF", // Azzurro profondo
  "#ADFF2F", // Verde giallastro
  "#FF6347", // Rosso pomodoro
  "#4B0082", // Indaco
  "#66CDAA", // Acquamarina
  "#A52A2A", // Marrone rosso
  "#5F9EA0", // Blu cadetto
  "#D2691E", // Cioccolato
];

/** Housekeeping: niente verde, oro, rosso e grigio (riservati a stati task / premium / errori). */
const HOUSEKEEPING_EXCLUDED = new Set([
  "#E6194B",
  "#800000",
  "#DC143C",
  "#B22222",
  "#FF6347",
  "#FF4500",
  "#A52A2A",
  "#3CB44B",
  "#2E8B57",
  "#32CD32",
  "#00FA9A",
  "#ADFF2F",
  "#7FFF00",
  "#BCF60C",
  "#AAFFC3",
  "#20B2AA",
  "#FFD700",
  "#2F4F4F",
]);

/** Logistica: niente azzurro, viola e grigio (riservati a pick-up / delivery / non assegnato). */
const LOGISTICS_EXCLUDED = new Set([
  "#911EB4",
  "#9400D3",
  "#4B0082",
  "#6A5ACD",
  "#E6BEFF",
  "#46F0F0",
  "#00CED1",
  "#1E90FF",
  "#00BFFF",
  "#4682B4",
  "#5F9EA0",
  "#66CDAA",
  "#20B2AA",
  "#2F4F4F",
]);

const HOUSEKEEPING_COLORS = ALL_DISTINCT_COLORS.filter(
  (color) => !HOUSEKEEPING_EXCLUDED.has(color)
);
const LOGISTICS_COLORS = ALL_DISTINCT_COLORS.filter(
  (color) => !LOGISTICS_EXCLUDED.has(color)
);

const colorMaps: Record<PersonnelColorScope, Map<number, string>> = {
  housekeeping: new Map(),
  logistics: new Map(),
};
const nextColorIndex: Record<PersonnelColorScope, number> = {
  housekeeping: 0,
  logistics: 0,
};

function getPalette(scope: PersonnelColorScope): string[] {
  return scope === "housekeeping" ? HOUSEKEEPING_COLORS : LOGISTICS_COLORS;
}

export function getPersonnelHexColor(
  personnelId: number,
  scope: PersonnelColorScope = "housekeeping"
): string {
  const map = colorMaps[scope];
  if (!map.has(personnelId)) {
    const palette = getPalette(scope);
    const color = palette[nextColorIndex[scope] % palette.length];
    map.set(personnelId, color);
    nextColorIndex[scope] += 1;
  }

  return map.get(personnelId)!;
}

/** @deprecated Prefer {@link getPersonnelHexColor} with scope `"housekeeping"`. */
export function getCleanerHexColor(cleanerId: number) {
  return getPersonnelHexColor(cleanerId, "housekeeping");
}
