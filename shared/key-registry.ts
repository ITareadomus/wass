import { resolveStructureAccessKeyKind, type StructureAccessBundle } from "./structure-access-keys";

export type KeyRegistryCleanerInput = {
  id: number;
  name: string;
  lastname: string;
  matricola?: string | null;
};

export type KeyRegistryTaskInput = {
  taskId: number;
  logisticCode: string;
  cleanerId: number;
  sequence: number;
  startTime: string | null;
  address: string | null;
  aptCode: string | null;
  customerName?: string | null;
  interventionType?: string | null;
  keyBundles?: StructureAccessBundle[];
  operationId?: number | null;
  confirmedOperation?: boolean;
  /** true = cleaner primario della collaborazione, false = collaboratore, null = task singola. */
  isPrimary: boolean | null;
};

export type KeyRegistryApartment = {
  taskId: number;
  logisticCode: string;
  aptCode: string | null;
  customerName: string | null;
  interventionType: string | null;
  keyBundles: StructureAccessBundle[];
  sequence: number;
  startTime: string | null;
  /** Chiave classica: è la vista «solo chiavi fisiche». */
  physicalKey: boolean;
  delivered: boolean;
  returned: boolean;
  lost: boolean;
  /** Chiave dell'autista presa per questa task. */
  driverKey: boolean;
  priorAlerts: KeyPriorAlert[];
};

export type KeyPriorAlert = {
  kind: "lost" | "unreturned";
  workDate: string;
  logisticCode: string;
  cleanerName: string;
  matricola: string | null;
  aptCode: string | null;
  customerName: string | null;
};

export function priorAlertTone(alerts: KeyPriorAlert[] | null | undefined): "lost" | "unreturned" | null {
  if (!alerts?.length) return null;
  if (alerts.some((alert) => alert.kind === "lost")) return "lost";
  return "unreturned";
}

export type KeyHandoverStatus = "warehouse" | "with_cleaner" | "returned";

/** Grigio = in magazzino, ambra = consegnata, verde = restituita. */
export function keyHandoverStatus(flags: {
  delivered: boolean;
  returned?: boolean;
  lost?: boolean;
}): KeyHandoverStatus {
  if (flags.returned) return "returned";
  if (flags.delivered) return "with_cleaner";
  return "warehouse";
}

export function nextKeyHandoverStatus(status: KeyHandoverStatus): KeyHandoverStatus {
  if (status === "warehouse") return "with_cleaner";
  if (status === "with_cleaner") return "returned";
  return "warehouse";
}

export type KeyRegistryCleaner = {
  cleanerId: number;
  name: string;
  lastname: string;
  matricola: string | null;
  apartments: KeyRegistryApartment[];
};

