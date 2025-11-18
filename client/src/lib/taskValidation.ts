export interface ValidationRules {
  task_types: {
    [key: string]: {
      [roleKey: string]: boolean;
    };
  };
  apartment_types?: {
    [roleKey: string]: string[];
  };
}

export async function loadValidationRules(): Promise<ValidationRules | null> {
  try {
    const response = await fetch('/data/input/settings.json');
    if (!response.ok) {
      console.error('Failed to load validation rules');
      return null;
    }
    const data = await response.json();
    return data as ValidationRules;
  } catch (error) {
    console.error('Error loading validation rules:', error);
    return null;
  }
}

function normalizeCleanerRole(role: string): string {
  const normalized = role.toLowerCase().trim();
  if (normalized === 'standard') return 'standard';
  if (normalized === 'premium') return 'premium';
  if (normalized === 'formatore') return 'formatore';
  return normalized;
}

function determineTaskType(task: any): string | null {
  if (task.straordinaria) return 'straordinario_apt';
  if (task.premium) return 'premium_apt';
  return 'standard_apt';
}

export function canCleanerHandleTaskSync(
  cleanerRole: string,
  task: any,
  validationRules: ValidationRules,
  canDoStraordinaria: boolean = false
): boolean {
  if (!validationRules || !cleanerRole) return true;

  const taskType = determineTaskType(task);
  if (!taskType) return true;

  // Per le straordinarie, usa il flag can_do_straordinaria
  if (taskType === 'straordinario_apt') {
    return canDoStraordinaria;
  }

  const normalizedRole = normalizeCleanerRole(cleanerRole);
  const taskRules = validationRules.task_types[taskType];

  if (!taskRules) return true;

  const roleKey = `${normalizedRole}_cleaner`;
  return taskRules[roleKey] === true;
}