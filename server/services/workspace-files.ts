import { formatInTimeZone } from 'date-fns-tz';

/**
 * Workspace Files Helper
 * 
 * PostgreSQL-only storage for timeline, containers, and selected cleaners
 * 
 * Storage: PostgreSQL (primary and only source of truth)
 * MySQL/Filesystem: REMOVED (December 2025)
 */

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
  normalizedCleaner.start_time = cleaner.start_time ?? "10:00";
  
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
  if (task.cleaning_time !== undefined) {
    normalizedTask.cleaning_time = task.cleaning_time;
    // Genera duration in formato "H.MM" dal cleaning_time (minuti)
    const hours = Math.floor(task.cleaning_time / 60);
    const mins = task.cleaning_time % 60;
    normalizedTask.duration = `${hours}.${String(mins).padStart(2, '0')}`;
  }
  if (task.base_cleaning_time !== undefined) normalizedTask.base_cleaning_time = task.base_cleaning_time;
  if (task.collaborator_ids !== undefined) normalizedTask.collaborator_ids = task.collaborator_ids;
  if (task.collaborator_count !== undefined) normalizedTask.collaborator_count = task.collaborator_count;
  if (task.is_primary !== undefined) normalizedTask.is_primary = task.is_primary;
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
  if (task.customer_reference !== undefined) normalizedTask.customer_reference = task.customer_reference;
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

function getNormalizedDriver(driver: any): any {
  if (!driver) return driver;
  const n: any = {};
  if (driver.id !== undefined) n.id = driver.id;
  if (driver.name !== undefined) n.name = driver.name;
  if (driver.lastname !== undefined) n.lastname = driver.lastname;
  if (driver.role !== undefined) n.role = driver.role;
  if (driver.premium !== undefined) n.premium = driver.premium;
  n.start_time = driver.start_time ?? '10:00';
  return n;
}

function getNormalizedLogisticsTimeline(data: any): any {
  if (!data) return data;
  const cloned = JSON.parse(JSON.stringify(data));
  if (!cloned.drivers_assignments || !Array.isArray(cloned.drivers_assignments)) {
    return cloned;
  }
  cloned.drivers_assignments = cloned.drivers_assignments.map((entry: any) => ({
    driver: getNormalizedDriver(entry.driver),
    tasks: (entry.tasks || []).map((task: any) => getNormalizedTask(task)),
  }));
  return cloned;
}


/**
 * Load timeline for a specific work date
 * SOURCE: PostgreSQL only
 */
