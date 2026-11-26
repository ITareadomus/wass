import { snapshotFromDaySql, type DaySnapshot } from "../../shared/day-sql-snapshot";
import { attachAptCodesFromStructures } from "./adam-structure-apt-code";
import { buildDayExportSql } from "./day-sql-export";

const EMPTY_PROVA = "Nessuna prova algoritmo per questa data. Aprila da Prova algoritmo e premi Assegna.";
const EMPTY_DAY = "Nessuna giornata salvata in WASS per questa data";

/**
 * Giornata di confronto letta da WASS, con l'apt code di ADAM.
 * Il file SQL caricato a mano non passa di qui: resta solo quello che contiene.
 */
export async function buildWassComparisonSnapshot(
  workDate: string,
  scope: "housekeeping" | "alg-test",
): Promise<DaySnapshot> {
  const sql = await buildDayExportSql(workDate, scope);
  if (!/insert\s+into/i.test(sql)) {
    throw new Error(scope === "alg-test" ? EMPTY_PROVA : EMPTY_DAY);
  }
  const snapshot = snapshotFromDaySql(sql, scope);
  if (scope === "alg-test" && snapshot.assignedCount === 0 && snapshot.containerCount === 0) {
    throw new Error(EMPTY_PROVA);
  }
  await attachSnapshotAptCodes(snapshot);
  return snapshot;
}

async function attachSnapshotAptCodes(snapshot: DaySnapshot): Promise<void> {
  const carriers = snapshot.tasks.map((task) => ({
    logistic_code: Number(task.logisticCode),
    apt_code: task.aptCode || null,
  }));
  await attachAptCodesFromStructures(carriers);
  snapshot.tasks.forEach((task, index) => {
    const apt = carriers[index]?.apt_code;
    if (apt) task.aptCode = String(apt).trim();
  });
}
