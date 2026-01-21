const SIZE_BONUS: Record<number, number> = {
  1: 0,
  2: 500,
  3: 1200,
  4: 1600
};

export function scoreGroup(
  avgTravelMin: number, 
  maxTravelMin: number, 
  sameZone: boolean,
  groupSize: number = 2,
  totalTravelMin: number = 0
): number {
  const sizeBonus = SIZE_BONUS[groupSize] ?? 0;
  const penalty = avgTravelMin * 2 + maxTravelMin * 3;
  const bonus = sameZone ? 10 : 0;
  return Math.round((sizeBonus - penalty + bonus) * 10) / 10;
}
