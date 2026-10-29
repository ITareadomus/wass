import { describe, expect, it } from "vitest";
import {
  buildKeyRegistry,
  cleanersWithPhysicalKeys,
  daysSinceWorkDate,
  hasClassicKey,
  isLostKeyVisible,
  isLostKeyListed,
  registryKeyIcon,
  keyHandoverStatus,
  nextKeyHandoverStatus,
  priorAlertTone,
  selectKeyRegistryTasks,
} from "./key-registry";
import type { StructureAccessBundle } from "./structure-access-keys";

function bundle(label: string): StructureAccessBundle {
  return {
    keysId: 1,
    keysNumber: "1",
    keysLabel: null,
    keysType: 1,
    keysTypeLabel: label,
    keysTypeName: label,
    choices: [],
  };
}

describe("registryKeyIcon", () => {
  it("sceglie il simbolo in base ai tipi presenti", () => {
    expect(registryKeyIcon([])).toBe("none");
    expect(registryKeyIcon([bundle("Smart"), bundle("Smart")])).toBe("smart");
    expect(registryKeyIcon([bundle("KBox")])).toBe("kbox");
    expect(registryKeyIcon([bundle("Smart"), bundle("KBox")])).toBe("smart-kbox");
    expect(registryKeyIcon([bundle("Classico"), bundle("Smart")])).toBe("classico");
    expect(registryKeyIcon([{ ...bundle("Altro"), keysTypeLabel: "Badge", keysTypeName: "Badge" }])).toBe("unknown");
  });
});

describe("hasClassicKey", () => {
  it("conta più mazzi classici come una sola chiave", () => {
    expect(hasClassicKey([bundle("Classico"), bundle("Classico")])).toBe(true);
  });

  it("ignora smart e kbox", () => {
    expect(hasClassicKey([bundle("Smart"), bundle("KBox")])).toBe(false);
  });

  it("include l'appartamento se c'è almeno un mazzo classico", () => {
    expect(hasClassicKey([bundle("Smart"), bundle("Classico")])).toBe(true);
  });
});

describe("stato consegna", () => {
  it("distingue magazzino, cleaner e restituzione", () => {
    expect(keyHandoverStatus({ delivered: false, returned: false })).toBe("warehouse");
    expect(keyHandoverStatus({ delivered: true, returned: false })).toBe("with_cleaner");
    expect(keyHandoverStatus({ delivered: true, returned: true })).toBe("returned");
    expect(keyHandoverStatus({ delivered: false, returned: false, lost: true })).toBe("warehouse");
    expect(nextKeyHandoverStatus("warehouse")).toBe("with_cleaner");
    expect(nextKeyHandoverStatus("with_cleaner")).toBe("returned");
    expect(nextKeyHandoverStatus("returned")).toBe("warehouse");
  });

  it("il triangolo dei giorni successivi è rosso se la chiave è smarrita, altrimenti giallo", () => {
    expect(priorAlertTone([])).toBeNull();
    expect(priorAlertTone([{ kind: "unreturned", workDate: "2026-09-28", logisticCode: "1", cleanerName: "A", matricola: null, aptCode: null, customerName: null }])).toBe("unreturned");
    expect(priorAlertTone([
      { kind: "unreturned", workDate: "2026-09-28", logisticCode: "1", cleanerName: "A", matricola: null, aptCode: null, customerName: null },
      { kind: "lost", workDate: "2026-09-20", logisticCode: "1", cleanerName: "A", matricola: null, aptCode: null, customerName: null },
    ])).toBe("lost");
  });
});

describe("chiavi non restituite", () => {
  it("mostra solo i giorni già passati e conta i giorni mancanti", () => {
    expect(isLostKeyVisible("2026-10-17", "2026-10-18")).toBe(true);
    expect(isLostKeyVisible("2026-10-18", "2026-10-18")).toBe(false);
    expect(isLostKeyListed("2026-10-18", "2026-10-18")).toBe(true);
    expect(isLostKeyListed("2026-10-19", "2026-10-18")).toBe(false);
    expect(daysSinceWorkDate("2026-10-15", "2026-10-18")).toBe(3);
    expect(daysSinceWorkDate("2026-10-17", "2026-10-18")).toBe(1);
  });
});

