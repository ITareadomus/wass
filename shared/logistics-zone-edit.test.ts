import { describe, expect, it } from "vitest";
import { assignTasksToZonePolygons, pointInLatLngPolygon } from "./logistics-zone-edit";
import { parseZoneTaskIdsByZoneIndex } from "./logistics-zone-start-plan";

const northSquare = [
  { lat: 45.5, lng: 9.18 },
  { lat: 45.5, lng: 9.2 },
  { lat: 45.52, lng: 9.2 },
  { lat: 45.52, lng: 9.18 },
];

const southSquare = [
  { lat: 45.42, lng: 9.16 },
  { lat: 45.42, lng: 9.18 },
  { lat: 45.44, lng: 9.18 },
  { lat: 45.44, lng: 9.16 },
];

describe("logistics zone edit", () => {
  it("detects points inside a polygon", () => {
    expect(pointInLatLngPolygon({ lat: 45.51, lng: 9.19 }, northSquare)).toBe(true);
    expect(pointInLatLngPolygon({ lat: 45.43, lng: 9.17 }, northSquare)).toBe(false);
  });

  it("moves an apartment into the last-edited overlapping zone", () => {
    const overlap = [
      { lat: 45.49, lng: 9.17 },
      { lat: 45.49, lng: 9.21 },
      { lat: 45.53, lng: 9.21 },
      { lat: 45.53, lng: 9.17 },
    ];
    const assigned = assignTasksToZonePolygons(
      [
        { taskId: 1, lat: 45.51, lng: 9.19 },
        { taskId: 2, lat: 45.43, lng: 9.17 },
      ],
      new Map([
        [1, 0],
        [2, 1],
      ]),
      [
        { zoneIndex: 0, path: northSquare },
        { zoneIndex: 1, path: southSquare },
        { zoneIndex: 2, path: overlap },
      ],
      2
    );
    expect(assigned.get(1)).toBe(2);
    expect(assigned.get(2)).toBe(1);
  });

  it("unassigns the apartment when it stays outside every polygon", () => {
    const assigned = assignTasksToZonePolygons(
      [{ taskId: 9, lat: 45.6, lng: 9.3 }],
      new Map([[9, 1]]),
      [
        { zoneIndex: 0, path: northSquare },
        { zoneIndex: 1, path: southSquare },
      ]
    );
    expect(assigned.get(9)).toBeNull();
  });

  it("parses custom zone task lists and ignores duplicates", () => {
    const parsed = parseZoneTaskIdsByZoneIndex({
      "0": [11, "12", 11],
      "1": [13],
      skip: [14],
    });
    expect(parsed.get(0)).toEqual([11, 12]);
    expect(parsed.get(1)).toEqual([13]);
    expect(parsed.has(Number.NaN)).toBe(false);
  });
});
