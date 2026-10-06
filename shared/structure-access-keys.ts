/** Tipi accesso in `choices[].type` (mappa applicativa, non tabella DB). */
export const STRUCTURE_ACCESS_CHOICE_TYPE_LABELS: Record<number, string> = {
  0: "Classica",
  1: "Elettronica",
  2: "Codice",
  3: "QR Code",
};

export type StructureAccessChoice = {
  name: string;
  type: number | null;
  typeLabel: string | null;
  /** Codice / password / valore se presente nel JSON. */
  value: string | null;
};

export type StructureAccessBundle = {
  keysId: number | null;
  keysNumber: string | null;
  keysLabel: string | null;
  keysType: number | null;
  /** Label da `app_structure_keys` (es. Classico / Smart / KBox). */
  keysTypeLabel: string | null;
  keysTypeName: string | null;
  choices: StructureAccessChoice[];
};

export type StructureKeyTypeLookup = {
  id: number;
  name?: string | null;
  label?: string | null;
};

function asTrimmedString(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function asNullableNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseJsonArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return [];
  const text = raw.trim();
  if (!text || text === "null") return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function extractChoiceValue(choice: Record<string, unknown>): string | null {
  const candidates = [
    choice.value,
    choice.code,
    choice.codice,
    choice.password,
    choice.pass,
    choice.content,
    choice.text,
    choice.secret,
    choice.pin,
  ];
  for (const candidate of candidates) {
    const text = asTrimmedString(candidate);
    if (text) return text;
  }
  return null;
}

function parseChoice(raw: unknown): StructureAccessChoice | null {
  if (!raw || typeof raw !== "object") return null;
  const choice = raw as Record<string, unknown>;
  const name = asTrimmedString(choice.name);
  if (!name) return null;
  const type = asNullableNumber(choice.type);
  const typeLabel =
    type != null && Number.isInteger(type) ? STRUCTURE_ACCESS_CHOICE_TYPE_LABELS[type] ?? null : null;
  return {
    name,
    type: typeLabel ? type : null,
    typeLabel,
    value: extractChoiceValue(choice),
  };
}

function bundleSignature(bundle: StructureAccessBundle): string {
  const keys = bundle.choices
    .map((choice) => `${choice.name}\u0000${choice.typeLabel ?? ""}`)
    .join("\u0001");
  return [
    bundle.keysId ?? "",
    bundle.keysNumber ?? "",
    bundle.keysLabel ?? "",
    bundle.keysTypeLabel ?? "",
    keys,
  ].join("\u0002");
}

function dedupeStructureAccessBundles(bundles: StructureAccessBundle[]): StructureAccessBundle[] {
  const seen = new Set<string>();
  const unique: StructureAccessBundle[] = [];
  for (const bundle of bundles) {
    const signature = bundleSignature(bundle);
    if (seen.has(signature)) continue;
    seen.add(signature);
    unique.push(bundle);
  }
  return unique;
}

function compareStructureAccessBundles(a: StructureAccessBundle, b: StructureAccessBundle): number {
  const byNumber = (a.keysNumber ?? "").localeCompare(b.keysNumber ?? "", "it", { numeric: true });
  if (byNumber !== 0) return byNumber;
  const aId = a.keysId ?? Number.POSITIVE_INFINITY;
  const bId = b.keysId ?? Number.POSITIVE_INFINITY;
  if (aId !== bId) return aId - bId;
  return (a.keysLabel ?? "").localeCompare(b.keysLabel ?? "", "it", { sensitivity: "base" });
}

/**
 * Parsa `app_structures.structure_keys` e risolve `keys_type` → label
 * tramite lookup `app_structure_keys` (come in driver timeline ADAM).
 */
export function parseStructureAccessBundles(
  structureKeysRaw: unknown,
  keyTypes: Iterable<StructureKeyTypeLookup> = []
): StructureAccessBundle[] {
  const typeById = new Map<number, StructureKeyTypeLookup>();
  for (const entry of keyTypes) {
    const id = Number(entry?.id);
    if (!Number.isFinite(id)) continue;
    typeById.set(id, entry);
  }

  const bundles: StructureAccessBundle[] = [];
  for (const item of parseJsonArray(structureKeysRaw)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const keysType = asNullableNumber(row.keys_type ?? row.keysType);
    const lookup = keysType != null ? typeById.get(keysType) : undefined;
    const choicesRaw = Array.isArray(row.choices) ? row.choices : [];
    const choices = choicesRaw
      .map((choice) => parseChoice(choice))
      .filter((choice): choice is StructureAccessChoice => choice != null);

    const keysLabel = asTrimmedString(row.keys_label ?? row.keysLabel);
    const keysNumber = asTrimmedString(row.keys_number ?? row.keysNumber);
    const keysId = asNullableNumber(row.keys_id ?? row.keysId);

    if (
      keysId == null &&
      !keysNumber &&
      !keysLabel &&
      keysType == null &&
      choices.length === 0
    ) {
      continue;
    }

    bundles.push({
      keysId,
      keysNumber,
      keysLabel,
      keysType,
      keysTypeLabel: asTrimmedString(lookup?.label) ?? null,
      keysTypeName: asTrimmedString(lookup?.name) ?? null,
      choices,
    });
  }

  return bundles;
}

/** Preferisce i mazzi con label “autist*” (bundle destinati agli autisti). */
export function selectDriverAccessBundles(
  bundles: StructureAccessBundle[]
): StructureAccessBundle[] {
  if (!Array.isArray(bundles) || bundles.length === 0) return [];
  const unique = dedupeStructureAccessBundles(bundles);
  const driverBundles = unique.filter((bundle) =>
    /autist/i.test(String(bundle.keysLabel ?? ""))
  );
  const selected = driverBundles.length > 0 ? driverBundles : unique;
  return [...selected].sort(compareStructureAccessBundles);
}

export type StructureAccessBundlePresentation = {
  kind: "smart" | "kbox" | "classico";
  label: "Smart" | "KBox" | "Classico";
};

/** Simbolo UI sulla label del tipo mazzo: prima smart, poi kbox, altrimenti Classico. */
export function resolveStructureAccessBundlePresentation(
  typeLabel: string | null | undefined
): StructureAccessBundlePresentation {
  const haystack = String(typeLabel ?? "").toLowerCase();
  if (haystack.includes("smart")) return { kind: "smart", label: "Smart" };
  if (
    haystack.includes("keybox") ||
    haystack.includes("k-box") ||
    haystack.includes("kbox")
  ) {
    return { kind: "kbox", label: "KBox" };
  }
  return { kind: "classico", label: "Classico" };
}

export type StructureAccessKeyKind = "classico" | "smart" | "kbox" | "other";

export function resolveStructureAccessKeyKind(
  bundle: StructureAccessBundle | null | undefined
): StructureAccessKeyKind {
  const haystack = `${bundle?.keysTypeLabel ?? ""} ${bundle?.keysTypeName ?? ""}`.toLowerCase();
  if (/k\s*box|key\s*box|keybox/.test(haystack)) return "kbox";
  if (/smart/.test(haystack)) return "smart";
  if (/classic|classico/.test(haystack)) return "classico";
  return "other";
}

export function formatStructureAccessTypeLabel(
  bundle: StructureAccessBundle | null | undefined
): string {
  const label = asTrimmedString(bundle?.keysTypeLabel) ?? asTrimmedString(bundle?.keysTypeName);
  if (label) return label;
  const kind = resolveStructureAccessKeyKind(bundle);
  if (kind === "classico") return "Classico";
  if (kind === "smart") return "Smart";
  if (kind === "kbox") return "KBox";
  return "Chiave";
}
