export const HK_HYPOTHESIS_IDS = ["triade", "distance", "balanced"] as const;

export type HkHypothesisId = (typeof HK_HYPOTHESIS_IDS)[number];

export interface HkHypothesisProfile {
  id: HkHypothesisId;
  title: string;
  description: string;
  travelWeight: number;
  triadLevelBonus: number;
  triadOverqualPenalty: number;
  phase4LevelBonus: number;
  phase4OverqualPenalty: number;
  triadSwap: boolean;
  phase5MaxIterations: number;
  phase5MaxFairnessIterations: number;
}

export const HK_HYPOTHESIS_PROFILES: HkHypothesisProfile[] = [
  {
    id: "triade",
    title: "Triade",
    description:
      "Assegna tutti gli appartamenti che possono entrare. A parità, i cleaner alti prendono gli appartamenti del loro livello. Il viaggio conta poco.",
    travelWeight: 0.5,
    triadLevelBonus: 20000,
    triadOverqualPenalty: 8000,
    phase4LevelBonus: 80000,
    phase4OverqualPenalty: 20000,
    triadSwap: true,
    phase5MaxIterations: 0,
    phase5MaxFairnessIterations: 0,
  },
  {
    id: "distance",
    title: "Distanza",
    description:
      "Assegna tutti gli appartamenti che possono entrare. A parità, tiene le giornate compatte. Un cleaner non riceve mai un appartamento di livello più alto del suo.",
    travelWeight: 8,
    triadLevelBonus: 0,
    triadOverqualPenalty: 0,
    phase4LevelBonus: 0,
    phase4OverqualPenalty: 0,
    triadSwap: false,
    phase5MaxIterations: 80,
    phase5MaxFairnessIterations: 30,
  },
  {
    id: "balanced",
    title: "Bilanciato",
    description:
      "Assegna tutti gli appartamenti che possono entrare. Prima il livello, poi la distanza, senza allungare troppo i giri.",
    travelWeight: 2,
    triadLevelBonus: 8000,
    triadOverqualPenalty: 3000,
    phase4LevelBonus: 10000,
    phase4OverqualPenalty: 4000,
    triadSwap: true,
    phase5MaxIterations: 80,
    phase5MaxFairnessIterations: 30,
  },
];

export interface HkHypothesisAssignment {
  taskId: number;
  cleanerId: number;
  sequence: number;
  startTime: string | null;
  endTime: string | null;
  travelMin: number;
  priority: string | null;
}

export interface HkHypothesisSummary {
  id: HkHypothesisId;
  title: string;
  description: string;
  assignedTaskCount: number;
  droppedTaskCount: number;
  totalTravelMin: number;
}

export interface HkHypothesisPickerItem {
  summary: HkHypothesisSummary;
  runId: string;
  assignments: HkHypothesisAssignment[];
}

export function hkHypothesisProfileById(id: HkHypothesisId): HkHypothesisProfile {
  return HK_HYPOTHESIS_PROFILES.find((profile) => profile.id === id) ?? HK_HYPOTHESIS_PROFILES[2];
}
