import * as fs from 'fs/promises';
import path from 'path';
import { dailyAssignmentRevisionsService } from './daily-assignment-revisions-service';
import { formatInTimeZone } from 'date-fns-tz';

/**
 * Workspace Files Helper
 * 
 * PostgreSQL-only storage for timeline and containers
 * Selected cleaners still uses filesystem for backward compatibility
 * 
 * Storage: PostgreSQL (primary and only source of truth)
 */

const PATHS = {
  selectedCleaners: path.join(process.cwd(), 'client/public/data/cleaners/selected_cleaners.json'),
};

const TIMEZONE = 'Europe/Rome';

function getRomeTimestamp(): string {
  return formatInTimeZone(new Date(), TIMEZONE, "yyyy-MM-dd HH:mm:ss");
}

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

function getNormalizedTask(task: any): any {
  if (!task) return task;
  
  const normalizedTask: any = {};
  
  if (task.task_id !== undefined) normalizedTask.task_id = task.task_id;
  if (task.logistic_code !== undefined) normalizedTask.logistic_code = task.logistic_code;
  if (task.client_id !== undefined) normalizedTask.client_id = task.client_id;
  if (task.premium !== undefined) normalizedTask.premium = task.premium;
  if (task.address !== undefined) normalizedTask.address = task.address;
  if (task.lat !== undefined) normalizedTask.lat = task.lat;
  if (task.lng !== undefined) normalizedTask.lng = task.lng;
  if (task.cleaning_time !== undefined) normalizedTask.cleaning_time = task.cleaning_time;
  if (task.checkin_date !== undefined) normalizedTask.checkin_date = task.checkin_date;
  if (task.checkout_date !== undefined) normalizedTask.checkout_date = task.checkout_date;
  if (task.checkin_time !== undefined) normalizedTask.checkin_time = task.checkin_time;
  if (task.checkout_time !== undefined) normalizedTask.checkout_time = task.checkout_time;
  if (task.pax_in !== undefined) normalizedTask.pax_in = task.pax_in;
  if (task.pax_out !== undefined) normalizedTask.pax_out = task.pax_out;
  if (task.small_equipment !== undefined) normalizedTask.small_equipment = task.small_equipment;
  if (task.operation_id !== undefined) normalizedTask.operation_id = task.operation_id;
  if (task.confirmed_operation !== undefined) normalizedTask.confirmed_operation = task.confirmed_operation;
  if (task.straordinaria !== undefined) normalizedTask.straordinaria = task.straordinaria;
  if (task.type_apt !== undefined) normalizedTask.type_apt = task.type_apt;
  if (task.alias !== undefined) normalizedTask.alias = task.alias;
  if (task.customer_name !== undefined) normalizedTask.customer_name = task.customer_name;
  if (task.reasons !== undefined) normalizedTask.reasons = task.reasons;
  if (task.priority !== undefined) normalizedTask.priority = task.priority;
  if (task.start_time !== undefined) normalizedTask.start_time = task.start_time;
  if (task.end_time !== undefined) normalizedTask.end_time = task.end_time;
  if (task.followup !== undefined) normalizedTask.followup = task.followup;
  if (task.sequence !== undefined) normalizedTask.sequence = task.sequence;
  if (task.travel_time !== undefined) normalizedTask.travel_time = task.travel_time;
  
  return normalizedTask;
}

function getNormalizedTimeline(timelineData: any): any {
  if (!timelineData) return timelineData;
  
  const cloned = JSON.parse(JSON.stringify(timelineData));
  
  if (!cloned.cleaners_assignments || !Array.isArray(cloned.cleaners_assignments)) {
    return cloned;
  }

  cloned.cleaners_assignments = cloned.cleaners_assignments.map((entry: any) => {
    const normalized: any = {};
    normalized.cleaner = getNormalizedCleaner(entry.cleaner);
    normalized.tasks = (entry.tasks || []).map((task: any) => getNormalizedTask(task));
    return normalized;
  });

  return cloned;
}

async function atomicWriteJson(filePath: string, data: any): Promise<void> {
  // Ensure directory exists
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmpPath, filePath);
}

/**
 * Load timeline for a specific work date
 * SOURCE: PostgreSQL only
 */
