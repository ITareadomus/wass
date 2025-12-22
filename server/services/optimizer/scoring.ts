export function scoreGroup(avgTravelMin: number, maxTravelMin: number, sameZone: boolean): number {
  const base = 100;
  const penalty = avgTravelMin * 2 + maxTravelMin * 3;
  const bonus = sameZone ? 10 : 0;
  return Math.round((base - penalty + bonus) * 10) / 10;
}
