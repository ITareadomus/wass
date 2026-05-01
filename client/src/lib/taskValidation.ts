/**
 * Utility per validare la compatibilità tra cleaner e task basata su settings.json
 */

interface CleanerTaskRules {
  standard_apt: boolean;
  premium_apt: boolean;
  straordinario_apt: boolean;
}

interface TaskTypesByCleaner {
  [role: string]: CleanerTaskRules;
}

interface ApartmentTypesConfig {
  standard_apt?: string[];
  premium_apt?: string[];
  straordinario_apt?: string[];
  formatore_apt?: string[];
}

interface PriorityTypesConfig {
  [role: string]: {
    early_out?: boolean;
    high_priority?: boolean;
    low_priority?: boolean;
  };
}

interface SettingsSchema {
  task_types: TaskTypesByCleaner;
  apartment_types?: ApartmentTypesConfig;
  priority_types?: PriorityTypesConfig;
}

let cachedRules: TaskTypesByCleaner | null = null;
let cachedApartmentTypes: ApartmentTypesConfig | null = null;
let cachedPriorityTypes: PriorityTypesConfig | null = null;
let cachedOfficeOperationIds: Set<number> | null = null;
const CONTINUAZIONE_PS_OPERATION_ID = 37;
const CONTINUAZIONE_PS_OPERATION_NAME = "continuazione ps";

const OFFICE_OPERATION_NAMES = new Set([
  "pulizia uffici",
  "pulizia uffici/altro",
  "pulizia uffici straordinaria",
]);
const OFFICE_OPERATION_IDS_FALLBACK = new Set<number>([15]);