export async function loadTimeline(workDate: string): Promise<any | null> {
  try {
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    const pgTimeline = await pgDailyAssignmentsService.loadTimeline(workDate);
    
    if (pgTimeline) {
      console.log(`✅ Timeline loaded from PostgreSQL for ${workDate}`);
      return getNormalizedTimeline(pgTimeline);
    }
  } catch (err) {
    console.error(`❌ Error loading timeline from PostgreSQL:`, err);
  }

  console.log(`ℹ️ No timeline found for ${workDate}`);
  return null;
}

/**
 * Save timeline for a specific work date
 * WRITES TO: PostgreSQL only
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
    editedFields?: string[];
    oldValues?: string[];
    newValues?: string[];
  }
): Promise<boolean> {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetDate = new Date(workDate);
    targetDate.setHours(0, 0, 0, 0);
    const isPastDate = targetDate < today;

    const normalizedData = getNormalizedTimeline(data);

    normalizedData.metadata = normalizedData.metadata || {};
    normalizedData.metadata.date = workDate;
    normalizedData.metadata.last_updated = getRomeTimestamp();

    // Save to PostgreSQL (primary and only storage)
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    
    await pgDailyAssignmentsService.saveTimeline(workDate, normalizedData);
    console.log(`✅ Timeline saved to PostgreSQL for ${workDate}`);
    
    // Prepare change tracking arrays
    let editedFields: string[] = [];
    let oldValues: string[] = [];
    let newValues: string[] = [];
    
    if (editOptions) {
      if (editOptions.editedFields && editOptions.editedFields.length > 0) {
        editedFields = editOptions.editedFields;
        oldValues = editOptions.oldValues || [];
        newValues = editOptions.newValues || [];
      } else if (editOptions.editedField) {
        editedFields = [editOptions.editedField];
        oldValues = editOptions.oldValue ? [editOptions.oldValue] : [];
        newValues = editOptions.newValue ? [editOptions.newValue] : [];
      }
    }
    
    // Save to history for audit/rollback
    if (!skipRevision) {
      await pgDailyAssignmentsService.saveToHistory(
        workDate, 
        normalizedData, 
        createdBy, 
        modificationType,
        editedFields,
        oldValues,
        newValues
      );
      console.log(`✅ Timeline history saved for ${workDate} by ${createdBy}`);
    }

    // LEGACY: Also save to MySQL for backward compatibility (will be removed)
    if (!isPastDate && !skipRevision) {
      try {
        const selected = await loadSelectedCleanersFromPg(workDate);
        const cleanersArray = selected?.cleaners || [];
        const containers = await loadContainersInternal(workDate);
        await dailyAssignmentRevisionsService.createRevision(workDate, normalizedData, cleanersArray, containers, createdBy, modificationType, editOptions);
        console.log(`⚠️ Timeline revision created in MySQL (legacy) for ${workDate}`);
      } catch (mysqlError) {
        console.warn(`⚠️ MySQL legacy save failed (non-blocking):`, mysqlError);
      }
    }

    return true;
  } catch (err) {
    console.error(`❌ Error saving timeline for ${workDate}:`, err);
    return false;
  }
}

/**
 * Internal helper to load containers without logging
 */
async function loadContainersInternal(workDate: string): Promise<any | null> {
  try {
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    return await pgDailyAssignmentsService.loadContainers(workDate);
  } catch (err) {
    return null;
  }
}

/**
 * Load containers for a specific work date
 * SOURCE: PostgreSQL only
 */
export async function loadContainers(workDate: string): Promise<any | null> {
  try {
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    const pgContainers = await pgDailyAssignmentsService.loadContainers(workDate);
    
    if (pgContainers) {
      console.log(`✅ Containers loaded from PostgreSQL for ${workDate}`);
      return pgContainers;
    }
  } catch (err) {
    console.error(`❌ Error loading containers from PostgreSQL:`, err);
  }

  console.log(`ℹ️ No containers found for ${workDate}`);
  return null;
}

/**
 * Save containers for a specific work date
 * WRITES TO: PostgreSQL only
 */
