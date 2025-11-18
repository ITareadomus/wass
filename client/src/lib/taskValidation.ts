/**
 * Utility per validare la compatibilità tra cleaner e task basata su settings.json
 */

interface TaskTypeRules {
  standard_cleaner: boolean;
  premium_cleaner: boolean;
  straordinaria_cleaner: boolean;
  formatore_cleaner: boolean;
}

interface TaskValidationSettings {
  task_types: {
    standard_apt: TaskTypeRules;
    premium_apt: TaskTypeRules;
    straordinario_apt: TaskTypeRules;
  };
}

// Define ValidationRules interface to match the structure expected by canCleanerHandleTaskSync
interface ValidationRules {
  task_types: {
    standard_apt: TaskTypeRules;
    premium_apt: TaskTypeRules;
    straordinario_apt: TaskTypeRules;
  };
}

let cachedRules: TaskValidationSettings['task_types'] | null = null;

/**
 * Carica le regole di validazione da settings.json
 */
export async function loadValidationRules(): Promise<TaskValidationSettings['task_types']> {
  if (cachedRules) {
    return cachedRules;
  }

  try {
    const response = await fetch(`/data/input/settings.json?t=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' }
    });

    if (!response.ok) {
      console.warn('⚠️ Warning: Could not load settings.json, using permissive defaults');
      return getDefaultRules();
    }

    const settings: TaskValidationSettings = await response.json();
    cachedRules = settings.task_types || getDefaultRules();
    return cachedRules;
  } catch (error) {
    console.warn('⚠️ Warning: Error loading settings.json:', error);
    return getDefaultRules();
  }
}

/**
 * Regole di default permissive (tutto permesso) in caso di errore
 */
function getDefaultRules(): TaskValidationSettings['task_types'] {
  return {
    standard_apt: {
      standard_cleaner: true,
      premium_cleaner: true,
      straordinaria_cleaner: true,
      formatore_cleaner: true
    },
    premium_apt: {
      standard_cleaner: true,
      premium_cleaner: true,
      straordinaria_cleaner: true,
      formatore_cleaner: true
    },
    straordinario_apt: {
      standard_cleaner: true,
      premium_cleaner: true,
      straordinaria_cleaner: true,
      formatore_cleaner: true
    }
  };
}

/**
 * Normalizza il tipo di task al formato usato in settings.json
 */
function normalizeTaskType(taskType: string | boolean): keyof TaskValidationSettings['task_types'] {
  if (typeof taskType === 'boolean') {
    // Se è un boolean (straordinaria o premium), usa la logica esistente
    return 'standard_apt'; // fallback
  }

  const type = taskType.toLowerCase();

  if (type.includes('straord')) {
    return 'straordinario_apt';
  } else if (type.includes('premium')) {
    return 'premium_apt';
  } else {
    return 'standard_apt';
  }
}

/**
 * Determina il tipo di task dalle sue proprietà
 */
export function getTaskType(task: { premium?: boolean; straordinaria?: boolean }): keyof TaskValidationSettings['task_types'] {
  if (task.straordinaria) {
    return 'straordinario_apt';
  } else if (task.premium) {
    return 'premium_apt';
  } else {
    return 'standard_apt';
  }
}

/**
 * Normalizza il ruolo del cleaner al formato usato in settings.json
 */
function normalizeCleanerRole(role: string): keyof TaskTypeRules {
  const roleLower = role.toLowerCase();

  if (roleLower.includes('form')) {
    return 'formatore_cleaner';
  } else if (roleLower.includes('straord')) {
    return 'straordinaria_cleaner';
  } else if (roleLower.includes('premium')) {
    return 'premium_cleaner';
  } else {
    return 'standard_cleaner';
  }
}

/**
 * Helper function to determine task type key (used internally by canCleanerHandleTaskSync)
 */
function determineTaskType(task: any): keyof TaskValidationSettings['task_types'] | null {
  if (typeof task === 'object' && task !== null) {
    return getTaskType(task);
  } else if (typeof task === 'string') {
    return normalizeTaskType(task);
  }
  return null;
}

/**
 * Verifica se un cleaner può gestire un determinato tipo di task (versione sincrona)
 * Richiede che le regole siano già state caricate
 */
export function canCleanerHandleTaskSync(
  cleanerRole: string,
  task: any,
  rules: ValidationRules | null,
  canDoStraordinaria: boolean = false
): boolean {
  if (!rules) return true;

  const taskType = determineTaskType(task);
  if (!taskType) return true;

  // Per straordinarie, usa il flag can_do_straordinaria del cleaner
  if (taskType === 'straordinario_apt') {
    return canDoStraordinaria;
  }

  const normalizedRole = normalizeCleanerRole(cleanerRole);
  // FIX: normalizedRole è già una chiave di TaskTypeRules (es. "premium_cleaner")
  const roleKey: keyof TaskTypeRules = normalizedRole;

  const taskRules = rules.task_types?.[taskType];
  if (!taskRules) return true;

  return taskRules[roleKey] ?? false;
}

/**
 * Verifica se un cleaner può gestire un determinato tipo di task (versione async)
 */
export async function canCleanerHandleTask(
  cleanerRole: string,
  taskType: string | { premium?: boolean; straordinaria?: boolean },
  cleanerData?: { can_do_straordinaria?: boolean } // Added cleanerData to pass can_do_straordinaria
): Promise<boolean> {
  const rules = await loadValidationRules();
  const canDoStraordinaria = cleanerData?.can_do_straordinaria ?? false; // Get the flag
  return canCleanerHandleTaskSync(cleanerRole, taskType, rules, canDoStraordinaria); // Pass the flag
}

/**
 * Restituisce un messaggio di warning se l'assegnazione non è valida
 */
export async function getValidationWarning(
  cleanerRole: string,
  taskType: string | { premium?: boolean; straordinaria?: boolean },
  cleanerData?: { can_do_straordinaria?: boolean } // Added cleanerData
): Promise<string | null> {
  const isValid = await canCleanerHandleTask(cleanerRole, taskType, cleanerData); // Pass cleanerData

  if (!isValid) {
    let taskTypeName = '';
    if (typeof taskType === 'object') {
      const type = getTaskType(taskType);
      taskTypeName = type === 'straordinario_apt' ? 'Straordinaria' :
                     type === 'premium_apt' ? 'Premium' : 'Standard';
    } else {
      taskTypeName = taskType;
    }

    return `⚠️ Cleaner ${cleanerRole} non dovrebbe gestire task ${taskTypeName}`;
  }

  return null;
}

/**
 * Verifica se un'assegnazione è incompatibile (per evidenziazione visiva)
 */
export async function isIncompatibleAssignment(
  cleanerRole: string,
  task: { premium?: boolean; straordinaria?: boolean },
  cleanerData?: { can_do_straordinaria?: boolean } // Added cleanerData
): Promise<boolean> {
  const isValid = await canCleanerHandleTask(cleanerRole, task, cleanerData); // Pass cleanerData
  return !isValid;
}

/**
 * Invalida la cache delle regole (utile dopo un reload di settings.json)
 */
export function invalidateRulesCache(): void {
  cachedRules = null;
}