async function loadOfficeOperationIds(): Promise<void> {
  if (cachedOfficeOperationIds) return;
  cachedOfficeOperationIds = new Set<number>();
  try {
    const response = await fetch("/api/operations", {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!response.ok) return;
    const data = await response.json();
    const operations = Array.isArray(data?.active_operations) ? data.active_operations : [];
    for (const operation of operations) {
      const id = Number(operation?.id);
      const normalizedName = String(operation?.name ?? "").toLowerCase().trim();
      if (
        Number.isFinite(id) &&
        (OFFICE_OPERATION_NAMES.has(normalizedName) || normalizedName.includes("uffic"))
      ) {
        cachedOfficeOperationIds.add(id);
      }
    }
  } catch {
    // Best effort: if this fails, office detection still works from task operation name.
  }
}

export async function loadValidationRules(): Promise<TaskTypesByCleaner> {
  if (cachedRules) return cachedRules;

  try {
    const response = await fetch('/api/settings', {
      cache: "no-store",
      headers: { 'Cache-Control': 'no-cache' }
    });

    // If the response is not ok, we should still return default rules to avoid crashing
    if (!response.ok) {
      console.warn('⚠️ Warning: Could not load settings from API, using empty rules and no apartment types.');
      cachedRules = {};
      cachedApartmentTypes = null;
      return cachedRules;
    }

    const settings: SettingsSchema = await response.json();
    cachedRules = settings.task_types ?? {};
    cachedApartmentTypes = settings.apartment_types ?? null;
    cachedPriorityTypes = settings.priority_types ?? null;
    await loadOfficeOperationIds();

    return cachedRules;
  } catch (error) {
    console.warn('⚠️ Warning: Error loading settings from API:', error);
    cachedRules = {};
    cachedApartmentTypes = null;
    return cachedRules;
  }
}

function normalizeCleanerRole(role: string): string {
  if (!role) return 'standard_cleaner';
  const normalized = role.toLowerCase().trim();

  if (normalized.includes('standard')) return 'standard_cleaner';
  if (normalized.includes('premium')) return 'premium_cleaner';
  if (normalized.includes('ufficio')) return 'ufficio_cleaner';
  if (normalized.includes('straord')) return 'straordinario_cleaner';
  if (normalized.includes('straordinario')) return 'straordinario_cleaner';
  if (normalized.includes('straordinaria')) return 'straordinario_cleaner';
  if (normalized.includes('formatore')) return 'formatore_cleaner';

  // If none of the specific roles match, return the normalized role itself.
  // This might be useful for custom cleaner roles not explicitly handled.
  return normalized;
}

function normalizeApartmentValue(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "";

  // Accept labels like "Tipo B" and extract the canonical code.
  const match = normalized.match(/^tipo\s*([a-z])$/i);
  if (match?.[1]) return match[1].toUpperCase();

  // Canonical apartment type is a single uppercase letter (A, B, C, ...).
  return normalized.toUpperCase();
}

function normalizeTaskPriority(value: unknown): "early_out" | "high_priority" | "low_priority" | null {
  const priority = String(value ?? "").trim().toLowerCase();
  if (!priority) return null;

  if (priority === "early_out" || priority === "early-out" || priority === "eo" || priority.includes("early")) {
    return "early_out";
  }

  if (priority === "high_priority" || priority === "high-priority" || priority === "high" || priority === "hp") {
    return "high_priority";
  }

  if (priority === "low_priority" || priority === "low-priority" || priority === "low" || priority === "lp") {
    return "low_priority";
  }

  return null;
}

function isOfficeTask(task: any): boolean {
  if (typeof task !== "object" || task === null) return false;

  const operationIdRaw = task.operation_id ?? task.operationId;
  const operationId = operationIdRaw != null ? Number(operationIdRaw) : NaN;
  if (
    Number.isFinite(operationId) &&
    (cachedOfficeOperationIds?.has(operationId) || OFFICE_OPERATION_IDS_FALLBACK.has(operationId))
  ) {
    return true;
  }

  const operationName = String(
    task.operation_name ??
      task.operationName ??
      task.operation_label ??
      ""
  )
    .toLowerCase()
    .trim();
  return OFFICE_OPERATION_NAMES.has(operationName) || operationName.includes("uffic");
}

export function isContinuazioneStraordinariaTask(task: any): boolean {
  if (typeof task !== "object" || task === null) return false;

  const operationIdRaw =
    task.operation_id ??
    task.operationId;
  const operationId = operationIdRaw != null ? Number(operationIdRaw) : NaN;
  if (!Number.isFinite(operationId) || operationId !== CONTINUAZIONE_PS_OPERATION_ID) {
    return false;
  }

  const operationNameRaw =
    task.operation_name ??
    task.operationName ??
    task.operation_label;
  if (operationNameRaw == null) return true;

  const normalizedName = String(operationNameRaw).toLowerCase().trim();
  return normalizedName === CONTINUAZIONE_PS_OPERATION_NAME;
}

export function isTaskLocked(task: any): boolean {
  if (typeof task !== "object" || task === null) return false;
  const lockedRaw = task.locked ?? task.is_locked ?? task.task_locked;
  if (lockedRaw === true) return true;
  if (lockedRaw === false || lockedRaw == null) return false;
  if (typeof lockedRaw === "number") return lockedRaw === 1;
  if (typeof lockedRaw === "string") {
    const normalized = lockedRaw.trim().toLowerCase();
    return normalized === "1" || normalized === "true";
  }
  return Boolean(lockedRaw);
}

type TaskTypeKey = keyof CleanerTaskRules;

function determineTaskType(task: any): TaskTypeKey | null {
  // Ensure task is an object and not null before accessing properties
  if (typeof task !== 'object' || task === null) {
    return null;
  }

  const isPremium = Boolean(task.premium);
  const isStraordinaria = Boolean(task.straordinaria) || isContinuazioneStraordinariaTask(task);

  if (isStraordinaria) return 'straordinario_apt';
  if (isPremium) return 'premium_apt';
  return 'standard_apt';
}

function canHandleApartment(cleanerRole: string, task: any): boolean {
  // If apartment types are not configured, assume any apartment type is allowed.
  if (!cachedApartmentTypes) return true;

  // Extract apartment type from task, checking for common naming conventions.
  const aptType = normalizeApartmentValue(task.apt_type || task.aptType || task.type_apt);

  // If no apartment type is specified in the task, assume it's allowed.
  if (!aptType) return true;

  const roleKey = normalizeCleanerRole(cleanerRole);

  let allowedApts: string[] = [];
  if (roleKey === 'standard_cleaner') {
    allowedApts = cachedApartmentTypes.standard_apt || [];
  } else if (roleKey === 'premium_cleaner' || roleKey === 'straordinario_cleaner') {
    // Both premium and straordinario cleaners can handle premium apartments
    allowedApts = cachedApartmentTypes.premium_apt || [];
  } else if (roleKey === 'formatore_cleaner') {
    allowedApts = cachedApartmentTypes.formatore_apt || [];
  } else {
    // For any other cleaner roles, check if there's a general fallback or no specific rules.
    // If we want to be strict, we could return false here. For now, assume if no rule, it's allowed.
    return true;
  }

  // Check if the task's apartment type is included in the allowed list for the cleaner's role.
  const normalizedAllowedApts = allowedApts.map(normalizeApartmentValue).filter(Boolean);
  return normalizedAllowedApts.includes(aptType);
}

export function canCleanerHandleTaskSync(
  cleanerRole: string,
  task: any,
  rules: TaskTypesByCleaner | null,
): boolean {
  // If no rules are provided, assume any task can be handled.
  if (!rules) return true;

  const roleKey = normalizeCleanerRole(cleanerRole);
  const officeTask = isOfficeTask(task);

  // Regola semplificata ufficio: task ufficio solo a cleaner con ruolo Ufficio.
  if (officeTask) return roleKey === 'ufficio_cleaner';
  // Cleaner ufficio non gestisce task non-ufficio.
  if (roleKey === 'ufficio_cleaner') return false;

  const taskType = determineTaskType(task);
  // If the task type cannot be determined, assume it can be handled.
  if (!taskType) return true;

  // Get the specific rules for the cleaner's role.
  const roleRules = rules[roleKey];
  // If there are no specific rules for this role, assume it can handle the task.
  if (!roleRules) return true;

  // Straordinario tasks: only cleaners with role "Straordinario" can handle them
  if (taskType === "straordinario_apt") {
    return roleKey === 'straordinario_cleaner';
  }

  // Check if the cleaner's role is allowed to handle this specific task type based on task_types rules.
  const allowedByTaskType = roleRules[taskType];
  if (!allowedByTaskType) return false;

  // CRITICAL: Check apartment type compatibility FIRST (before priority)
  // Extract apt_type from task (checking common field names)
  const aptType = normalizeApartmentValue(task.apt_type || task.aptType || task.type_apt);
  
  if (aptType && cachedApartmentTypes) {
    let allowedApts: string[] = [];
    
    if (roleKey === 'standard_cleaner') {
      allowedApts = cachedApartmentTypes.standard_apt || [];
    } else if (roleKey === 'premium_cleaner') {
      allowedApts = cachedApartmentTypes.premium_apt || [];
    } else if (roleKey === 'straordinario_cleaner') {
      allowedApts = cachedApartmentTypes.straordinario_apt || [];
    } else if (roleKey === 'formatore_cleaner') {
      allowedApts = cachedApartmentTypes.formatore_apt || [];
    }

    const normalizedAllowedApts = allowedApts.map(normalizeApartmentValue).filter(Boolean);
    // If the apartment type is NOT in the allowed list, return false
    if (normalizedAllowedApts.length > 0 && !normalizedAllowedApts.includes(aptType)) {
      return false;
    }
  }

  // NEW: Check priority compatibility (EO/HP/LP)
  if (cachedPriorityTypes) {
    const priorityRules = cachedPriorityTypes[roleKey];
    
    if (priorityRules) {
      // CRITICAL: Determina la priorità della task dal campo "priority" (stringa)
      // Le task in timeline.json hanno "priority": "early_out" | "high_priority" | "low_priority"
      const taskPriority = normalizeTaskPriority(task.priority || task.task_priority);

      if (taskPriority === 'early_out' && !priorityRules.early_out) {
        return false;
      }

      if (taskPriority === 'high_priority' && !priorityRules.high_priority) {
        return false;
      }

      if (taskPriority === 'low_priority' && !priorityRules.low_priority) {
        return false;
      }
    }
  }

  // If all checks pass, the cleaner can handle the task.
  return true;
}