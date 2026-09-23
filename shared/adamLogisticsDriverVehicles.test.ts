import { describe, expect, it } from "vitest";
import {
  applyResolvedVehicleStructureBindings,
  collectVehicleDriverBindings,
} from "../server/services/adam-logistics-vehicle-service";

describe("collectVehicleDriverBindings", () => {
  it("restituisce map vuota se non ci sono assegnazioni (clear ADAM)", () => {
    expect(collectVehicleDriverBindings(null).taskToDriver.size).toBe(0);
    expect(collectVehicleDriverBindings({}).taskToDriver.size).toBe(0);
    expect(collectVehicleDriverBindings(undefined).pendingStructureResolve).toEqual([]);
  });

  it("usa vehicle_task_id quando è già risolto", () => {
    const { taskToDriver, pendingStructureResolve } = collectVehicleDriverBindings({
      "101": { vehicle_id: 88, vehicle_task_id: 12345 },
    });
    expect(taskToDriver.get(12345)).toBe(101);
    expect(pendingStructureResolve).toEqual([]);
  });

  it("accoda lo structure_id se manca vehicle_task_id", () => {
    const { taskToDriver, pendingStructureResolve } = collectVehicleDriverBindings({
      "205": { vehicle_id: 77 },
    });
    expect(taskToDriver.size).toBe(0);
    expect(pendingStructureResolve).toEqual([{ structureId: 77, driverId: 205 }]);
  });

  it("ignora driver senza veicolo valido", () => {
    const { taskToDriver, pendingStructureResolve } = collectVehicleDriverBindings({
      "10": { vehicle_id: null },
      "11": {},
    });
    expect(taskToDriver.size).toBe(0);
    expect(pendingStructureResolve).toEqual([]);
  });
});

describe("applyResolvedVehicleStructureBindings", () => {
  it("completa il mapping dopo la risoluzione MySQL", () => {
    const taskToDriver = new Map<number, number>();
    applyResolvedVehicleStructureBindings(
      [{ structureId: 77, driverId: 205 }],
      new Map([[77, 999]]),
      taskToDriver
    );
    expect(taskToDriver.get(999)).toBe(205);
  });

  it("non assegna se lo structure_id non ha task", () => {
    const taskToDriver = new Map<number, number>();
    applyResolvedVehicleStructureBindings(
      [{ structureId: 77, driverId: 205 }],
      new Map(),
      taskToDriver
    );
    expect(taskToDriver.size).toBe(0);
  });
});
