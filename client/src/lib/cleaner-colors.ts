// Palette di colori ufficiale per i pallini dei cleaner e marker nella timeline
const DISTINCT_COLORS = [
  "#E6194B", // Rosso
  "#3CB44B", // Verde
  "#FFE119", // Giallo
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
  "#FFFAC8", // Giallo crema
  "#800000", // Bordeaux
  "#AAFFC3", // Menta
  "#808000", // Oliva
  "#FFD8B1", // Pesca
  "#000075", // Blu notte
  "#808080", // Grigio
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

export function getCleanerHexColor(cleanerId: number) {
  const index = cleanerId % DISTINCT_COLORS.length;
  return DISTINCT_COLORS[index];
}
