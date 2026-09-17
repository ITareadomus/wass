export const LOGISTICS_HYPOTHESIS_IDS = [
  "priority-strict",
  "proximity-strict",
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
    title: "Priorità",
    description:
      "Stesse zone esclusive, tutti gli appartamenti. Rispetta le finestre (D&P urgenti, check-in, borsone) anche zigzagando. La distanza conta poco: prima i vincoli.",
  },
  {
    id: "proximity-strict",
    title: "Distanza",
    description:
      "Stesse zone esclusive, tutti gli appartamenti. Parte dal gruppo più in priorità della zona, poi segue solo la distanza: ogni stop è il più vicino, con un giro senza incroci. Gli sforamenti restano visibili.",
  },
  {
    id: "balanced-geo-start",
    title: "Bilanciato",
    description:
      "Stesse zone, tutti gli appartamenti, mix distanza/priorità, senza far rubare lo slot ai D&P urgenti.",
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
