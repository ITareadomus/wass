export const LOGISTICS_HYPOTHESIS_IDS = [
  "priority-strict",
  "proximity-strict",
  "balanced-urgent-start",
  "balanced-geo-start",
] as const;

export type LogisticsHypothesisId = (typeof LOGISTICS_HYPOTHESIS_IDS)[number];

export interface LogisticsHypothesisProfileMeta {
  id: LogisticsHypothesisId;
  title: string;
  description: string;
}

export const LOGISTICS_HYPOTHESIS_PROFILES: LogisticsHypothesisProfileMeta[] = [
  {
    id: "priority-strict",
    title: "Priorità complete",
    description:
      "Rispetta tutte le finestre urgenti (D&P stretti, check-in). Il giro può zigzagare se serve per non perdere uno slot.",
  },
  {
    id: "proximity-strict",
    title: "Sequenza per vicinanza",
    description:
      "Ordine geografico: ogni stop è il più vicino al precedente. Parte da un capolinea della zona. I vincoli orari restano visibili se sforati.",
  },
  {
    id: "balanced-urgent-start",
    title: "Bilanciato A",
    description:
      "Mix distanza/priorità, partenza dall'appartamento più vicino al deposito della zona.",
  },
  {
    id: "balanced-geo-start",
    title: "Bilanciato B",
    description:
      "Mix distanza/priorità, partenza da un altro capolinea (finestra più precoce della zona).",
  },
];

export interface LogisticsHypothesisRoutePreview {
  driverId: number;
  zoneLabel: string;
  logisticCodes: number[];
  travelMin: number;
  startMin: number;
  endMin: number;
  firstLogisticCode: number | null;
}

export interface LogisticsHypothesisSummary {
  id: LogisticsHypothesisId;
  title: string;
  description: string;
  assignedTaskCount: number;
  droppedTaskCount: number;
  totalTravelMin: number;
  totalWaitMin: number;
  windowViolationCount: number;
  zoneCount: number;
  routes: LogisticsHypothesisRoutePreview[];
}

export interface LogisticsHypothesisTimelinePreview {
  drivers_assignments: Array<{
    driver: Record<string, unknown>;
    tasks: unknown[];
    return_travel_time?: number;
  }>;
}

export function logisticsHypothesisProfileById(
  id: LogisticsHypothesisId
): LogisticsHypothesisProfileMeta {
  const profile = LOGISTICS_HYPOTHESIS_PROFILES.find((entry) => entry.id === id);
  if (!profile) {
    return LOGISTICS_HYPOTHESIS_PROFILES[0];
  }
  return profile;
}
