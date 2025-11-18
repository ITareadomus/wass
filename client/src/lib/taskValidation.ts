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