import { describe, expect, it } from "vitest";
import { pointInLatLngPolygon } from "./logistics-zone-edit";
import {
  resolveZoneShapeOverlaps,
  shrinkZoneOutsideWinner,
  toAngularZonePath,
  visibleZoneOutline,
  zonePolygonsOverlap,
} from "./logistics-zone-geometry";

const dense = [
  { lat: 45.5, lng: 9.18 },
  { lat: 45.501, lng: 9.185 },
  { lat: 45.502, lng: 9.19 },
  { lat: 45.501, lng: 9.195 },
  { lat: 45.5, lng: 9.2 },
  { lat: 45.498, lng: 9.195 },
  { lat: 45.496, lng: 9.19 },
  { lat: 45.498, lng: 9.185 },
  { lat: 45.499, lng: 9.182 },
];

describe("logistics zone geometry", () => {
  it("reduces a dense outline to a few angular vertices", () => {
    const angular = toAngularZonePath(dense, 5);
    expect(angular.length).toBeGreaterThanOrEqual(3);
    expect(angular.length).toBeLessThanOrEqual(5);
  });

  it("shrinks the overlapping zone instead of leaving a coincidence", () => {
    const winner = [
      { lat: 45.5, lng: 9.18 },
      { lat: 45.5, lng: 9.2 },
      { lat: 45.52, lng: 9.2 },
      { lat: 45.52, lng: 9.18 },
    ];
    const loser = [
      { lat: 45.51, lng: 9.19 },
      { lat: 45.51, lng: 9.22 },
      { lat: 45.53, lng: 9.22 },
      { lat: 45.53, lng: 9.19 },
    ];
    expect(zonePolygonsOverlap(winner, loser)).toBe(true);
    const shrunk = shrinkZoneOutsideWinner(winner, loser);
    expect(shrunk.length).toBeGreaterThanOrEqual(3);
    expect(zonePolygonsOverlap(winner, shrunk)).toBe(false);
    expect(pointInLatLngPolygon({ lat: 45.515, lng: 9.195 }, shrunk)).toBe(false);
    expect(pointInLatLngPolygon({ lat: 45.52, lng: 9.21 }, shrunk)).toBe(true);
    expect(pointInLatLngPolygon({ lat: 45.525, lng: 9.195 }, shrunk)).toBe(true);
  });

  it("keeps a drawable outline instead of collapsing to a handful of hull points", () => {
    const drawable = toAngularZonePath(dense);
    expect(drawable.length).toBeGreaterThan(5);
    expect(drawable.length).toBeLessThanOrEqual(20);
  });

  it("keeps the outer zone around a fully covering inner zone", () => {
    const winner = [
      { lat: 45.51, lng: 9.19 },
      { lat: 45.51, lng: 9.21 },
      { lat: 45.53, lng: 9.21 },
      { lat: 45.53, lng: 9.19 },
    ];
    const loser = [
      { lat: 45.5, lng: 9.18 },
      { lat: 45.5, lng: 9.22 },
      { lat: 45.54, lng: 9.22 },
      { lat: 45.54, lng: 9.18 },
    ];
    const shrunk = shrinkZoneOutsideWinner(winner, loser);
    expect(shrunk.length).toBeGreaterThanOrEqual(3);
    expect(zonePolygonsOverlap(winner, shrunk)).toBe(false);
    expect(pointInLatLngPolygon({ lat: 45.52, lng: 9.2 }, shrunk)).toBe(false);
    expect(pointInLatLngPolygon({ lat: 45.505, lng: 9.2 }, shrunk)).toBe(true);
  });

  it("keeps the edited zone and only reduces the others", () => {
    const shapes = {
      0: [
        { lat: 45.5, lng: 9.18 },
        { lat: 45.5, lng: 9.2 },
        { lat: 45.52, lng: 9.2 },
        { lat: 45.52, lng: 9.18 },
      ],
      1: [
        { lat: 45.51, lng: 9.19 },
        { lat: 45.51, lng: 9.22 },
        { lat: 45.53, lng: 9.22 },
        { lat: 45.53, lng: 9.19 },
      ],
    };
    const resolved = resolveZoneShapeOverlaps(shapes, 0);
    expect(resolved[0]).toEqual(shapes[0]);
    expect(zonePolygonsOverlap(resolved[0], resolved[1])).toBe(false);
  });

  it("hides the lower outline where a higher zone covers it", () => {
    const lower = [
      { lat: 45.5, lng: 9.18 },
      { lat: 45.5, lng: 9.22 },
      { lat: 45.54, lng: 9.22 },
      { lat: 45.54, lng: 9.18 },
    ];
    const upper = [
      { lat: 45.51, lng: 9.19 },
      { lat: 45.51, lng: 9.21 },
      { lat: 45.53, lng: 9.21 },
      { lat: 45.53, lng: 9.19 },
    ];
    const outline = visibleZoneOutline(lower, [upper]);
    const points = outline.flat();
    expect(points.length).toBeGreaterThan(0);
    expect(points.some((point) => pointInLatLngPolygon(point, upper))).toBe(false);
    expect(points.some((point) => Math.abs(point.lat - 45.5) < 1e-6)).toBe(true);
  });
});
