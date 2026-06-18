/**
 * Effective travel between two matrix nodes.
 *
 * NEARBY_CLUSTER uses hub → member reachability. For asymmetric road matrices,
 * we take max(outbound, inbound) so membership stays conservative.
 * Symmetric haversine estimates are unchanged.
 */
export function effectiveTravelMin(
  travelMatrixMin: number[][],
  fromNodeIndex: number,
  toNodeIndex: number
): number | null {
  const outbound = travelMatrixMin[fromNodeIndex]?.[toNodeIndex];
  const inbound = travelMatrixMin[toNodeIndex]?.[fromNodeIndex];
  if (!Number.isFinite(outbound) && !Number.isFinite(inbound)) {
    return null;
  }
  if (!Number.isFinite(outbound)) {
    return inbound!;
  }
  if (!Number.isFinite(inbound)) {
    return outbound;
  }
  return Math.max(outbound, inbound);
}