describe("buildKeyRegistry", () => {
  const cleaners = [
    { id: 2, name: "Luca", lastname: "Bianchi", matricola: "C02" },
    { id: 1, name: "Maria", lastname: "Rossi", matricola: "C18" },
  ];

  it("raggruppa per cleaner e segna la consegna", () => {
    const rows = buildKeyRegistry({
      cleaners,
      tasks: [
        {
          taskId: 10,
          logisticCode: "200",
          cleanerId: 1,
          sequence: 2,
          startTime: "11:00",
          address: "Via Roma",
          aptCode: "A2",
          customerName: "Mario Rossi",
          interventionType: "Partenza",
          keyBundles: [bundle("Classico"), bundle("Smart")],
          isPrimary: null,
        },
        {
          taskId: 11,
          logisticCode: "100",
          cleanerId: 1,
          sequence: 1,
          startTime: "10:00",
          address: "Via Verdi",
          aptCode: null,
          isPrimary: null,
        },
        {
          taskId: 12,
          logisticCode: "300",
          cleanerId: 2,
          sequence: 1,
          startTime: null,
          address: null,
          aptCode: null,
          isPrimary: null,
        },
        {
          taskId: 13,
          logisticCode: "999",
          cleanerId: 2,
          sequence: 2,
          startTime: null,
          address: "Solo smart",
          aptCode: null,
          keyBundles: [bundle("Smart")],
          isPrimary: null,
        },
        {
          taskId: 14,
          logisticCode: "888",
          cleanerId: 2,
          sequence: 3,
          startTime: null,
          address: "Senza chiavi",
          aptCode: null,
          isPrimary: null,
        },
      ],
      classicCodes: new Set(["100", "200", "300"]),
      deliveredTaskIds: new Set([10]),
      driverTaskIds: new Set([10]),
    });

    expect(rows.map((row) => row.lastname)).toEqual(["Rossi", "Bianchi"]);
    expect(rows[0].matricola).toBe("C18");
    expect(rows[0].apartments.map((apartment) => apartment.logisticCode)).toEqual(["100", "200"]);
    expect(rows[0].apartments[1].delivered).toBe(true);
    expect(rows[0].apartments[1].driverKey).toBe(true);
    expect(rows[0].apartments[0].driverKey).toBe(false);
    expect(rows[0].apartments[1].aptCode).toBe("A2");
    expect(rows[0].apartments[1].customerName).toBe("Mario Rossi");
    expect(rows[0].apartments[1].interventionType).toBe("Partenza");
    expect(rows[0].apartments[1].keyBundles.map((item) => item.keysTypeLabel)).toEqual([
      "Classico",
      "Smart",
    ]);
    expect(rows[0].apartments[0].interventionType).toBeNull();
    expect(rows[0].apartments[0].keyBundles).toEqual([]);
    expect(rows[0].apartments.every((apartment) => apartment.physicalKey)).toBe(true);
    expect(rows[1].apartments.map((apartment) => apartment.logisticCode)).toEqual(["300", "999"]);
    expect(rows[1].apartments.map((apartment) => apartment.physicalKey)).toEqual([true, false]);
  });

  it("mostra la task collaborativa solo sul cleaner primario", () => {
    const selected = selectKeyRegistryTasks([
      {
        taskId: 7,
        logisticCode: "100",
        cleanerId: 2,
        sequence: 1,
        startTime: null,
        address: null,
        aptCode: null,
        isPrimary: false,
      },
      {
        taskId: 7,
        logisticCode: "100",
        cleanerId: 1,
        sequence: 3,
        startTime: null,
        address: null,
        aptCode: null,
        isPrimary: true,
      },
    ]);
    expect(selected).toHaveLength(1);
    expect(selected[0].cleanerId).toBe(1);
  });

  it("con il filtro delle chiavi fisiche riordina sul primo appartamento fisico", () => {
    const apartment = (partial: {
      taskId: number;
      logisticCode: string;
      sequence: number;
      startTime: string | null;
      physicalKey: boolean;
    }) => ({
      aptCode: null,
      customerName: null,
      interventionType: null,
      keyBundles: [],
      delivered: false,
      returned: false,
      lost: false,
      driverKey: false,
      priorAlerts: [],
      ...partial,
    });
    const filtered = cleanersWithPhysicalKeys([
      {
        cleanerId: 1,
        name: "Anna",
        lastname: "Verdi",
        matricola: null,
        apartments: [
          apartment({ taskId: 1, logisticCode: "1", sequence: 1, startTime: "08:00", physicalKey: false }),
          apartment({ taskId: 2, logisticCode: "2", sequence: 2, startTime: "15:00", physicalKey: true }),
        ],
      },
      {
        cleanerId: 2,
        name: "Luca",
        lastname: "Neri",
        matricola: null,
        apartments: [
          apartment({ taskId: 3, logisticCode: "3", sequence: 1, startTime: "10:00", physicalKey: true }),
        ],
      },
    ]);
    expect(filtered.map((cleaner) => cleaner.lastname)).toEqual(["Neri", "Verdi"]);
    expect(filtered[1].apartments.map((apartment) => apartment.startTime)).toEqual(["15:00"]);
  });
});