export async function loadTimeline(
  workDate: string,
  scope: 'housekeeping' | 'office' = 'housekeeping'
): Promise<any | null> {
  try {
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    const pgTimeline = await pgDailyAssignmentsService.loadTimeline(workDate, scope);
    
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
  },
  scope?: 'housekeeping' | 'office'
): Promise<boolean> {
  try {
    const resolvedScope: 'housekeeping' | 'office' =
      scope ?? (data?.metadata?.scope === 'office' ? 'office' : 'housekeeping');
    const normalizedData = getNormalizedTimeline(data);

    normalizedData.metadata = normalizedData.metadata || {};
    normalizedData.metadata.date = workDate;
    normalizedData.metadata.last_updated = getRomeTimestamp();

    // Save to PostgreSQL (primary and only storage)
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    
    await pgDailyAssignmentsService.saveTimeline(workDate, normalizedData, resolvedScope);
    console.log(`✅ Timeline saved to PostgreSQL for ${workDate}`);

    // Keep task_collaborators in sync with daily_assignments_current.
    // This prevents collaboration mismatches after any operation that saves the timeline
    // (drag & drop, swap cleaners, batch operations, etc.).
    try {
      const { taskCollaborationService } = await import('./pg-task-collaboration-service');
      await taskCollaborationService.reconcileForWorkDate(workDate);
    } catch (reconcileErr) {
      // Don't hide the original save errors, but do surface reconcile failures.
      console.error(`❌ Error reconciling collaborations for ${workDate}:`, reconcileErr);
      throw reconcileErr;
    }
    
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
    
    // Save to history for audit/rollback (PostgreSQL only)
    if (!skipRevision) {
      await pgDailyAssignmentsService.saveToHistory(
        workDate, 
        normalizedData, 
        createdBy, 
        modificationType,
        editedFields,
        oldValues,
        newValues,
        resolvedScope
      );
      console.log(`✅ Timeline history saved in PostgreSQL for ${workDate} by ${createdBy}`);
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
async function loadContainersInternal(
  workDate: string,
  scope: 'housekeeping' | 'office' = 'housekeeping'
): Promise<any | null> {
  try {
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    return await pgDailyAssignmentsService.loadContainers(workDate, scope);
  } catch (err) {
    return null;
  }
}

/**
 * Load containers for a specific work date
 * SOURCE: PostgreSQL only
 */
export async function loadContainers(
  workDate: string,
  scope: 'housekeeping' | 'office' = 'housekeeping'
): Promise<any | null> {
  try {
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    const pgContainers = await pgDailyAssignmentsService.loadContainers(workDate, scope);
    
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
export async function saveContainers(
  workDate: string,
  data: any,
  createdBy: string = 'system',
  modificationType: string = 'manual',
  scope?: 'housekeeping' | 'office'
): Promise<boolean> {
  try {
    const resolvedScope: 'housekeeping' | 'office' =
      scope ?? (data?.metadata?.scope === 'office' ? 'office' : 'housekeeping');
    // Save to PostgreSQL (primary and only storage)
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    await pgDailyAssignmentsService.saveContainers(workDate, data, resolvedScope);
    console.log(`✅ Containers saved to PostgreSQL for ${workDate}`);

    return true;
  } catch (err) {
    console.error(`❌ Error saving containers for ${workDate}:`, err);
    return false;
  }
}

/** WASS Logistics: containers in lg_containers (separate from housekeeping) */
export async function loadLogisticsContainers(workDate: string): Promise<any | null> {
  try {
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    const data = await pgDailyAssignmentsService.loadLogisticsContainers(workDate);
    if (data) {
      console.log(`✅ Logistics containers loaded from PostgreSQL for ${workDate}`);
    }
    return data;
  } catch (err) {
    console.error(`❌ Error loading logistics containers for ${workDate}:`, err);
    return null;
  }
}

export async function saveLogisticsContainers(
  workDate: string,
  data: any,
  _createdBy: string = 'system',
  _modificationType: string = 'manual'
): Promise<boolean> {
  try {
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    await pgDailyAssignmentsService.saveLogisticsContainers(workDate, data);
    console.log(`✅ Logistics containers saved to PostgreSQL for ${workDate}`);
    return true;
  } catch (err) {
    console.error(`❌ Error saving logistics containers for ${workDate}:`, err);
    return false;
  }
}

/**
 * Load selected_cleaners from PostgreSQL for internal operations
 * No filesystem fallback - PostgreSQL is the only source
 */
async function loadSelectedCleanersFromPg(
  workDate: string,
  scope: 'housekeeping' | 'office' = 'housekeeping'
): Promise<any | null> {
  try {
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    const pgCleanerIds = await pgDailyAssignmentsService.loadSelectedCleaners(workDate, scope);
    
    if (pgCleanerIds && pgCleanerIds.length > 0) {
      const fullCleaners = await pgDailyAssignmentsService.loadCleanersByIds(pgCleanerIds, workDate, scope);
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
export async function loadSelectedCleaners(
  workDate: string,
  scope: 'housekeeping' | 'office' = 'housekeeping'
): Promise<any | null> {
  try {
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    const pgCleanerIds = await pgDailyAssignmentsService.loadSelectedCleaners(workDate, scope);
    
    if (pgCleanerIds && pgCleanerIds.length > 0) {
      // Get full cleaner data from cleaners table for the current scope.
      // If some IDs are not found in the current scope, fallback to same-date roster without scope filter
      // to preserve role/name integrity during scope transitions.
      const fullCleaners = await pgDailyAssignmentsService.loadCleanersByIds(pgCleanerIds, workDate, scope);
      const scopedFoundIds = new Set<number>(fullCleaners.map((c: any) => Number(c.id)));
      const missingIds = pgCleanerIds
        .map((id: any) => Number(id))
        .filter((id: number) => Number.isFinite(id) && !scopedFoundIds.has(id));
      const fallbackCleaners =
        missingIds.length > 0
          ? await pgDailyAssignmentsService.loadCleanersByIdsAnyScope(missingIds, workDate)
          : [];
      const aliasMap = await pgDailyAssignmentsService.getAllCleanerAliases();
      const fullById = new Map<number, any>();
      for (const c of fullCleaners) {
        fullById.set(Number(c.id), c);
      }
      for (const c of fallbackCleaners) {
        const id = Number(c.id);
        if (!fullById.has(id)) fullById.set(id, c);
      }
      
      // Ensure all cleaners have required fields
      const cleanersData = pgCleanerIds.map((rawId: any) => {
        const id = Number(rawId);
        const c = fullById.get(id);
        const aliasData = aliasMap.get(id);
        return {
          id,
          name: c?.name || aliasData?.name || `ID ${id}`,
          lastname: c?.lastname || aliasData?.lastname || '',
          role: c?.role || null,
          premium: Boolean(c?.premium),
          start_time: c?.start_time ?? '10:00',
          active: c?.active !== false,
          available: c?.available !== false,
          ranking: c?.ranking || 0,
          counter_hours: c?.counter_hours || 0,
          counter_days: c?.counter_days || 0,
          contract_type: c?.contract_type || null,
          preferred_customers: c?.preferred_customers || [],
          telegram_id: c?.telegram_id || null,
          alias: c?.alias || aliasData?.alias || null,
        };
      });
      
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
 * PRIMARY: PostgreSQL (IDs to daily_selected_cleaners)
 * Now with revision tracking via selected_cleaners_revisions table
 */
export async function saveSelectedCleaners(
  workDate: string, 
  data: any, 
  skipRevision: boolean = false, 
  createdBy: string = 'system', 
  modificationType: string = 'MANUAL',
  scope?: 'housekeeping' | 'office'
): Promise<boolean> {
  try {
    const resolvedScope: 'housekeeping' | 'office' =
      scope ?? (data?.metadata?.scope === 'office' ? 'office' : 'housekeeping');
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
    
    // Determine action type based on modificationType
    const actionType = skipRevision ? 'INIT' : modificationType.toUpperCase();
    
    // Build action payload
    const actionPayload = data.actionPayload || null;
    
    await pgDailyAssignmentsService.saveSelectedCleaners(workDate, cleanerIds, actionType, actionPayload, createdBy, resolvedScope);
    
    console.log(`✅ Selected cleaners saved to PostgreSQL for ${workDate}: ${cleanerIds.length} IDs`);

    if (isPastDate) {
      console.log(`📜 Data passata ${workDate} - salvato su PG`);
      return true;
    }

    // PostgreSQL is the only source of truth - no legacy MySQL writes
    return true;
  } catch (err) {
    console.error(`Error saving selected cleaners for ${workDate}:`, err);
    return false;
  }
}

/**
 * Reset timeline: svuota assegnazioni
 */
/**
 * Logistics timeline (PostgreSQL daily_logistics_assignments_*)
 */
export async function loadLogisticsTimeline(workDate: string): Promise<any | null> {
  try {
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    const tl = await pgDailyAssignmentsService.loadLogisticsTimeline(workDate);
    if (tl) {
      return getNormalizedLogisticsTimeline(tl);
    }
  } catch (err) {
    console.error(`❌ loadLogisticsTimeline:`, err);
  }
  return null;
}

export async function saveLogisticsTimeline(
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
    const normalized = getNormalizedLogisticsTimeline(data);
    normalized.metadata = normalized.metadata || {};
    normalized.metadata.date = workDate;
    normalized.metadata.last_updated = getRomeTimestamp();
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    await pgDailyAssignmentsService.saveLogisticsTimeline(workDate, normalized);
    let editedFields: string[] = [];
    let oldValues: string[] = [];
    let newValues: string[] = [];
    if (editOptions) {
      if (editOptions.editedFields?.length) {
        editedFields = editOptions.editedFields;
        oldValues = editOptions.oldValues || [];
        newValues = editOptions.newValues || [];
      } else if (editOptions.editedField) {
        editedFields = [editOptions.editedField];
        oldValues = editOptions.oldValue ? [editOptions.oldValue] : [];
        newValues = editOptions.newValue ? [editOptions.newValue] : [];
      }
    }
    if (!skipRevision) {
      await pgDailyAssignmentsService.saveLogisticsTimelineToHistory(
        workDate,
        normalized,
        createdBy,
        modificationType,
        editedFields,
        oldValues,
        newValues
      );
    }
    return true;
  } catch (err) {
    console.error(`❌ saveLogisticsTimeline:`, err);
    return false;
  }
}

export async function resetLogisticsTimeline(
  workDate: string,
  createdBy: string = 'system',
  modificationType: string = 'reset'
): Promise<boolean> {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetDate = new Date(workDate);
    targetDate.setHours(0, 0, 0, 0);
    if (targetDate < today) {
      console.log(`🚫 resetLogisticsTimeline data passata ${workDate} — bloccato`);
      return false;
    }
    const empty = {
      metadata: {
        date: workDate,
        last_updated: getRomeTimestamp(),
        created_by: createdBy,
      },
      drivers_assignments: [],
      meta: { total_drivers: 0, used_drivers: 0, assigned_tasks: 0 },
    };
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    await pgDailyAssignmentsService.saveLogisticsTimeline(workDate, empty);
    await pgDailyAssignmentsService.saveLogisticsTimelineToHistory(
      workDate,
      empty,
      createdBy,
      modificationType,
      [],
      [],
      []
    );
    return true;
  } catch (err) {
    console.error(`❌ resetLogisticsTimeline:`, err);
    return false;
  }
}

export async function loadSelectedLogisticsDrivers(workDate: string): Promise<any | null> {
  try {
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    const ids = await pgDailyAssignmentsService.loadSelectedLogisticsDrivers(workDate);
    const vehicleAssignments = await pgDailyAssignmentsService.loadSelectedLogisticsDriverVehicleAssignments(workDate);
    if (ids && ids.length > 0) {
      const rows = await pgDailyAssignmentsService.loadLgDriversByIds(ids, workDate);
      const byId = new Map<number, any>(rows.map((r: any) => [Number(r.id), r]));
      const driversData = ids.map((id) => {
        const row = byId.get(id);
        const assignment = vehicleAssignments?.[String(id)] || null;
        if (row) {
          return {
            id,
            name: row.name ?? 'Driver',
            lastname: row.lastname ?? String(id),
            role: row.role ?? 'Driver',
            premium: row.role === 'Premium',
            start_time: row.start_time ?? '10:00',
            active: row.active !== false,
            available: row.available !== false,
            counter_hours: row.counter_hours ?? 0,
            counter_days: row.counter_days ?? 0,
            contract_type: row.contract_type ?? null,
            alias: row.alias ?? undefined,
            assigned_vehicle_id: assignment?.vehicle_id ?? null,
            assigned_vehicle_name: assignment?.vehicle_name ?? null,
            assigned_vehicle_pms_code: assignment?.vehicle_pms_code ?? null,
            assigned_vehicle_task_id: assignment?.vehicle_task_id ?? null,
          };
        }
        return {
          id,
          name: 'Driver',
          lastname: String(id),
          role: 'Driver',
          premium: false,
          start_time: '10:00',
          active: true,
          available: true,
          counter_hours: 0,
          counter_days: 0,
          contract_type: null,
          assigned_vehicle_id: assignment?.vehicle_id ?? null,
          assigned_vehicle_name: assignment?.vehicle_name ?? null,
          assigned_vehicle_pms_code: assignment?.vehicle_pms_code ?? null,
          assigned_vehicle_task_id: assignment?.vehicle_task_id ?? null,
        };
      });
      return {
        drivers: driversData,
        total_selected: driversData.length,
        metadata: { date: workDate, loaded_at: getRomeTimestamp() },
      };
    }
    return {
      drivers: [],
      total_selected: 0,
      metadata: { date: workDate, loaded_at: getRomeTimestamp() },
    };
  } catch (err) {
    console.error(`❌ loadSelectedLogisticsDrivers:`, err);
    return null;
  }
}

export async function saveSelectedLogisticsDrivers(
  workDate: string,
  data: any,
  skipRevision: boolean = false,
  createdBy: string = 'system',
  modificationType: string = 'MANUAL'
): Promise<boolean> {
  try {
    data.metadata = data.metadata || {};
    data.metadata.date = workDate;
    data.metadata.last_updated = getRomeTimestamp();
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    const arr = data.drivers || [];
    const driverIds = arr.map((d: any) => (typeof d === 'number' ? d : d.id)).filter((id: any) => id != null);
    const vehicleAssignments: Record<string, any> = {};
    for (const d of arr) {
      if (!d || typeof d !== 'object' || d.id == null) continue;
      const driverId = String(d.id);
      const vehicleIdRaw = d.assigned_vehicle_id;
      if (vehicleIdRaw == null || vehicleIdRaw === '') continue;
      const vehicleId = Number(vehicleIdRaw);
      if (!Number.isFinite(vehicleId)) continue;
      const taskIdRaw = d.assigned_vehicle_task_id;
      const vehicleTaskId =
        taskIdRaw != null && taskIdRaw !== '' && Number.isFinite(Number(taskIdRaw))
          ? Number(taskIdRaw)
          : null;
      vehicleAssignments[driverId] = {
        vehicle_id: vehicleId,
        vehicle_name: d.assigned_vehicle_name ?? null,
        vehicle_pms_code: d.assigned_vehicle_pms_code ?? null,
        vehicle_task_id: vehicleTaskId,
      };
    }
    const actionType = skipRevision ? 'INIT' : modificationType.toUpperCase();
    return await pgDailyAssignmentsService.saveSelectedLogisticsDrivers(
      workDate,
      driverIds,
      actionType,
      data.actionPayload || null,
      createdBy,
      vehicleAssignments
    );
  } catch (err) {
    console.error(`❌ saveSelectedLogisticsDrivers:`, err);
    return false;
  }
}

export async function resetTimeline(
  workDate: string,
  createdBy: string = 'system',
  modificationType: string = 'reset',
  scope: 'housekeeping' | 'office' = 'housekeeping'
): Promise<boolean> {
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
    await pgDailyAssignmentsService.saveTimeline(workDate, emptyTimeline, scope);
    await pgDailyAssignmentsService.saveToHistory(workDate, emptyTimeline, createdBy, modificationType, [], [], [], scope);
    console.log(`✅ Timeline reset in PostgreSQL for ${workDate}`);

    // PostgreSQL is the only source of truth - no legacy MySQL writes
    return true;
  } catch (err) {
    console.error(`Error resetting timeline for ${workDate}:`, err);
    return false;
  }
}

/**
 * Get raw file paths (deprecated - PostgreSQL is the only source of truth)
 */
export function getFilePaths() {
  return { 
    selectedCleaners: null,
    timeline: null,
    containers: null
  };
}