/** Data di calendario a Roma, nel formato YYYY-MM-DD. */
export function calendarDateInRome(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Le chiavi non restituite compaiono solo se il giorno del registro è già passato. */
export function isLostKeyVisible(workDate: string, today: string): boolean {
  return workDate < today;
}

/** Le chiavi smarrite compaiono anche se sono state segnate oggi. */
export function isLostKeyListed(workDate: string, today: string): boolean {
  return workDate <= today;
}

export function daysSinceWorkDate(workDate: string, today: string): number {
  const [year, month, day] = workDate.split("-").map(Number);
  const [todayYear, todayMonth, todayDay] = today.split("-").map(Number);
  const start = Date.UTC(year, month - 1, day);
  const end = Date.UTC(todayYear, todayMonth - 1, todayDay);
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

/** Un appartamento conta come una sola chiave classica, anche con più mazzi classici. */
export function hasClassicKey(bundles: StructureAccessBundle[] | null | undefined): boolean {
  return (bundles ?? []).some((bundle) => resolveStructureAccessKeyKind(bundle) === "classico");
}

/** Simbolo nel registro: la classica vince; senza classica, Smart e KBox insieme usano la KBox. */
export type RegistryKeyIcon = "classico" | "smart" | "kbox" | "smart-kbox" | "unknown" | "none";

export function registryKeyIcon(bundles: StructureAccessBundle[] | null | undefined): RegistryKeyIcon {
  const list = bundles ?? [];
  if (list.length === 0) return "none";
  let hasClassic = false;
  let hasSmart = false;
  let hasKbox = false;
  for (const bundle of list) {
    if (bundle.keysType == null) continue;
    const kind = resolveStructureAccessKeyKind(bundle);
    if (kind === "classico") hasClassic = true;
    else if (kind === "smart") hasSmart = true;
    else if (kind === "kbox") hasKbox = true;
  }
  if (hasClassic) return "classico";
  if (hasSmart && hasKbox) return "smart-kbox";
  if (hasKbox) return "kbox";
  if (hasSmart) return "smart";
  return "unknown";
}

export function logisticCodeKeys(code: string): string[] {
  const trimmed = String(code ?? "").trim();
  if (!trimmed || trimmed === "0") return [];
  const keys = [trimmed];
  if (/^\d+$/.test(trimmed)) {
    const canonical = String(Number(trimmed));
    if (canonical !== trimmed && canonical !== "0") keys.push(canonical);
  }
  return keys;
}

function matchesClassicCode(logisticCode: string, classicCodes: Set<string>): boolean {
  return logisticCodeKeys(logisticCode).some((key) => classicCodes.has(key));
}

/**
 * Una task condivisa tra più cleaner compare una volta sola:
 * sul cleaner primario, altrimenti su quello con sequenza più bassa.
 */
export function selectKeyRegistryTasks(tasks: KeyRegistryTaskInput[]): KeyRegistryTaskInput[] {
  const byTask = new Map<number, KeyRegistryTaskInput[]>();
  for (const task of tasks) {
    const group = byTask.get(task.taskId) ?? [];
    group.push(task);
    byTask.set(task.taskId, group);
  }

  const selected: KeyRegistryTaskInput[] = [];
  for (const group of byTask.values()) {
    const primary = group.find((task) => task.isPrimary === true);
    if (primary) {
      selected.push(primary);
      continue;
    }
    const solo = group.filter((task) => task.isPrimary == null);
    const pool = solo.length > 0 ? solo : group;
    pool.sort((a, b) => a.sequence - b.sequence || a.cleanerId - b.cleanerId);
    selected.push(pool[0]);
  }
  return selected;
}

function firstStartTime(cleaner: KeyRegistryCleaner): string {
  return cleaner.apartments[0]?.startTime?.trim() || "99:99";
}

function compareCleaners(a: KeyRegistryCleaner, b: KeyRegistryCleaner): number {
  const byTime = firstStartTime(a).localeCompare(firstStartTime(b));
  if (byTime !== 0) return byTime;
  const byLastname = a.lastname.localeCompare(b.lastname, "it", { sensitivity: "base" });
  if (byLastname !== 0) return byLastname;
  const byName = a.name.localeCompare(b.name, "it", { sensitivity: "base" });
  if (byName !== 0) return byName;
  return a.cleanerId - b.cleanerId;
}

/** Solo chiavi fisiche, riordinate sullo start time del primo appartamento rimasto. */
export function cleanersWithPhysicalKeys<
  T extends {
    cleanerId: number;
    name: string;
    lastname: string;
    apartments: { physicalKey?: boolean; startTime: string | null }[];
  },
>(cleaners: T[]): T[] {
  const filtered = cleaners
    .map((cleaner) => ({
      ...cleaner,
      apartments: cleaner.apartments.filter((apartment) => apartment.physicalKey),
    }))
    .filter((cleaner) => cleaner.apartments.length > 0);
  filtered.sort((a, b) => {
    const byTime = (a.apartments[0]?.startTime?.trim() || "99:99").localeCompare(
      b.apartments[0]?.startTime?.trim() || "99:99",
    );
    if (byTime !== 0) return byTime;
    const byLastname = a.lastname.localeCompare(b.lastname, "it", { sensitivity: "base" });
    if (byLastname !== 0) return byLastname;
    const byName = a.name.localeCompare(b.name, "it", { sensitivity: "base" });
    if (byName !== 0) return byName;
    return a.cleanerId - b.cleanerId;
  });
  return filtered;
}

function compareApartments(a: KeyRegistryApartment, b: KeyRegistryApartment): number {
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  const aTime = a.startTime ?? "99:99";
  const bTime = b.startTime ?? "99:99";
  if (aTime !== bTime) return aTime.localeCompare(bTime);
  return a.logisticCode.localeCompare(b.logisticCode, "it", { numeric: true });
}

export function buildKeyRegistry(input: {
  cleaners: KeyRegistryCleanerInput[];
  tasks: KeyRegistryTaskInput[];
  classicCodes: Set<string>;
  deliveredTaskIds: Set<number>;
  returnedTaskIds?: Set<number>;
  lostTaskIds?: Set<number>;
  driverTaskIds?: Set<number>;
}): KeyRegistryCleaner[] {
  const cleanerById = new Map(input.cleaners.map((cleaner) => [cleaner.id, cleaner]));
  const selected = selectKeyRegistryTasks(input.tasks);
  const grouped = new Map<number, KeyRegistryApartment[]>();

  for (const task of selected) {
    const bundles = task.keyBundles ?? [];
    const physicalKey = matchesClassicCode(task.logisticCode, input.classicCodes);
    if (!physicalKey && registryKeyIcon(bundles) === "none") continue;
    const apartments = grouped.get(task.cleanerId) ?? [];
    apartments.push({
      taskId: task.taskId,
      logisticCode: task.logisticCode,
      aptCode: task.aptCode,
      customerName: task.customerName ?? null,
      interventionType: task.interventionType?.trim() || null,
      keyBundles: bundles,
      sequence: task.sequence,
      startTime: task.startTime,
      physicalKey,
      delivered: input.deliveredTaskIds.has(task.taskId),
      returned: input.returnedTaskIds?.has(task.taskId) ?? false,
      lost: input.lostTaskIds?.has(task.taskId) ?? false,
      driverKey: input.driverTaskIds?.has(task.taskId) ?? false,
      priorAlerts: [],
    });
    grouped.set(task.cleanerId, apartments);
  }

  const rows: KeyRegistryCleaner[] = [];
  for (const [cleanerId, apartments] of grouped) {
    const cleaner = cleanerById.get(cleanerId);
    apartments.sort(compareApartments);
    rows.push({
      cleanerId,
      name: cleaner?.name?.trim() ?? "",
      lastname: cleaner?.lastname?.trim() ?? "",
      matricola: cleaner?.matricola?.trim() || null,
      apartments,
    });
  }

  rows.sort(compareCleaners);
  return rows;
}
