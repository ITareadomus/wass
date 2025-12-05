import * as fs from 'fs/promises';
import path from 'path';
import { dailyAssignmentRevisionsService } from './daily-assignment-revisions-service';
import { formatInTimeZone } from 'date-fns-tz';

/**
 * Workspace Files Helper
 * 
 * Centralizes read/write operations for timeline.json, containers.json, and selected_cleaners.json
 * Storage: MySQL (primary) + filesystem (cache for Python scripts)
 * 
 * Read strategy: Try MySQL first, fallback to filesystem
 * Write strategy: Write to MySQL AND filesystem (dual write for Python script compatibility)
 */

const PATHS = {
  timeline: path.join(process.cwd(), 'client/public/data/output/timeline.json'),
  containers: path.join(process.cwd(), 'client/public/data/output/containers.json'),
  selectedCleaners: path.join(process.cwd(), 'client/public/data/cleaners/selected_cleaners.json'),
};

const TIMEZONE = 'Europe/Rome';

// Helper per ottenere timestamp nel timezone di Roma
function getRomeTimestamp(): string {
  return formatInTimeZone(new Date(), TIMEZONE, "yyyy-MM-dd HH:mm:ss");
}

/**
 * Normalize a cleaner object with correct field ordering
 * start_time is always included (defaults to "10:00" if not present)
 */
function getNormalizedCleaner(cleaner: any): any {
  if (!cleaner) return cleaner;
  
  const normalizedCleaner: any = {};
  
  if (cleaner.id !== undefined) normalizedCleaner.id = cleaner.id;
  if (cleaner.name !== undefined) normalizedCleaner.name = cleaner.name;
  if (cleaner.lastname !== undefined) normalizedCleaner.lastname = cleaner.lastname;
  if (cleaner.role !== undefined) normalizedCleaner.role = cleaner.role;
  if (cleaner.premium !== undefined) normalizedCleaner.premium = cleaner.premium;
  normalizedCleaner.start_time = cleaner.start_time || "10:00";
  
  return normalizedCleaner;
}

/**
 * Normalize a single task object with correct field ordering
 * Also removes the modified_by field as it's tracked in metadata
 */
function getNormalizedTask(task: any): any {
  if (!task) return task;
  
  // Define the exact field order for tasks
  const normalizedTask: any = {};
  
  // Core identification
  if (task.task_id !== undefined) normalizedTask.task_id = task.task_id;
  if (task.logistic_code !== undefined) normalizedTask.logistic_code = task.logistic_code;
  if (task.client_id !== undefined) normalizedTask.client_id = task.client_id;
  if (task.premium !== undefined) normalizedTask.premium = task.premium;
  
  // Location
  if (task.address !== undefined) normalizedTask.address = task.address;
  if (task.lat !== undefined) normalizedTask.lat = task.lat;
  if (task.lng !== undefined) normalizedTask.lng = task.lng;
  
  // Cleaning details
  if (task.cleaning_time !== undefined) normalizedTask.cleaning_time = task.cleaning_time;
  
  // Dates and times
  if (task.checkin_date !== undefined) normalizedTask.checkin_date = task.checkin_date;
  if (task.checkout_date !== undefined) normalizedTask.checkout_date = task.checkout_date;
  if (task.checkin_time !== undefined) normalizedTask.checkin_time = task.checkin_time;
  if (task.checkout_time !== undefined) normalizedTask.checkout_time = task.checkout_time;
  
  // Guest info
  if (task.pax_in !== undefined) normalizedTask.pax_in = task.pax_in;
  if (task.pax_out !== undefined) normalizedTask.pax_out = task.pax_out;
  
  // Equipment and operation
  if (task.small_equipment !== undefined) normalizedTask.small_equipment = task.small_equipment;
  if (task.operation_id !== undefined) normalizedTask.operation_id = task.operation_id;
  if (task.confirmed_operation !== undefined) normalizedTask.confirmed_operation = task.confirmed_operation;
  if (task.straordinaria !== undefined) normalizedTask.straordinaria = task.straordinaria;
  
  // Property info
  if (task.type_apt !== undefined) normalizedTask.type_apt = task.type_apt;
  if (task.alias !== undefined) normalizedTask.alias = task.alias;
  if (task.customer_name !== undefined) normalizedTask.customer_name = task.customer_name;
  
  // Assignment info
  if (task.reasons !== undefined) normalizedTask.reasons = task.reasons;
  if (task.priority !== undefined) normalizedTask.priority = task.priority;
  
  // Timeline-specific fields
  if (task.start_time !== undefined) normalizedTask.start_time = task.start_time;
  if (task.end_time !== undefined) normalizedTask.end_time = task.end_time;
  if (task.followup !== undefined) normalizedTask.followup = task.followup;
  if (task.sequence !== undefined) normalizedTask.sequence = task.sequence;
  if (task.travel_time !== undefined) normalizedTask.travel_time = task.travel_time;
  
  // Note: modified_by is intentionally excluded - tracked in timeline metadata instead
  
  return normalizedTask;
}