export async function saveContainers(workDate: string, data: any, createdBy: string = 'system', modificationType: string = 'manual'): Promise<boolean> {
  try {
    // Save to PostgreSQL (primary and only storage)
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    await pgDailyAssignmentsService.saveContainers(workDate, data);
    console.log(`✅ Containers saved to PostgreSQL for ${workDate}`);

    // LEGACY: Also save to MySQL for backward compatibility (will be removed)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetDate = new Date(workDate);
    targetDate.setHours(0, 0, 0, 0);
    const isPastDate = targetDate < today;

    if (!isPastDate) {
      try {
        const timeline = await loadTimeline(workDate);
        const selected = await loadSelectedCleanersFromPg(workDate);
        const cleanersArray = selected?.cleaners || [];
        await dailyAssignmentRevisionsService.createRevision(workDate, timeline || {}, cleanersArray, data, createdBy, modificationType);
        console.log(`⚠️ Containers revision created in MySQL (legacy) for ${workDate}`);
      } catch (mysqlError) {
        console.warn(`⚠️ MySQL legacy save failed (non-blocking):`, mysqlError);
      }
    }

    return true;
  } catch (err) {
    console.error(`❌ Error saving containers for ${workDate}:`, err);
    return false;
  }
}

/**
 * Load selected_cleaners from PostgreSQL for internal operations
 * No filesystem fallback - PostgreSQL is the only source
 */
async function loadSelectedCleanersFromPg(workDate: string): Promise<any | null> {
  try {
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    const pgCleanerIds = await pgDailyAssignmentsService.loadSelectedCleaners(workDate);
    
    if (pgCleanerIds && pgCleanerIds.length > 0) {
      const fullCleaners = await pgDailyAssignmentsService.loadCleanersByIds(pgCleanerIds, workDate);
      const cleanersData = fullCleaners.length > 0 ? fullCleaners : pgCleanerIds.map(id => ({ id }));
      return {
        cleaners: cleanersData,
        total_selected: cleanersData.length,
        metadata: { date: workDate }
      };
    }
    return { cleaners: [], total_selected: 0, metadata: { date: workDate } };
  } catch (err) {
    console.error(`❌ loadSelectedCleanersFromPg failed:`, err);
    return { cleaners: [], total_selected: 0, metadata: { date: workDate } };
  }
}

/**
 * Load selected_cleaners for a specific work date
 * SOURCE: PostgreSQL only (IDs from daily_selected_cleaners + full data from cleaners table)
 */
export async function loadSelectedCleaners(workDate: string): Promise<any | null> {
  try {
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    const pgCleanerIds = await pgDailyAssignmentsService.loadSelectedCleaners(workDate);
    
    if (pgCleanerIds && pgCleanerIds.length > 0) {
      // Get full cleaner data from cleaners table
      const fullCleaners = await pgDailyAssignmentsService.loadCleanersByIds(pgCleanerIds, workDate);
      
      // Ensure all cleaners have required fields
      const cleanersData = fullCleaners.length > 0 
        ? fullCleaners.map(c => ({
            id: c.id,
            name: c.name || 'Unknown',
            lastname: c.lastname || '',
            role: c.role || 'Standard',
            premium: c.premium || false,
            start_time: c.start_time || '10:00',
            can_do_straordinaria: c.can_do_straordinaria || false,
            active: c.active !== false,
            available: c.available !== false,
            ranking: c.ranking || 0,
            counter_hours: c.counter_hours || 0,
            counter_days: c.counter_days || 0,
            contract_type: c.contract_type || null,
            preferred_customers: c.preferred_customers || [],
            telegram_id: c.telegram_id || null
          }))
        : pgCleanerIds.map(id => ({ 
            id, 
            name: 'Unknown', 
            lastname: '', 
            role: 'Standard', 
            premium: false,
            start_time: '10:00',
            can_do_straordinaria: false
          }));
      
      const scData = {
        cleaners: cleanersData,
        total_selected: cleanersData.length,
        metadata: { date: workDate, loaded_at: getRomeTimestamp() }
      };
      console.log(`✅ Selected cleaners loaded from PostgreSQL for ${workDate}: ${cleanersData.length} cleaners`);
      
      // PostgreSQL is the only source of truth - no filesystem writes
      return scData;
    }
    
    // No cleaners found - return empty
    console.log(`ℹ️ No selected cleaners found for ${workDate}`);
    return {
      cleaners: [],
      total_selected: 0,
      metadata: { date: workDate, loaded_at: getRomeTimestamp() }
    };
  } catch (err) {
    console.error(`❌ Error loading selected cleaners from PostgreSQL:`, err);
    return null;
  }
}

