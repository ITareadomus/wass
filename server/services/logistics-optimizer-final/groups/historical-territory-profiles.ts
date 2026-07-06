export type HistoricalTerritoryKey = "north" | "center_south_west" | "center_south_east";

export interface HistoricalTerritoryProfile {
  territoryKey: HistoricalTerritoryKey;
  territoryIndex: number;
  label: string;
  centroid: { lat: number; lng: number };
  penaltyRadiusMeters: number;
  visualRadiusMeters: number;
  preferredHistoricalDriverCode: string;
  suggestedColor: string;
}

export const THREE_DRIVER_TERRITORY_PROFILES: HistoricalTerritoryProfile[] = [
  {
    territoryKey: "north",
    territoryIndex: 0,
    label: "Nord",
    centroid: { lat: 45.48284, lng: 9.1887 },
    penaltyRadiusMeters: 3340,
    visualRadiusMeters: 7000,
    preferredHistoricalDriverCode: "ADP03",
    suggestedColor: "#d73027",
  },
  {
    territoryKey: "center_south_west",
    territoryIndex: 1,
    label: "Centro / Sud-Ovest",
    centroid: { lat: 45.45636, lng: 9.16891 },
    penaltyRadiusMeters: 2240,
    visualRadiusMeters: 4200,
    preferredHistoricalDriverCode: "ADP01",
    suggestedColor: "#1a9850",
  },
  {
    territoryKey: "center_south_east",
    territoryIndex: 2,
    label: "Centro / Sud-Est",
    centroid: { lat: 45.45784, lng: 9.19696 },
    penaltyRadiusMeters: 2150,
    visualRadiusMeters: 4200,
    preferredHistoricalDriverCode: "ADP02",
    suggestedColor: "#4575b4",
  },
];

export function extractDriverOperationalCode(parts: {
  name?: string | null;
  lastname?: string | null;
  alias?: string | null;
}): string | undefined {
  const haystack = [parts.name, parts.lastname, parts.alias].filter(Boolean).join(" ");
  const match = haystack.match(/\b(ADP\d+)\b/i);
  return match ? match[1].toUpperCase() : undefined;
}

export function profileByTerritoryIndex(
  profiles: HistoricalTerritoryProfile[],
  territoryIndex: number
): HistoricalTerritoryProfile | undefined {
  return profiles.find((profile) => profile.territoryIndex === territoryIndex);
}
