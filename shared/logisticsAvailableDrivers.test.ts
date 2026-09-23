import { describe, expect, it } from "vitest";
import {
  collectLiveLogisticsDriverIds,
  filterLogisticsDriversAvailableToAssign,
} from "./logistics-available-drivers";

describe("collectLiveLogisticsDriverIds", () => {
  it("include i convocati attivi e chi ha ancora task non rimosse", () => {
    const ids = collectLiveLogisticsDriverIds(
      [
        { id: 1, isRemoved: false },
        { id: 2, isRemoved: true },
        { id: 3 },
      ],
      [
        { driver: { id: 2, isRemoved: true }, tasks: [{ task_id: 10 }] },
        { driver: { id: 4 }, tasks: [{ task_id: 11 }] },
        { driver: { id: 5 }, tasks: [] },
      ]
    );
    expect(ids.sort((a, b) => a - b)).toEqual([1, 3, 4]);
  });

  it("non considera live la lane leftover dello stesso driver", () => {
    const ids = collectLiveLogisticsDriverIds(
      [
        { id: 7, isRemoved: false },
        { id: 7, isRemoved: true, leftoverLane: true },
      ],
      [
        { driver: { id: 7 }, tasks: [{ task_id: 1 }] },
        { driver: { id: 7, isRemoved: true, leftoverLane: true }, tasks: [{ task_id: 2 }] },
      ]
    );
    expect(ids).toEqual([7]);
  });
});

describe("filterLogisticsDriversAvailableToAssign", () => {
  const roster = [
    { id: 1, active: true },
    { id: 2, active: true },
    { id: 3, active: false },
    { id: 4, active: true },
  ];

  it("esclude solo i driver già live in timeline", () => {
    const available = filterLogisticsDriversAvailableToAssign(roster, [1]);
    expect(available.map((d) => d.id)).toEqual([2, 4]);
  });

  it("in sostituzione non ripropone un driver già live con task", () => {
    const available = filterLogisticsDriversAvailableToAssign(roster, [1, 2], 2);
    expect(available.map((d) => d.id)).toEqual([4]);
  });

  it("non ripropone il driver live nemmeno se si sostituisce la sua lane leftover", () => {
    const available = filterLogisticsDriversAvailableToAssign(roster, [1, 2], 1_000_000_002);
    expect(available.map((d) => d.id)).toEqual([4]);
  });

  it("permette di rimettere il driver rimosso se non è già live", () => {
    const available = filterLogisticsDriversAvailableToAssign(roster, [1], 2);
    expect(available.map((d) => d.id)).toEqual([2, 4]);
  });
});
