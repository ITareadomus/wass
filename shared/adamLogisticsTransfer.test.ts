import { describe, expect, it } from "vitest";
import {
  buildLogisticsAdamUpdates,
  formatLogisticsTimeForMySQL,
} from "../server/services/adam-logistics-transfer-service";
import {
  fromAdamLogisticsOperation,
  toAdamLogisticsOperation,
} from "./logistics-task-kind";

describe("toAdamLogisticsOperation", () => {
  it("mappa i kind WASS ai codici numerici ADAM (VARCHAR)", () => {
    expect(toAdamLogisticsOperation("delivery")).toBe("1");
    expect(toAdamLogisticsOperation("pick-up")).toBe("2");
    expect(toAdamLogisticsOperation("delivery/pick-up")).toBe("3");
  });

  it("restituisce null per valori non riconosciuti", () => {
    expect(toAdamLogisticsOperation(null)).toBeNull();
    expect(toAdamLogisticsOperation("")).toBeNull();
    expect(toAdamLogisticsOperation("qualcosa")).toBeNull();
  });

  it("fa round-trip con fromAdamLogisticsOperation", () => {
    for (const kind of ["delivery/pick-up", "delivery", "pick-up"] as const) {
      expect(fromAdamLogisticsOperation(toAdamLogisticsOperation(kind))).toBe(kind);
    }
  });

  it("legge ancora i codici testuali legacy da ADAM", () => {
    expect(fromAdamLogisticsOperation("delivery")).toBe("delivery");
    expect(fromAdamLogisticsOperation("pick-up")).toBe("pick-up");
    expect(fromAdamLogisticsOperation("d&p")).toBe("delivery/pick-up");
  });
});

describe("formatLogisticsTimeForMySQL", () => {
  it("normalizza HH:MM in HH:MM:SS", () => {
    expect(formatLogisticsTimeForMySQL("9:30")).toBe("09:30:00");
    expect(formatLogisticsTimeForMySQL("14:05")).toBe("14:05:00");
    expect(formatLogisticsTimeForMySQL("14:05:30")).toBe("14:05:30");
  });

  it("scarta valori non orari", () => {
    expect(formatLogisticsTimeForMySQL(null)).toBeNull();
    expect(formatLogisticsTimeForMySQL("")).toBeNull();
    expect(formatLogisticsTimeForMySQL("25:00")).toBeNull();
    expect(formatLogisticsTimeForMySQL("abc")).toBeNull();
  });
});

describe("buildLogisticsAdamUpdates", () => {
  it("appiattisce la timeline mantenendo la prima assegnazione per task", () => {
    const updates = buildLogisticsAdamUpdates({
      drivers_assignments: [
        {
          driver: { id: 7 },
          tasks: [
            {
              task_id: 101,
              sequence: 1,
              travel_time: 12,
              start_time: "10:15",
              end_time: "10:30",
              logistics_task_kind: "delivery/pick-up",
            },
            {
              task_id: 102,
              sequence: 2,
              travel_time: 0,
              start_time: "10:45",
              end_time: "11:00",
            },
          ],
        },
        {
          driver: { id: 9 },
          tasks: [
            {
              task_id: 101,
              sequence: 9,
              travel_time: 99,
              start_time: "18:00",
              end_time: "18:15",
            },
          ],
        },
      ],
    });

    expect(updates).toEqual([
      {
        taskId: 101,
        driverId: 7,
        sequence: 1,
        travelTime: 12,
        startTime: "10:15:00",
        endTime: "10:30:00",
        operation: "3",
      },
      {
        taskId: 102,
        driverId: 7,
        sequence: 2,
        travelTime: 0,
        startTime: "10:45:00",
        endTime: "11:00:00",
        operation: null,
      },
    ]);
  });

  it("usa la sequence di PG quando è valorizzata", () => {
    const updates = buildLogisticsAdamUpdates({
      drivers_assignments: [
        {
          driver: { id: 5 },
          tasks: [
            { task_id: 2, sequence: 2, start_time: "09:00", end_time: "09:15" },
            { task_id: 1, sequence: 1, start_time: "18:00", end_time: "18:15" },
          ],
        },
      ],
    });

    expect(updates.map((u) => ({ taskId: u.taskId, sequence: u.sequence }))).toEqual([
      { taskId: 1, sequence: 1 },
      { taskId: 2, sequence: 2 },
    ]);
  });

  it("ricalcola 1..n solo se sequence PG manca o è 0", () => {
    const updates = buildLogisticsAdamUpdates({
      drivers_assignments: [
        {
          driver: { id: 5 },
          tasks: [
            { task_id: 30, sequence: 0, start_time: "12:00", end_time: "12:15" },
            { task_id: 10, sequence: 0, start_time: "10:00", end_time: "10:15" },
            { task_id: 20, sequence: 0, start_time: "11:00", end_time: "11:15" },
          ],
        },
      ],
    });

    expect(updates.map((u) => ({ taskId: u.taskId, sequence: u.sequence }))).toEqual([
      { taskId: 10, sequence: 1 },
      { taskId: 20, sequence: 2 },
      { taskId: 30, sequence: 3 },
    ]);
  });

  it("ignora driver e task non validi", () => {
    const updates = buildLogisticsAdamUpdates({
      drivers_assignments: [
        { driver: { id: 0 }, tasks: [{ task_id: 1 }] },
        { driver: null, tasks: [{ task_id: 2 }] },
        { driver: { id: 5 }, tasks: [{ task_id: null }, { task_id: 3 }] },
      ],
    });

    expect(updates.map((u) => u.taskId)).toEqual([3]);
    expect(updates[0]?.sequence).toBe(1);
  });

  it("restituisce lista vuota su timeline assente", () => {
    expect(buildLogisticsAdamUpdates(null)).toEqual([]);
    expect(buildLogisticsAdamUpdates({})).toEqual([]);
  });
});