/**
 * Deep clone and normalize timeline data to ensure:
 * 1. 'cleaner' comes before 'tasks' in each assignment
 * 2. Task fields are in the correct order
 * 
 * This is critical because JSON.stringify respects insertion order, so we must
 * rebuild each object with the correct key order.
 * 
 * Returns a NEW object (deep clone) - does not modify the original
 */
function getNormalizedTimeline(timelineData: any): any {
  if (!timelineData) return timelineData;
  
  // Deep clone to avoid modifying original
  const cloned = JSON.parse(JSON.stringify(timelineData));
  
  if (!cloned.cleaners_assignments || !Array.isArray(cloned.cleaners_assignments)) {
    return cloned;
  }

  // Rebuild each entry with correct key order: cleaner FIRST, then tasks
  cloned.cleaners_assignments = cloned.cleaners_assignments.map((entry: any) => {
    // Create brand new object with explicit key ordering
    const normalized: any = {};
    
    // 1. Add cleaner first (with normalized field order)
    normalized.cleaner = getNormalizedCleaner(entry.cleaner);
    
    // 2. Add tasks second (with normalized field order)
    normalized.tasks = (entry.tasks || []).map((task: any) => getNormalizedTask(task));
    
    return normalized;
  });

  return cloned;
}


/**
 * Atomically write JSON to file using tmp + rename pattern
 */
async function atomicWriteJson(filePath: string, data: any): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmpPath, filePath);
}

/**
 * Load timeline for a specific work date
 * Priority: MySQL → filesystem → null
 */
export async function loadTimeline(workDate: string): Promise<any | null> {
  try {
    // Try MySQL first
    const rev = await dailyAssignmentRevisionsService.getLatestRevision(workDate);
    if (rev?.timeline) {
      console.log(`✅ Timeline loaded from MySQL for ${workDate} (revision ${rev.revision})`);
      // CRITICAL: Normalize before writing to filesystem to ensure correct key order
      const normalizedTimeline = getNormalizedTimeline(rev.timeline);
      // Sync to filesystem for Python scripts
      await atomicWriteJson(PATHS.timeline, normalizedTimeline);
      return normalizedTimeline;
    }
  } catch (err) {
    console.error(`Error loading timeline from MySQL:`, err);
  }

  // Fallback to filesystem (first-time or migration)
  try {
    const data = await fs.readFile(PATHS.timeline, 'utf-8');
    const parsed = JSON.parse(data);

    if (parsed.metadata?.date === workDate || parsed.cleaners_assignments) {
      console.log(`✅ Timeline loaded from filesystem for ${workDate}`);
      // Normalize and re-save to ensure correct key order
      const normalized = getNormalizedTimeline(parsed);
      await atomicWriteJson(PATHS.timeline, normalized);
      return normalized;
    }
  } catch (err) {
    // Filesystem read failed
  }

  console.log(`ℹ️ No timeline found for ${workDate}`);
  return null;
}

/**
 * Save timeline for a specific work date
 * Writes to filesystem always (for Python scripts)
 * Writes to MySQL only for today/future dates
 * @param workDate - The work date (YYYY-MM-DD)
 * @param data - Timeline data object
 * @param skipRevision - If true, only saves to filesystem without creating a MySQL revision
 *                       Use this for intermediate saves to avoid multiple revisions for a single user action
 * @param createdBy - Username of the user making the change (default: 'system')
 * @param modificationType - Type of modification (e.g., 'manual', 'reset', 'dnd', 'task_assigned', 'task_removed', etc.)
 * @param editOptions - Optional edit tracking info (editedField, oldValue, newValue)
 */
