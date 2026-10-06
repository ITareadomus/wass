import { describe, expect, it } from "vitest";
import {
  formatStructureAccessTypeLabel,
  parseStructureAccessBundles,
  resolveStructureAccessBundlePresentation,
  resolveStructureAccessKeyKind,
  selectDriverAccessBundles,
} from "./structure-access-keys";

const KEY_TYPES = [
  { id: 1, name: "classic", label: "Classico" },
  { id: 2, name: "smart", label: "Smart" },
  { id: 3, name: "kbox", label: "KBox" },
];

describe("parseStructureAccessBundles", () => {
  it("parsa JSON string e risolve keys_type → label", () => {
    const raw = JSON.stringify([
      {
        keys_id: 1,
        keys_number: "12",
        keys_label: "Autisti",
        keys_type: 2,
        choices: [
          { name: "Codice porta", type: 2, value: "4455" },
          { name: "QR ingresso", type: 3 },
        ],
      },
    ]);

    const bundles = parseStructureAccessBundles(raw, KEY_TYPES);
    expect(bundles).toHaveLength(1);
    expect(bundles[0]).toMatchObject({
      keysId: 1,
      keysNumber: "12",
      keysLabel: "Autisti",
      keysType: 2,
      keysTypeLabel: "Smart",
      keysTypeName: "smart",
    });
    expect(bundles[0].choices).toEqual([
      { name: "Codice porta", type: 2, typeLabel: "Codice", value: "4455" },
      { name: "QR ingresso", type: 3, typeLabel: "QR Code", value: null },
    ]);
  });

  it("accetta array già parsato e campi password/code", () => {
    const bundles = parseStructureAccessBundles(
      [
        {
          keys_id: 9,
          keys_label: "Cleaner",
          keys_type: 3,
          choices: [{ name: "Cassetta", type: 1, password: "AB12" }],
        },
      ],
      KEY_TYPES
    );
    expect(bundles[0].keysTypeLabel).toBe("KBox");
    expect(bundles[0].choices[0].value).toBe("AB12");
  });
});

describe("selectDriverAccessBundles", () => {
  it("preferisce label con autist", () => {
    const bundles = parseStructureAccessBundles(
      [
        { keys_id: 1, keys_label: "Cleaner", keys_type: 1 },
        { keys_id: 2, keys_label: "Autisti", keys_type: 2 },
      ],
      KEY_TYPES
    );
    const selected = selectDriverAccessBundles(bundles);
    expect(selected).toHaveLength(1);
    expect(selected[0].keysLabel).toBe("Autisti");
  });

  it("fallback a tutti i bundle se nessuno è autisti", () => {
    const bundles = parseStructureAccessBundles(
      [{ keys_id: 1, keys_label: "Cleaner", keys_type: 1 }],
      KEY_TYPES
    );
    expect(selectDriverAccessBundles(bundles)).toHaveLength(1);
  });
});

describe("resolveStructureAccessKeyKind / formatStructureAccessTypeLabel", () => {
  it("riconosce classico/smart/kbox", () => {
    expect(
      resolveStructureAccessKeyKind({
        keysId: 1,
        keysNumber: null,
        keysLabel: null,
        keysType: 1,
        keysTypeLabel: "Classico",
        keysTypeName: "classic",
        choices: [],
      })
    ).toBe("classico");
    expect(
      resolveStructureAccessKeyKind({
        keysId: 2,
        keysNumber: null,
        keysLabel: null,
        keysType: 2,
        keysTypeLabel: "Smart",
        keysTypeName: null,
        choices: [],
      })
    ).toBe("smart");
    expect(
      resolveStructureAccessKeyKind({
        keysId: 3,
        keysNumber: null,
        keysLabel: null,
        keysType: 3,
        keysTypeLabel: "KeyBox",
        keysTypeName: null,
        choices: [],
      })
    ).toBe("kbox");
    expect(
      formatStructureAccessTypeLabel({
        keysId: null,
        keysNumber: null,
        keysLabel: null,
        keysType: 2,
        keysTypeLabel: "Smart",
        keysTypeName: null,
        choices: [],
      })
    ).toBe("Smart");
  });
});

describe("structure keys per il dialog", () => {
  it("scarta choice senza nome e type fuori da 0-3", () => {
    const bundles = parseStructureAccessBundles(
      [
        {
          keys_id: 12,
          keys_number: "1",
          keys_label: "Autista",
          keys_type: 3,
          choices: [
            { name: "Portone", type: 0 },
            { type: 2 },
            { name: "Sconosciuta", type: 9 },
          ],
        },
      ],
      KEY_TYPES
    );
    expect(bundles[0].choices).toEqual([
      { name: "Portone", type: 0, typeLabel: "Classica", value: null },
      { name: "Sconosciuta", type: null, typeLabel: null, value: null },
    ]);
  });

  it("deduplica, tiene i mazzi autist e ordina per numero, id e label", () => {
    const bundles = parseStructureAccessBundles(
      [
        { keys_id: 3, keys_number: "10", keys_label: "Autisti", keys_type: 2, choices: [{ name: "A", type: 0 }] },
        { keys_id: 3, keys_number: "10", keys_label: "Autisti", keys_type: 2, choices: [{ name: "A", type: 0 }] },
        { keys_id: 2, keys_number: "2", keys_label: "Autista", keys_type: 1, choices: [{ name: "B", type: 1 }] },
        { keys_id: 9, keys_number: "1", keys_label: "Cleaner", keys_type: 1 },
      ],
      KEY_TYPES
    );
    const selected = selectDriverAccessBundles(bundles);
    expect(selected.map((bundle) => bundle.keysNumber)).toEqual(["2", "10"]);
    expect(selected.every((bundle) => /autist/i.test(bundle.keysLabel ?? ""))).toBe(true);
  });

  it("sceglie il simbolo smart prima di kbox, altrimenti Classico", () => {
    expect(resolveStructureAccessBundlePresentation("Smart KBox")).toEqual({
      kind: "smart",
      label: "Smart",
    });
    expect(resolveStructureAccessBundlePresentation("K-Box")).toEqual({
      kind: "kbox",
      label: "KBox",
    });
    expect(resolveStructureAccessBundlePresentation("Keybox")).toEqual({
      kind: "kbox",
      label: "KBox",
    });
    expect(resolveStructureAccessBundlePresentation(null)).toEqual({
      kind: "classico",
      label: "Classico",
    });
  });
});