/**
 * Save selected_cleaners for a specific work date
 * PRIMARY: PostgreSQL (IDs to daily_selected_cleaners, full data to cleaners table)
 * LEGACY: MySQL (will be removed)
 */
export async function saveSelectedCleaners(workDate: string, data: any, skipRevision: boolean = false, createdBy: string = 'system', modificationType: string = 'manual'): Promise<boolean> {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetDate = new Date(workDate);
    targetDate.setHours(0, 0, 0, 0);
    const isPastDate = targetDate < today;

    data.metadata = data.metadata || {};
    data.metadata.date = workDate;
    data.metadata.last_updated = getRomeTimestamp();

    // PRIMARY: Save to PostgreSQL (only source of truth)
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    const cleanersArray = data.cleaners || [];
    
    // Extract IDs for daily_selected_cleaners table (now INTEGER[])
    const cleanerIds = cleanersArray.map((c: any) => typeof c === 'number' ? c : c.id).filter((id: any) => id != null);
    await pgDailyAssignmentsService.saveSelectedCleaners(workDate, cleanerIds);
    
    // Also save full cleaner data to cleaners table if available
    if (cleanersArray.length > 0 && typeof cleanersArray[0] === 'object') {
      await pgDailyAssignmentsService.saveCleanersForDate(workDate, cleanersArray, 'selected_cleaners_update');
    }
    
    console.log(`✅ Selected cleaners saved to PostgreSQL for ${workDate}: ${cleanerIds.length} IDs`);

    if (isPastDate) {
      console.log(`📜 Data passata ${workDate} - salvato su PG`);
      return true;
    }

    if (skipRevision) {
      console.log(`⏭️ Saltata revisione MySQL per ${workDate} (skipRevision=true)`);
      return true;
    }

    // LEGACY: Also save to MySQL (will be removed)
    try {
      const timeline = await loadTimeline(workDate);
      const containers = await loadContainersInternal(workDate);
      const cleanersForMySQL = data.cleaners || [];
      await dailyAssignmentRevisionsService.createRevision(workDate, timeline || {}, cleanersForMySQL, containers, createdBy, modificationType);
      console.log(`⚠️ Selected cleaners revision created in MySQL (legacy) for ${workDate}`);
    } catch (mysqlError) {
      console.warn(`⚠️ MySQL legacy save failed (non-blocking):`, mysqlError);
    }

    return true;
  } catch (err) {
    console.error(`Error saving selected cleaners for ${workDate}:`, err);
    return false;
  }
}

/**
 * Reset timeline: svuota assegnazioni
 */
export async function resetTimeline(workDate: string, createdBy: string = 'system', modificationType: string = 'reset'): Promise<boolean> {
  try {
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

    // Save empty timeline to PostgreSQL
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    await pgDailyAssignmentsService.saveTimeline(workDate, emptyTimeline);
    await pgDailyAssignmentsService.saveToHistory(workDate, emptyTimeline, createdBy, modificationType, [], [], []);
    console.log(`✅ Timeline reset in PostgreSQL for ${workDate}`);

    // LEGACY: Also save to MySQL
    try {
      const selected = await loadSelectedCleanersFromPg(workDate);
      const containers = await loadContainersInternal(workDate);
      if (selected?.cleaners && selected.cleaners.length > 0) {
        await dailyAssignmentRevisionsService.createRevision(workDate, emptyTimeline, selected.cleaners, containers, createdBy, modificationType);
        console.log(`⚠️ Timeline reset revision created in MySQL (legacy) for ${workDate}`);
      }
    } catch (mysqlError) {
      console.warn(`⚠️ MySQL legacy reset failed (non-blocking):`, mysqlError);
    }

    return true;
  } catch (err) {
    console.error(`Error resetting timeline for ${workDate}:`, err);
    return false;
  }
}

/**
 * Get raw file paths (for backward compatibility - only selected_cleaners now)
 */
export function getFilePaths() {
  return { 
    selectedCleaners: PATHS.selectedCleaners,
    // Timeline and containers are now PostgreSQL-only
    timeline: null,
    containers: null
  };
}
