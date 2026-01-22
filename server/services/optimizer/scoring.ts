const SIZE_BONUS: Record<number, number> = {
  1: 0,
  2: 500,
  3: 1200,
  4: 1600
};

// Bonus per gruppi che contengono una straordinaria
// Questo compensa il SIZE_BONUS basso dei gruppi piccoli (1-2 task)
// che tipicamente contengono straordinarie
const STRAORDINARIA_BONUS = 800;

export function scoreGroup(
  avgTravelMin: number, 
  maxTravelMin: number, 
  sameZone: boolean,
  groupSize: number = 2,
  totalTravelMin: number = 0,
  hasStraordinaria: boolean = false
): number {
  const sizeBonus = SIZE_BONUS[groupSize] ?? 0;
  const straordinariaBonus = hasStraordinaria ? STRAORDINARIA_BONUS : 0;
  const penalty = avgTravelMin * 2 + maxTravelMin * 3;
  const bonus = sameZone ? 10 : 0;
  return Math.round((sizeBonus + straordinariaBonus - penalty + bonus) * 10) / 10;
}
