import { describe, expect, it } from "vitest";
import {
  diffAssignedLogisticsContext,
  diffLogisticsProgramFields,
  sameLogisticsField,
} from "./logistics-assigned-sync-diff";

describe("diffLogisticsProgramFields", () => {
  it("elenca solo i campi programma diversi", () => {
    const changes = diffLogisticsProgramFields(
      { premium: false, pax_in: 2, address: "Via Roma 1", checkin_time: "10:00:00" },
      { premium: true, pax_in: 2, address: "Via Roma 1", checkin_time: "10:00" }
    );
    expect(changes).toEqual([
      { field: "premium", label: "Premium", from: "No", to: "Sì" },
    ]);
  });

  it("tratta booleani e orari equivalenti come invariati", () => {
    expect(sameLogisticsField("premium", false, 0)).toBe(true);
    expect(sameLogisticsField("premium", true, "1")).toBe(true);
    expect(sameLogisticsField("checkin_time", "09:00:00", "09:00")).toBe(true);
  });

  it("ignora l'arrotondamento delle coordinate a sei decimali", () => {
    expect(sameLogisticsField("lat", "45.450347", "45.4503469")).toBe(true);
    expect(sameLogisticsField("lng", "9.167387", "9.1673869")).toBe(true);
    expect(sameLogisticsField("lat", 45.4726, "45.4725999")).toBe(true);
    expect(sameLogisticsField("lat", "45.450347", "45.451000")).toBe(false);
    const changes = diffLogisticsProgramFields(
      { lat: "45.450347", lng: "9.167387", address: "Via Roma 1" },
      { lat: "45.4503469", lng: "9.1673869", address: "Via Torino 2" }
    );
    expect(changes).toEqual([
      { field: "address", label: "Indirizzo", from: "Via Roma 1", to: "Via Torino 2" },
    ]);
  });

  it("non mostra durata, attrezzatura, conferma, tipo appartamento e motivazioni", () => {
    const changes = diffLogisticsProgramFields(
      {
        cleaning_time: 60,
        base_cleaning_time: 60,
        small_equipment: false,
        confirmed_operation: false,
        type_apt: "A",
        reasons: ["not_eo", "lg_removed_leftover"],
        address: "Via Roma 1",
      },
      {
        cleaning_time: 90,
        base_cleaning_time: 90,
        small_equipment: true,
        confirmed_operation: true,
        type_apt: "B",
        reasons: ["not_eo"],
        address: "Via Torino 2",
      }
    );
    expect(changes).toEqual([
      { field: "address", label: "Indirizzo", from: "Via Roma 1", to: "Via Torino 2" },
    ]);
  });

  it("traduce la priorità", () => {
    const changes = diffLogisticsProgramFields(
      { priority: "high_priority" },
      { priority: "early_out" }
    );
    expect(changes).toEqual([
      { field: "priority", label: "Priorità", from: "High priority", to: "Early out" },
    ]);
  });
});

describe("diffAssignedLogisticsContext", () => {
  it("segnala operazione, cleaner, sequenza e finestra se già osservati", () => {
    const changes = diffAssignedLogisticsContext({
      observed: true,
      manualKind: false,
      hadStoredKind: true,
      beforeKind: "pick-up",
      afterKind: "delivery/pick-up",
      beforeCleanerLabel: "Maria",
      afterCleanerLabel: "Luca",
      beforeSequence: 1,
      afterSequence: 2,
      beforeHkStart: "09:00",
      afterHkStart: "11:00",
      beforeHkEnd: "12:00",
      afterHkEnd: "12:00",
    });
    expect(changes.map((change) => change.field)).toEqual([
      "logistics_task_kind",
      "cleaner",
      "cleaner_sequence",
      "hk_start_time",
    ]);
    expect(changes[0]).toMatchObject({ from: "PICK-UP", to: "D&P" });
    expect(changes[2]).toMatchObject({ from: "1", to: "2" });
  });

  it("non ricalcola il tipo manuale", () => {
    const changes = diffAssignedLogisticsContext({
      observed: true,
      manualKind: true,
      hadStoredKind: true,
      beforeKind: "delivery",
      afterKind: "delivery",
      beforeCleanerLabel: "Maria",
      afterCleanerLabel: "Maria",
      beforeSequence: 1,
      afterSequence: 2,
      beforeHkStart: null,
      afterHkStart: null,
      beforeHkEnd: null,
      afterHkEnd: null,
    });
    expect(changes.map((change) => change.field)).toEqual(["cleaner_sequence"]);
  });

  it("alla prima osservazione mostra il tipo salvato e non il cleaner ancora sconosciuto", () => {
    const changes = diffAssignedLogisticsContext({
      observed: false,
      manualKind: false,
      hadStoredKind: true,
      beforeKind: "pick-up",
      afterKind: "delivery/pick-up",
      beforeCleanerLabel: "",
      afterCleanerLabel: "Maria",
      beforeSequence: null,
      afterSequence: 2,
      beforeHkStart: null,
      afterHkStart: "09:00",
      beforeHkEnd: null,
      afterHkEnd: "11:00",
    });
    expect(changes).toEqual([
      {
        field: "logistics_task_kind",
        label: "Operazione logistica",
        from: "PICK-UP",
        to: "D&P",
      },
    ]);
  });
});
