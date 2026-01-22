const SIZE_BONUS: Record<number, number> = {
  1: 0,
  2: 500,
  3: 1200,
  4: 1600
};

// Bonus gap-based per straordinarie
// Obiettivo: rendere competitivo un gruppo con straordinaria rispetto a gruppi standard
// LONG (>=4h): obbligatoriamente sola, bonus più alto per compensare size=1
// SHORT (<4h): può stare con 1 task breve, bonus più basso
const STRAORDINARIA_BONUS_LONG = 700;  // >=4h (240min): porta size=1 a ~700 (quasi come size=2)
const STRAORDINARIA_BONUS_SHORT = 400; // <4h: porta size=1 a ~400, size=2 a ~900 (quasi come size=3)

export type StraordinariaInfo = {
  hasStraordinaria: boolean;
  isLong: boolean; // true se >=4h (240min)
};

export function scoreGroup(
  avgTravelMin: number, 
  maxTravelMin: number, 
  sameZone: boolean,
  groupSize: number = 2,
  totalTravelMin: number = 0,
  straordinariaInfo: StraordinariaInfo = { hasStraordinaria: false, isLong: false }
): number {
  const sizeBonus = SIZE_BONUS[groupSize] ?? 0;
  
  // Bonus gap-based per straordinarie
  let straordinariaBonus = 0;
  if (straordinariaInfo.hasStraordinaria) {
    straordinariaBonus = straordinariaInfo.isLong 
      ? STRAORDINARIA_BONUS_LONG 
      : STRAORDINARIA_BONUS_SHORT;
  }
  
  const penalty = avgTravelMin * 2 + maxTravelMin * 3;
  const bonus = sameZone ? 10 : 0;
  return Math.round((sizeBonus + straordinariaBonus - penalty + bonus) * 10) / 10;
}
