import { describe, expect, it } from "vitest";
import { rebalanceTasksByDriverQuota, resolveDeliveryQuotas } from "./logistics-delivery-quotas";

const drivers = [
  { driverId: 1, driverName: "Paolo" },
  { driverId: 2, driverName: "Walid" },
  { driverId: 3, driverName: "Brian" },
];

describe("resolveDeliveryQuotas", () => {
  it("lascia le zone invariate se nessuno ha un numero", () => {
    const result = resolveDeliveryQuotas({
      total: 50,
      drivers: drivers.map((driver) => ({ ...driver, quota: null })),
    });
    expect(result.error).toBeNull();
    expect(result.counts).toBeNull();
  });

  it("con un solo numero fisso divide il resto tra chi è lasciato all'algoritmo", () => {
    const result = resolveDeliveryQuotas({
      total: 50,
      drivers: [
        { ...drivers[0], quota: 7 },
        { ...drivers[1], quota: null },
        { ...drivers[2], quota: null },
      ],
    });
    expect(result.error).toBeNull();
    expect(result.remainder).toBe(43);
    expect(result.counts?.get(1)).toBe(7);
    expect((result.counts?.get(2) ?? 0) + (result.counts?.get(3) ?? 0)).toBe(43);
  });

  it("se resta un solo autista senza numero, gli assegna il resto", () => {
    const result = resolveDeliveryQuotas({
      total: 50,
      drivers: [
        { ...drivers[0], quota: 7 },
        { ...drivers[1], quota: 23 },
        { ...drivers[2], quota: null },
      ],
    });
    expect(result.error).toBeNull();
    expect(result.forcedDriverId).toBe(3);
    expect(result.counts?.get(3)).toBe(20);
  });

  it("segnala errore se i numeri espliciti non chiudono la giornata", () => {
    const result = resolveDeliveryQuotas({
      total: 50,
      drivers: [
        { ...drivers[0], quota: 7 },
        { ...drivers[1], quota: 23 },
        { ...drivers[2], quota: 15 },
      ],
    });
    expect(result.counts).toBeNull();
    expect(result.error).toMatch(/45 su 50/);
  });

  it("accetta i numeri che chiudono il totale", () => {
    const result = resolveDeliveryQuotas({
      total: 50,
      drivers: [
        { ...drivers[0], quota: 7 },
        { ...drivers[1], quota: 23 },
        { ...drivers[2], quota: 20 },
      ],
    });
    expect(result.error).toBeNull();
    expect(result.counts?.get(1)).toBe(7);
    expect(result.counts?.get(2)).toBe(23);
    expect(result.counts?.get(3)).toBe(20);
  });

  it("segnala errore se un numero supera il totale", () => {
    const result = resolveDeliveryQuotas({
      total: 50,
      drivers: [
        { ...drivers[0], quota: 60 },
        { ...drivers[1], quota: null },
        { ...drivers[2], quota: null },
      ],
    });
    expect(result.error).toMatch(/supera le 50/);
  });
});

describe("rebalanceTasksByDriverQuota", () => {
  it("porta ogni autista al numero richiesto e svuota il resto", () => {
    const tasks = Array.from({ length: 10 }, (_, index) => ({
      taskId: index + 1,
      lat: index < 4 ? 45.1 : index < 7 ? 45.2 : 45.3,
      lng: 9,
    }));
    const result = rebalanceTasksByDriverQuota(
      [
        { driverId: 1, tasks: tasks.slice(0, 4) },
        { driverId: 2, tasks: tasks.slice(4, 7) },
        { driverId: 3, tasks: tasks.slice(7) },
      ],
      [],
      new Map([
        [1, 2],
        [2, 3],
        [3, 5],
      ]),
    );
    expect(result.unassigned).toHaveLength(0);
    expect(result.drivers.map((driver) => driver.tasks.length)).toEqual([2, 3, 5]);
    const ids = result.drivers.flatMap((driver) => driver.tasks.map((task) => task.taskId));
    expect(new Set(ids).size).toBe(10);
  });
});
