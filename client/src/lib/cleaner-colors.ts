// Palette di colori molto distinti e saturi per i pallini dei cleaner
const DISTINCT_COLORS = [
  "#FF0000", // Rosso puro
  "#0000FF", // Blu puro
  "#00AA00", // Verde puro
  "#FF00FF", // Magenta
  "#00FFFF", // Cyan
  "#FFAA00", // Arancione
  "#FF0088", // Rosa acceso
  "#00FF00", // Lime
  "#0088FF", // Azzurro
  "#AA00FF", // Viola
  "#FF8800", // Arancione scuro
  "#00AAFF", // Celeste
  "#FF0044", // Rosso scuro
  "#FFFF00", // Giallo puro
  "#00FF88", // Verde acqua
  "#8800FF", // Blu violetto
];

export function getCleanerHexColor(cleanerId: number) {
  const index = cleanerId % DISTINCT_COLORS.length;
  return DISTINCT_COLORS[index];
}