export async function saveTimeline(
  workDate: string,
  data: any, 
  skipRevision: boolean = false,
  createdBy: string = 'system',
  modificationType: string = 'manual',
  editOptions?: {
    editedField?: string;
    oldValue?: string;
    newValue?: string;
  }
): Promise<boolean> {
  try {
    // Check if this is a past date
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetDate = new Date(workDate);
    targetDate.setHours(0, 0, 0, 0);
    const isPastDate = targetDate < today;

    // CRITICAL: Get a deep-cloned, normalized copy with correct key order
    // This ensures 'cleaner' comes before 'tasks' in the JSON output
    const normalizedData = getNormalizedTimeline(data);

    // Ensure metadata contains the correct date
    normalizedData.metadata = normalizedData.metadata || {};
    normalizedData.metadata.date = workDate;
    normalizedData.metadata.last_updated = getRomeTimestamp();

    // ALWAYS write to filesystem (for Python scripts compatibility)
    await atomicWriteJson(PATHS.timeline, normalizedData);
    console.log(`✅ Timeline saved to filesystem for ${workDate}`);

    // For past dates: skip MySQL write but return success
    if (isPastDate) {
      console.log(`📜 Data passata ${workDate} - file JSON aggiornato, MySQL non modificato`);
      return true;
    }

    // Skip MySQL revision if requested (for intermediate saves)
    if (skipRevision) {
      console.log(`⏭️ Saltata revisione MySQL per ${workDate} (skipRevision=true)`);
      return true;
    }

    // Get current selected_cleaners and containers
    const selected = await loadSelectedCleanersFromFile(workDate);
    const cleanersArray = selected?.cleaners || [];
    const containers = await loadContainersFromFile(workDate);

    // ALWAYS create revision in MySQL - even for empty states
    // This ensures removals/deletions are properly persisted
    // Empty state IS valid data that should be saved
    await dailyAssignmentRevisionsService.createRevision(workDate, normalizedData, cleanersArray, containers, createdBy, modificationType, editOptions);
    console.log(`✅ Timeline revision created in MySQL for ${workDate} by ${createdBy} (type: ${modificationType})`);

    // DUAL-WRITE: Also save to PostgreSQL (DigitalOcean) in flat format
    // Direct from memory - no JSON intermediate
    try {
      const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
      
      // Save current state (replaces existing)
      await pgDailyAssignmentsService.saveTimeline(workDate, normalizedData);
      
      // Save to history (audit/rollback) - also direct from memory
      await pgDailyAssignmentsService.saveToHistory(workDate, normalizedData, createdBy, modificationType);
    } catch (pgError) {
      // Log but don't fail - PostgreSQL is secondary for now
      console.error(`⚠️ PG: Errore nel salvataggio (non bloccante):`, pgError);
    }

    return true;
  } catch (err) {
    console.error(`Error saving timeline for ${workDate}:`, err);
    return false;
  }
}

/**
 * Load containers.json from filesystem only (helper)
 */
