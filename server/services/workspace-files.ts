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
 * Normalizes cleaners_assignments to have 'cleaner' before 'tasks'
 * This ensures consistent JSON structure matching Python scripts output
 */
function normalizeCleanersAssignments(timelineData: any): any {
  if (!timelineData?.cleaners_assignments || !Array.isArray(timelineData.cleaners_assignments)) {
    return timelineData;
  }

  timelineData.cleaners_assignments = timelineData.cleaners_assignments.map((entry: any) => {
    // Rebuild object with cleaner first, then tasks
    return {
      cleaner: entry.cleaner,
      tasks: entry.tasks || []
    };
  });

  return timelineData;
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
      // Sync to filesystem for Python scripts
      await atomicWriteJson(PATHS.timeline, rev.timeline);
      return rev.timeline;
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
      return parsed;
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
 */
export async function saveTimeline(
  workDate: string,
  data: any, 
  skipRevision: boolean = false,
  createdBy: string = 'system',
  modificationType: string = 'manual'
): Promise<boolean> {
  try {
    // Check if this is a past date
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetDate = new Date(workDate);
    targetDate.setHours(0, 0, 0, 0);
    const isPastDate = targetDate < today;

    // Normalize cleaners_assignments to have 'cleaner' before 'tasks'
    normalizeCleanersAssignments(data);

    // Ensure metadata contains the correct date
    data.metadata = data.metadata || {};
    data.metadata.date = workDate;
    data.metadata.last_updated = getRomeTimestamp();

    // ALWAYS write to filesystem (for Python scripts compatibility)
    await atomicWriteJson(PATHS.timeline, data);
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

    // CRITICAL: Non creare revisione se timeline E cleaners sono vuoti
    const hasAssignments = data.cleaners_assignments && data.cleaners_assignments.length > 0;
    const hasCleaners = cleanersArray.length > 0;

    if (!hasAssignments && !hasCleaners) {
      console.log(`⏭️ Saltata creazione revisione MySQL per ${workDate} (nessun dato significativo)`);
      return true;
    }

    // Create new revision in MySQL (include containers)
    await dailyAssignmentRevisionsService.createRevision(workDate, data, cleanersArray, containers, createdBy, modificationType);
    console.log(`✅ Timeline revision created in MySQL for ${workDate} by ${createdBy} (type: ${modificationType})`);

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

    // CRITICAL: Non creare revisione se cleaners E timeline sono vuoti
    const hasCleaners = cleanersArray.length > 0;
    const hasAssignments = timeline?.cleaners_assignments && timeline.cleaners_assignments.length > 0;

    if (!hasCleaners && !hasAssignments) {
      console.log(`⏭️ Saltata creazione revisione MySQL per ${workDate} (nessun dato significativo)`);
      return true;
    }

    // Create new revision in MySQL (include containers)
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