async function loadContainersFromFile(workDate: string): Promise<any | null> {
  try {
    const data = await fs.readFile(PATHS.containers, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    return null;
  }
}

/**
 * Load containers.json for a specific work date
 * Priority: MySQL → filesystem → null
 * Now persisted to MySQL for historical date viewing
 */
export async function loadContainers(workDate: string): Promise<any | null> {
  try {
    // Try MySQL first
    const rev = await dailyAssignmentRevisionsService.getLatestRevision(workDate);
    if (rev?.containers) {
      console.log(`✅ Containers loaded from MySQL for ${workDate} (revision ${rev.revision})`);
      // Sync to filesystem for Python scripts
      await atomicWriteJson(PATHS.containers, rev.containers);
      return rev.containers;
    }
  } catch (err) {
    console.error(`Error loading containers from MySQL:`, err);
  }

  // Fallback to filesystem
  try {
    const data = await fs.readFile(PATHS.containers, 'utf-8');
    const parsed = JSON.parse(data);

    if (parsed.containers) {
      console.log(`✅ Containers loaded from filesystem for ${workDate}`);
      return parsed;
    }
  } catch (err) {
    // Filesystem read failed
  }

  console.log(`ℹ️ No containers found for ${workDate}`);
  return null;
}

/**
 * Save containers.json for a specific work date
 * Writes to filesystem always (for Python scripts)
 * Writes to MySQL only for today/future dates (for historical viewing)
 * @param createdBy - Username of the user making the change (default: 'system')
 * @param modificationType - Type of modification (default: 'manual')
 */
export async function saveContainers(workDate: string, data: any, createdBy: string = 'system', modificationType: string = 'manual'): Promise<boolean> {
  try {
    // ALWAYS write to filesystem (for Python scripts compatibility)
    await atomicWriteJson(PATHS.containers, data);
    console.log(`✅ Containers saved to filesystem for ${workDate}`);

    // Check if this is a past date
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetDate = new Date(workDate);
    targetDate.setHours(0, 0, 0, 0);
    const isPastDate = targetDate < today;

    // For past dates: skip MySQL write
    if (isPastDate) {
      console.log(`📜 Data passata ${workDate} - containers salvati solo su filesystem`);
      return true;
    }

    // Get current timeline and selected_cleaners
    let timeline = null;
    let cleanersArray: any[] = [];

    try {
      const timelineData = await fs.readFile(PATHS.timeline, 'utf-8');
      timeline = JSON.parse(timelineData);
    } catch (err) {
      timeline = {};
    }

    try {
      const selected = await loadSelectedCleanersFromFile(workDate);
      cleanersArray = selected?.cleaners || [];
    } catch (err) {
      cleanersArray = [];
    }

    // Create revision with containers
    const hasContainers = data?.containers && Object.keys(data.containers).length > 0;
    const hasAssignments = timeline?.cleaners_assignments && timeline.cleaners_assignments.length > 0;
    const hasCleaners = cleanersArray.length > 0;

    if (hasContainers || hasAssignments || hasCleaners) {
      await dailyAssignmentRevisionsService.createRevision(workDate, timeline, cleanersArray, data, createdBy, modificationType);
      console.log(`✅ Containers revision created in MySQL for ${workDate} by ${createdBy} (type: ${modificationType})`);
    }

    return true;
  } catch (err) {
    console.error(`Error saving containers for ${workDate}:`, err);
    return false;
  }
}

/**
 * Load selected_cleaners from filesystem only (helper)
 * CRITICAL: Verifica che la data nel file corrisponda a workDate
 */
async function loadSelectedCleanersFromFile(workDate: string): Promise<any | null> {
  try {
    const data = await fs.readFile(PATHS.selectedCleaners, 'utf-8');
    const parsed = JSON.parse(data);

    // CRITICAL: Verifica che la data corrisponda
    const fileDate = parsed?.metadata?.date;
    if (fileDate && fileDate !== workDate) {
      console.log(`⚠️ loadSelectedCleanersFromFile: file ha data ${fileDate}, richiesta ${workDate} - ignorato`);
      return null;
    }

    return parsed;
  } catch (err) {
    return null;
  }
}

/**
 * Load selected_cleaners for a specific work date
 * Priority: MySQL → filesystem → null
 */
export async function loadSelectedCleaners(workDate: string): Promise<any | null> {
  try {
    // Try MySQL first
    const rev = await dailyAssignmentRevisionsService.getLatestRevision(workDate);
    if (rev?.selected_cleaners) {
      const scData = {
        cleaners: Array.isArray(rev.selected_cleaners) ? rev.selected_cleaners : [],
        total_selected: Array.isArray(rev.selected_cleaners) ? rev.selected_cleaners.length : 0,
        metadata: { date: workDate, loaded_at: getRomeTimestamp() }
      };
      console.log(`✅ Selected cleaners loaded from MySQL for ${workDate} (revision ${rev.revision})`);
      // Sync to filesystem
      await atomicWriteJson(PATHS.selectedCleaners, scData);
      return scData;
    }
  } catch (err) {
    console.error(`Error loading selected cleaners from MySQL:`, err);
  }

  // Fallback to filesystem
  try {
    const data = await fs.readFile(PATHS.selectedCleaners, 'utf-8');
    const parsed = JSON.parse(data);

    if (!parsed.metadata?.date || parsed.metadata.date === workDate) {
      console.log(`✅ Selected cleaners loaded from filesystem for ${workDate}`);
      return parsed;
    }
  } catch (err) {
    // Filesystem read failed
  }

  console.log(`ℹ️ No selected cleaners found for ${workDate}`);
  return null;
}

/**
 * Save selected_cleaners for a specific work date
 * Writes to filesystem always (for Python scripts)
 * Writes to MySQL only for today/future dates
 * @param skipRevision - If true, only saves to filesystem without creating a MySQL revision
 *                       Use this for intermediate saves (e.g., update-cleaner-start-time)
 *                       to avoid creating multiple revisions for a single user action
 * @param createdBy - Username of the user making the change (default: 'system')
 * @param modificationType - Type of modification (e.g., 'convocazioni_save', 'cleaner_removed', 'start_time_updated', etc.)
 */
export async function saveSelectedCleaners(workDate: string, data: any, skipRevision: boolean = false, createdBy: string = 'system', modificationType: string = 'manual'): Promise<boolean> {
  try {
    // Check if this is a past date
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetDate = new Date(workDate);
    targetDate.setHours(0, 0, 0, 0);
    const isPastDate = targetDate < today;

    // Ensure metadata contains the correct date
    data.metadata = data.metadata || {};
    data.metadata.date = workDate;
    data.metadata.last_updated = getRomeTimestamp();

    // ALWAYS write to filesystem
    await atomicWriteJson(PATHS.selectedCleaners, data);
    console.log(`✅ Selected cleaners saved to filesystem for ${workDate}`);

    // For past dates: skip MySQL write but return success
    if (isPastDate) {
      console.log(`📜 Data passata ${workDate} - file JSON aggiornato, MySQL non modificato`);
      return true;
    }

    // Skip MySQL revision if requested (for intermediate saves)
    if (skipRevision) {
      console.log(`⏭️ Saltata revisione MySQL per ${workDate} (skipRevision=true)`);
      return true;
    }

    // Get current timeline and containers
    let timeline = null;
    let containers = null;

    try {
      const timelineData = await fs.readFile(PATHS.timeline, 'utf-8');
      timeline = JSON.parse(timelineData);
    } catch (err) {
      timeline = {};
    }

    try {
      containers = await loadContainersFromFile(workDate);
    } catch (err) {
      containers = null;
    }

    const cleanersArray = data.cleaners || [];

    // ALWAYS create revision in MySQL - even for empty states
    // This ensures removals/deletions are properly persisted
    // Empty state IS valid data that should be saved
    await dailyAssignmentRevisionsService.createRevision(workDate, timeline, cleanersArray, containers, createdBy, modificationType);
    console.log(`✅ Selected cleaners revision created in MySQL for ${workDate} by ${createdBy} (type: ${modificationType})`);

    return true;
  } catch (err) {
    console.error(`Error saving selected cleaners for ${workDate}:`, err);
    return false;
  }
}

/**
 * Reset timeline: svuota assegnazioni ma preserva selected_cleaners
 * @param createdBy - Username of the user making the reset (default: 'system')
 */
export async function resetTimeline(workDate: string, createdBy: string = 'system', modificationType: string = 'reset'): Promise<boolean> {
  try {
    // CRITICAL: Blocca reset per date passate
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetDate = new Date(workDate);
    targetDate.setHours(0, 0, 0, 0);

    if (targetDate < today) {
      console.log(`🚫 Tentativo di reset timeline per data passata ${workDate} - BLOCCATO`);
      return false;
    }

    const emptyTimeline = {
      metadata: {
        date: workDate,
        last_updated: getRomeTimestamp(),
        created_by: createdBy
      },
      cleaners_assignments: [],
      meta: {
        total_cleaners: 0,
        used_cleaners: 0,
        assigned_tasks: 0
      }
    };

    // Write empty timeline to filesystem
    await atomicWriteJson(PATHS.timeline, emptyTimeline);
    console.log(`✅ Timeline reset to empty for ${workDate}`);

    // Create new revision in MySQL with empty timeline but preserving selected_cleaners and containers
    const selected = await loadSelectedCleanersFromFile(workDate);
    const containers = await loadContainersFromFile(workDate);

    // CRITICAL: Non creare revisione se non ci sono cleaner
    if (!selected?.cleaners || selected.cleaners.length === 0) {
      console.log(`⏭️ Saltata creazione revisione MySQL per reset ${workDate} (nessun cleaner selezionato)`);
      return true;
    }

    await dailyAssignmentRevisionsService.createRevision(workDate, emptyTimeline, selected.cleaners, containers, createdBy, modificationType);
    console.log(`✅ Timeline reset revision created in MySQL for ${workDate} by ${createdBy} (type: ${modificationType})`);

    return true;
  } catch (err) {
    console.error(`Error resetting timeline for ${workDate}:`, err);
    return false;
  }
}

/**
 * Get raw file paths (for backward compatibility)
 */
export function getFilePaths() {
  return { ...PATHS };
}