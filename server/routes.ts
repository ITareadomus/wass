import type { Express } from "express";
import { createServer, type Server } from "http";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import * as fs from 'fs/promises';
import { format } from "date-fns";
import { it } from "date-fns/locale";
import { formatInTimeZone } from "date-fns-tz";
import { databaseConfig } from "../config/database";

const isTrue = (v: any) => v === true || v === 1 || v === "1" || v === "true";

const toRomeDatetime = (d: Date) =>
  formatInTimeZone(d, "Europe/Rome", "yyyy-MM-dd HH:mm:ss");

const toAssignedAtMilliseconds = (d: Date) =>
  formatInTimeZone(d, "Europe/Rome", "yyyyMMddHHmmss") +
  String(d.getMilliseconds()).padStart(3, "0") +
  "000";

// Utility per timestamp in fuso orario di Roma
const ROME_TIMEZONE = "Europe/Rome";
function getRomeTimestamp(): string {
  return formatInTimeZone(new Date(), ROME_TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss");
}

function isOfficeScope(scope: unknown): boolean {
  return String(scope || "").toLowerCase() === "office";
}

function resolveScopeFromReq(req: any): "housekeeping" | "office" {
  return isOfficeScope(req?.query?.scope) || isOfficeScope(req?.body?.scope)
    ? "office"
    : "housekeeping";
}

const OFFICE_OPERATION_IDS = new Set([15, 38]);
const CONTINUAZIONE_PS_OPERATION_ID = 37;
const CONTINUAZIONE_PS_OPERATION_NAME = "continuazione ps";

function normalizeOperationName(value: unknown): string {
  return String(value ?? "").toLowerCase().trim();
}

function isContinuazionePsTask(task: any): boolean {
  const operationIdRaw = task?.operation_id ?? task?.operationId;
  const operationId = operationIdRaw != null ? Number(operationIdRaw) : NaN;
  if (!Number.isFinite(operationId) || operationId !== CONTINUAZIONE_PS_OPERATION_ID) {
    return false;
  }

  const operationNameRaw = task?.operation_name ?? task?.operationName ?? task?.operation_label;
  if (operationNameRaw == null || operationNameRaw === "") {
    return true;
  }
  return normalizeOperationName(operationNameRaw) === CONTINUAZIONE_PS_OPERATION_NAME;
}

function isTaskEquivalentToStraordinaria(task: any): boolean {
  return Boolean(task?.straordinaria) || isContinuazionePsTask(task);
}

function filterContainersForOfficeScope(containersPayload: any): any {
  if (!containersPayload?.containers) return containersPayload;

  const clone = JSON.parse(JSON.stringify(containersPayload));
  const buckets = ["early_out", "high_priority", "low_priority"] as const;

  for (const bucket of buckets) {
    const tasks = Array.isArray(clone.containers?.[bucket]?.tasks)
      ? clone.containers[bucket].tasks
      : [];
    const filteredTasks = tasks.filter((task: any) => {
      const opId = Number(task?.operation_id);
      return Number.isFinite(opId) && OFFICE_OPERATION_IDS.has(opId);
    });
    clone.containers[bucket].tasks = filteredTasks;
    clone.containers[bucket].count = filteredTasks.length;
  }

  const eo = clone.containers?.early_out?.count || 0;
  const hp = clone.containers?.high_priority?.count || 0;
  const lp = clone.containers?.low_priority?.count || 0;
  clone.summary = {
    ...(clone.summary || {}),
    early_out: eo,
    high_priority: hp,
    low_priority: lp,
    total_tasks: eo + hp + lp,
  };

  return clone;
}

import { storageService } from "./services/storage-service";
import * as workspaceFiles from "./services/workspace-files";
import {
  hydrateTasksFromLogisticsContainers,
  recalculateLogisticsDriverTimes,
} from "./services/logistics-timeline-utils";
import { registerLogisticsTimelineMutationRoutes } from "./logistics-timeline-mutation-routes";
import * as mysql from 'mysql2/promise';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const execAsync = promisify(exec);

// Costante bucket per Object Storage
const BUCKET = "wass_assignments";

// Directory per i dati di output (es. timeline.json, containers.json)
const DATA_OUTPUT_DIR = path.join(process.cwd(), 'client/public/data/output');
const CLEANERS_DIR = path.join(process.cwd(), 'client/public/data/cleaners');
const SCRIPTS_DIR = path.join(process.cwd(), 'client/public/scripts');

// Helper per ottenere l'username corrente dalla richiesta
function getCurrentUsername(req?: any): string {
  // Prova a ottenere username dalla sessione/header se disponibile
  // Per ora ritorna 'system' se non specificato
  return req?.body?.created_by || req?.body?.modified_by || 'system';
}

// ==================== ADAM helpers (MySQL) ====================
type ActiveAdamOpsCache = {
  fetchedAtMs: number;
  ids: number[];
};

let activeAdamOpsCache: ActiveAdamOpsCache | null = null;
let activeAdamRouteDriversOpsCache: ActiveAdamOpsCache | null = null;
const ACTIVE_ADAM_OPS_CACHE_TTL_MS = 60_000; // 60s: evita query continue durante polling

async function getCachedActiveAdamOperationIds(connection: any): Promise<number[]> {
  const now = Date.now();
  if (activeAdamOpsCache && now - activeAdamOpsCache.fetchedAtMs < ACTIVE_ADAM_OPS_CACHE_TTL_MS) {
    return activeAdamOpsCache.ids;
  }

  const [rows]: any = await connection.execute(
    `
      SELECT id
      FROM app_structure_operation
      WHERE active = 1 AND enable_wass = 1
    `
  );

  const ids = (Array.isArray(rows) ? rows : [])
    .map((r: any) => Number(r?.id))
    .filter((n: number) => Number.isFinite(n));

  activeAdamOpsCache = { fetchedAtMs: now, ids };
  return ids;
}

/** Operazioni WASS Logistics (coerente con create_containers.py: enable_route_drivers) */
async function getCachedActiveAdamRouteDriversOperationIds(connection: any): Promise<number[]> {
  const now = Date.now();
  if (
    activeAdamRouteDriversOpsCache &&
    now - activeAdamRouteDriversOpsCache.fetchedAtMs < ACTIVE_ADAM_OPS_CACHE_TTL_MS
  ) {
    return activeAdamRouteDriversOpsCache.ids;
  }

  const [rows]: any = await connection.execute(
    `
      SELECT id
      FROM app_structure_operation
      WHERE active = 1 AND enable_route_drivers = 1
    `
  );

  const ids = (Array.isArray(rows) ? rows : [])
    .map((r: any) => Number(r?.id))
    .filter((n: number) => Number.isFinite(n));

  activeAdamRouteDriversOpsCache = { fetchedAtMs: now, ids };
  return ids;
}

function isValidWorkDate(dateStr: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

/**
 * Helper: Load cleaner start_time from PostgreSQL (selected cleaners)
 * Falls back to filesystem if PostgreSQL fails
 */
async function getCleanerStartTime(
  cleanerId: number,
  workDate: string,
  scope: "housekeeping" | "office" = "housekeeping"
): Promise<string | null> {
  try {
    // Try PostgreSQL first
    const selectedCleaners = await workspaceFiles.loadSelectedCleaners(workDate, scope);
    if (selectedCleaners?.cleaners) {
      const cleaner = selectedCleaners.cleaners.find((c: any) => c.id === cleanerId);
      if (cleaner?.start_time) {
        return cleaner.start_time;
      }
    }
  } catch (err) {
    console.warn(`⚠️ Could not load start_time from PostgreSQL for cleaner ${cleanerId}`);
  }
  return null;
}

/**
 * Helper: Load full cleaner data from PostgreSQL
 */
async function getCleanerData(
  cleanerId: number,
  workDate: string,
  scope: "housekeeping" | "office" = "housekeeping"
): Promise<any | null> {
  try {
    const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
    return await pgDailyAssignmentsService.loadCleanerById(cleanerId, workDate, scope);
  } catch (err) {
    console.warn(`⚠️ Could not load cleaner ${cleanerId} from PostgreSQL`);
    return null;
  }
}

/**
 * Helper: Load all cleaners for a date from PostgreSQL
 */
async function getAllCleanersForDate(
  workDate: string,
  scope: "housekeeping" | "office" = "housekeeping"
): Promise<any[]> {
  try {
    const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
    const cleaners = await pgDailyAssignmentsService.loadCleanersForDate(workDate, scope);
    return cleaners || [];
  } catch (err) {
    console.warn(`⚠️ Could not load cleaners from PostgreSQL for ${workDate}`);
    return [];
  }
}

/**
 * Helper: Check if a cleaner is locked for a work_date (daily_cleaner_locks)
 * Locked cleaner = cannot receive manual assignments / D&D (server-side enforcement)
 */
async function isCleanerLocked(workDate: string, cleanerId: number): Promise<boolean> {
  if (!workDate || !Number.isFinite(cleanerId)) {
    console.log(`⚠️ isCleanerLocked: Invalid params - workDate=${workDate}, cleanerId=${cleanerId}`);
    return false;
  }

  console.log(`🔍 isCleanerLocked: Checking workDate=${workDate}, cleanerId=${cleanerId}`);
  const { query } = await import("../shared/pg-db");

  try {
    const result = await query(
      `
        SELECT 1
        FROM daily_cleaner_locks
        WHERE work_date = $1 AND cleaner_id = $2 AND is_locked = true
        LIMIT 1
      `,
      [workDate, cleanerId]
    );

    const isLocked = (result.rows?.length ?? 0) > 0;
    console.log(`🔍 isCleanerLocked: Query returned ${result.rows?.length ?? 0} rows, isLocked=${isLocked}`);
    return isLocked;
  } catch (error) {
    console.error(`❌ isCleanerLocked: Database error:`, error);
    return false;
  }
}

/**
 * Helper: Hydrate tasks with lat/lng/address from PostgreSQL
 * Searches both daily_assignments_current (assigned tasks) and daily_containers (unassigned tasks)
 */
async function hydrateTasksFromContainers(cleanerData: any, workDate: string): Promise<any> {
  if (!cleanerData?.tasks || cleanerData.tasks.length === 0) {
    return cleanerData;
  }

  try {
    const { query } = await import("../shared/pg-db");
    
    // Get task_ids that need coordinates
    const taskIds = cleanerData.tasks
      .map((t: any) => t.task_id)
      .filter((id: any) => id != null);
    
    console.log(`🔍 Hydration: searching for task_ids: ${JSON.stringify(taskIds)} on date ${workDate}`);
    
    if (taskIds.length === 0) {
      return cleanerData;
    }

    // Query both tables to find coordinates - assignments first (already assigned), then containers (unassigned)
    // CAST to numeric because daily_containers stores lat/lng as varchar while daily_assignments_current uses numeric
    const result = await query(`
      SELECT task_id, lat, lng, address FROM (
        SELECT task_id, lat::numeric, lng::numeric, address FROM daily_assignments_current 
        WHERE work_date = $1 AND task_id = ANY($2)
        UNION ALL
        SELECT task_id, lat::numeric, lng::numeric, address FROM daily_containers 
        WHERE work_date = $1 AND task_id = ANY($2)
      ) combined
    `, [workDate, taskIds]);
    
    console.log(`🔍 Hydration query returned ${result.rows.length} rows:`, result.rows.slice(0, 3));

    // Build lookup map - first occurrence wins (assignments take priority)
    // IMPORTANT: Convert task_id to number because PostgreSQL returns it as string
    const coordsMap = new Map<number, { lat: number | null; lng: number | null; address: string | null }>();
    
    for (const row of result.rows) {
      const taskIdNum = parseInt(String(row.task_id), 10);
      if (!coordsMap.has(taskIdNum)) {
        const lat = row.lat != null ? parseFloat(String(row.lat)) : null;
        const lng = row.lng != null ? parseFloat(String(row.lng)) : null;
        
        coordsMap.set(taskIdNum, {
          lat: (lat && !isNaN(lat) && Math.abs(lat) > 0.0001) ? lat : null,
          lng: (lng && !isNaN(lng) && Math.abs(lng) > 0.0001) ? lng : null,
          address: row.address || null
        });
      }
    }

    // Merge coordinates into cleaner's tasks
    let hydratedCount = 0;
    for (const task of cleanerData.tasks) {
      // CRITICAL: Convert task_id to number for lookup (mappa uses numeric keys)
      const taskIdNum = parseInt(String(task.task_id), 10);
      const geo = coordsMap.get(taskIdNum);
      if (geo) {
        if (geo.lat !== null) {
          task.lat = geo.lat;
          hydratedCount++;
        }
        if (geo.lng !== null) {
          task.lng = geo.lng;
        }
        if (geo.address && !task.address) {
          task.address = geo.address;
        }
      }
    }

    console.log(`✅ Hydrated ${hydratedCount}/${cleanerData.tasks.length} tasks with coordinates from PostgreSQL`);
  } catch (error: any) {
    console.warn(`⚠️ Could not hydrate tasks from PostgreSQL: ${error.message}`);
  }

  return cleanerData;
}

// Utility: costruzione chiave file consistente
function buildKey(isoDate: string) {
  const d = new Date(isoDate);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = String(d.getFullYear());
  const shortYear = year.slice(-2);
  const folder = `${day}-${month}-${year}`;
  const filename = `assignments_${day}${month}${shortYear}.json`;
  return { key: `${folder}/${filename}`, d };
}

/**
 * Helper function to recalculate travel_time, start_time, end_time for a cleaner's tasks
 * CRITICAL: Ensures cleaner's start_time is loaded from PostgreSQL before recalculation
 */
async function recalculateCleanerTimes(cleanerData: any, workDate?: string): Promise<any> {
  try {
    const { spawn } = await import('child_process');

    // CRITICAL: Load start_time from PostgreSQL to ensure it's up-to-date
    const dateToUse = workDate || format(new Date(), 'yyyy-MM-dd');
    const startTime = await getCleanerStartTime(cleanerData.cleaner.id, dateToUse);
    if (startTime) {
      cleanerData.cleaner.start_time = startTime;
      console.log(`✅ Loaded start_time ${startTime} from PostgreSQL for cleaner ${cleanerData.cleaner.id}`);
    } else {
      console.warn(`⚠️ Could not load start_time from PostgreSQL for cleaner ${cleanerData.cleaner.id}, using default`);
    }

    return new Promise((resolve, reject) => {
      const scriptPath = path.join(process.cwd(), 'client/public/scripts/recalculate_times.py');
      const cleanerDataJson = JSON.stringify(cleanerData);

      // Usa spawn con stdin per evitare ARG_MAX limit e command injection
      const pythonProcess = spawn('python3', [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      pythonProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      pythonProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      pythonProcess.on('close', (code) => {
        if (code !== 0) {
          console.error('Python stderr:', stderr);
          reject(new Error(`Python script exited with code ${code}: ${stderr}`));
          return;
        }

        if (stderr && stderr.trim()) {
          console.warn('Python stderr:', stderr);
        }

        try {
          const result = JSON.parse(stdout);

          if (!result.success) {
            reject(new Error(result.error || 'Unknown error from Python script'));
            return;
          }

          resolve(result.cleaner_data);
        } catch (parseError: any) {
          console.error('Failed to parse Python output:', parseError);
          reject(new Error(`Failed to parse Python output: ${parseError.message}`));
        }
      });

      pythonProcess.on('error', (error) => {
        console.error('Failed to spawn Python process:', error);
        reject(new Error(`Failed to spawn Python process: ${error.message}`));
      });

      // Scrivi il JSON su stdin e chiudi
      try {
        pythonProcess.stdin.write(cleanerDataJson);
        pythonProcess.stdin.end();
      } catch (writeError: any) {
        console.error('Failed to write to Python process:', writeError);
        reject(new Error(`Failed to write to Python process: ${writeError.message}`));
      }
    });
  } catch (error: any) {
    console.error('Error in recalculateCleanerTimes:', error);
    throw error;
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Initialize PostgreSQL tables on startup
  try {
    const { pgUsersService } = await import("./services/pg-users-service");
    const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
    
    await pgUsersService.ensureTable();
    await pgDailyAssignmentsService.ensureCleanerAliasesAndRevisionsTables();
    await pgDailyAssignmentsService.ensureLockedColumns();
    await pgDailyAssignmentsService.ensureTaskLocksTable();
    await pgDailyAssignmentsService.ensureDailyAssignmentsRevisionsScopeUnique();
    await pgDailyAssignmentsService.ensureDailyContainersScopeUnique();
    await pgDailyAssignmentsService.ensureSelectedCleanersScopeStructure();
    await pgDailyAssignmentsService.ensureLogisticsWorkspaceTables();
    
    // Migrate existing users from JSON if table is empty
    const existingUsers = await pgUsersService.getAllUsers();
    if (existingUsers.length === 0) {
      try {
        const accountsPath = path.join(process.cwd(), 'client/public/data/accounts.json');
        const accountsData = JSON.parse(await fs.readFile(accountsPath, 'utf8'));
        if (accountsData.users && accountsData.users.length > 0) {
          await pgUsersService.migrateFromJson(accountsData.users);
          console.log('✅ Utenti migrati da accounts.json a PostgreSQL');
        }
      } catch (e) {
        console.log('ℹ️ Nessun accounts.json da migrare');
      }
    }
  } catch (initError) {
    console.warn('⚠️ Inizializzazione tabelle PostgreSQL fallita (non bloccante):', initError);
  }

  // Health check endpoint for Python API client
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: getRomeTimestamp() });
  });

  // Endpoint per il login (PostgreSQL)
  app.post("/api/login", async (req, res) => {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({
          success: false,
          message: "Username e password sono obbligatori"
        });
      }

      const { pgUsersService } = await import("./services/pg-users-service");
      const user = await pgUsersService.validateLogin(username, password);

      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Username o password non validi"
        });
      }

      const { password: _, ...userWithoutPassword } = user;

      res.json({
        success: true,
        user: userWithoutPassword,
        message: "Login effettuato con successo"
      });
    } catch (error: any) {
      console.error("Errore nel login:", error);
      res.status(500).json({
        success: false,
        message: "Errore interno del server"
      });
    }
  });

  // Endpoint per svuotare early_out.json dopo l'assegnazione
  app.post("/api/clear-early-out-json", async (req, res) => {
    try {
      const earlyOutPath = path.join(process.cwd(), 'client/public/data/output/early_out.json');

      // Svuota il file mantenendo la struttura
      await fs.writeFile(earlyOutPath, JSON.stringify({
        early_out_tasks: [],
        total_apartments: 0
      }, null, 2));

      res.json({ success: true, message: "early_out.json svuotato con successo" });
    } catch (error: any) {
      console.error("Errore nello svuotamento di early_out.json:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per resettare le assegnazioni della timeline
  app.post("/api/reset-timeline-assignments", async (req, res) => {
    try {
      const { date, modified_by } = req.body;
      const workDate = date || format(new Date(), 'yyyy-MM-dd');
      const currentUsername = modified_by || getCurrentUsername(req);

      console.log(`🔄 Reset assegnazioni per ${workDate}...`);

      const { refreshContainersFromAdam } = await import("./services/containers-refresh-service");

      // 1. Svuota la timeline
      const emptyTimeline = {
        metadata: {
          last_updated: getRomeTimestamp(),
          date: workDate,
          created_by: currentUsername
        },
        cleaners_assignments: [],
        meta: {
          total_cleaners: 0,
          used_cleaners: 0,
          assigned_tasks: 0
        }
      };

      await workspaceFiles.saveTimeline(workDate, emptyTimeline, false, currentUsername, 'timeline_reset', undefined, resolveScopeFromReq(req));
      console.log(`✅ Timeline svuotata su PostgreSQL`);

      // 2. Cancella le collaborazioni dalla tabella task_collaborators
      const { query } = await import("../shared/pg-db");
      await query(`DELETE FROM task_collaborators WHERE work_date = $1`, [workDate]);
      console.log(`✅ Collaborazioni cancellate da task_collaborators per ${workDate}`);

      // 3. Refresh containers direttamente da ADAM (fonte sorgente)
      console.log(`🔄 Refresh containers da ADAM per ${workDate}...`);
      const refreshResult = await refreshContainersFromAdam(workDate, currentUsername);
      
      if (!refreshResult.success) {
        console.warn(`⚠️ Refresh containers fallito: ${refreshResult.error}`);
      } else {
        console.log(`✅ Containers rigenerati da ADAM`);
      }

      // === RESET: NON modificare selected_cleaners ===
      console.log(`✅ Reset completato - selected_cleaners NON modificato`);

      res.json({ 
        success: true, 
        message: "Timeline resettata e containers rigenerati da ADAM",
        containersRefreshed: refreshResult.success
      });
    } catch (error: any) {
      console.error("Errore nel reset della timeline:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per spostare una task tra cleaners diversi nella timeline
  app.post("/api/move-task-between-cleaners", async (req, res) => {
    try {
      const { taskId, logisticCode, sourceCleanerId, destCleanerId, destIndex, date } = req.body;
      const workDate = date || format(new Date(), 'yyyy-MM-dd');

      // Verifica se la task è bloccata (enforcement)
      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      const { taskCollaborationService } = await import("./services/pg-task-collaboration-service");
      
      // ENFORCEMENT: blocca assegnazioni verso cleaner locked
      if (destCleanerId && Number.isFinite(Number(destCleanerId))) {
        const locked = await isCleanerLocked(workDate, Number(destCleanerId));
        if (locked) {
          console.log(`🔒 BLOCKED: Dest cleaner ${destCleanerId} locked for ${workDate}, move refused`);
          return res.status(423).json({
            success: false,
            error: "CLEANER_LOCKED",
            message: "Cleaner bloccato: impossibile assegnare",
            workDate,
            cleanerId: Number(destCleanerId)
          });
        }
      }

      if (taskId) {
        const isLocked = await pgDailyAssignmentsService.isTaskLocked(workDate, Number(taskId));
        if (isLocked) {
          const lockInfo = await pgDailyAssignmentsService.getTaskLock(workDate, Number(taskId));
          console.log(`🔒 BLOCKED: Task ${taskId} è bloccata, impossibile spostare`);
          return res.status(423).json({
            success: false,
            error: "TASK_LOCKED",
            message: "Task bloccata: impossibile assegnare",
            locked_reason: lockInfo?.lockedReason
          });
        }
      }

      // --- COLLABORATION-AWARE LOGIC ---
      // Se la task è collaborativa e il sourceCleanerId è uno dei collaboratori,
      // eseguiamo una "replace collaborator" invece di un semplice spostamento
      let isCollaborativeMove = false;
      
      // Normalizza ID a numeri per evitare confronti string/number
      const numTaskId = taskId ? Number(taskId) : null;
      const numSourceCleanerId = sourceCleanerId ? Number(sourceCleanerId) : null;
      const numDestCleanerId = destCleanerId ? Number(destCleanerId) : null;
      
      if (numTaskId && numSourceCleanerId && numDestCleanerId) {
        const { query } = await import("../shared/pg-db");
        // Self-heal: if pivot is stale/missing, derive collaboration from assignments
        // so drag-&-drop can't silently desync task_collaborators.
        const assignmentsCheck = await query(
          `SELECT array_agg(DISTINCT cleaner_id ORDER BY cleaner_id) AS cleaner_ids,
                  COUNT(DISTINCT cleaner_id)::int AS collaborator_count
           FROM daily_assignments_current
           WHERE work_date = $1 AND task_id = $2`,
          [workDate, numTaskId]
        );
        const assignedCleanerIds: number[] = (assignmentsCheck.rows[0]?.cleaner_ids || []).map((id: any) => Number(id));
        const assignedCount: number = Number(assignmentsCheck.rows[0]?.collaborator_count || 0);

        // If DB says it's collaborative, reconcile the pivot for this task first.
        if (assignedCount > 1) {
          await taskCollaborationService.reconcileTaskFromAssignments(workDate, numTaskId);
        }

        const collab = await taskCollaborationService.getCollaboration(workDate, numTaskId);
        
        if (collab.count > 1 && collab.cleanerIds.includes(numSourceCleanerId)) {
          // ENFORCEMENT: blocca replace collaborator verso cleaner locked
          const locked = await isCleanerLocked(workDate, numDestCleanerId);
          if (locked) {
            console.log(`🔒 BLOCKED: Dest cleaner ${numDestCleanerId} locked for ${workDate}, collaborator replace refused`);
            return res.status(423).json({
              success: false,
              error: "CLEANER_LOCKED",
              message: "Cleaner bloccato: impossibile assegnare",
              workDate,
              cleanerId: numDestCleanerId
            });
          }

          // Task è collaborativa e source è un collaboratore
          console.log(`🔄 Collaboration move detected: task ${numTaskId} has ${collab.count} collaborators`);
          
          // Blocca se destCleanerId è già un collaboratore
          if (collab.cleanerIds.includes(numDestCleanerId)) {
            console.log(`⚠️ BLOCKED: destCleanerId ${numDestCleanerId} è già collaboratore del task ${numTaskId}`);
            return res.status(400).json({
              success: false,
              error: "DEST_ALREADY_COLLABORATOR",
              message: "Il cleaner di destinazione è già collaboratore di questa task"
            });
          }
          
          // Esegui replace collaborator
          const replaceResult = await taskCollaborationService.replaceCollaborator(
            workDate,
            numTaskId,
            numSourceCleanerId,
            numDestCleanerId
          );
          
          if (!replaceResult.success) {
            return res.status(400).json({
              success: false,
              error: replaceResult.error,
              message: "Errore nella sostituzione del collaboratore"
            });
          }
          
          isCollaborativeMove = true;
          console.log(`✅ Collaboration: replaced cleaner ${numSourceCleanerId} -> ${numDestCleanerId} for task ${numTaskId}`);
          
          // CRITICAL: Return dopo collaboration move per evitare doppio spostamento
          return res.json({
            success: true,
            message: `Task ${logisticCode} collaborativa: cleaner ${numSourceCleanerId} sostituito con ${numDestCleanerId}`,
            isCollaborativeMove: true
          });
        }
      }
      // --- END COLLABORATION-AWARE LOGIC ---

      // Carica timeline da PostgreSQL
      let timelineData: any = await workspaceFiles.loadTimeline(workDate, resolveScopeFromReq(req));
      if (!timelineData) {
        timelineData = { cleaners_assignments: [], metadata: { date: workDate }, meta: { total_cleaners: 0, used_cleaners: 0, assigned_tasks: 0 } };
      }
      // Assicurati che meta esista sempre
      timelineData.meta = timelineData.meta || { total_cleaners: 0, used_cleaners: 0, assigned_tasks: 0 };

      let taskToMove: any = null;

      // 1. Trova e rimuovi la task dal cleaner di origine
      const sourceEntry = timelineData.cleaners_assignments.find((c: any) => c.cleaner.id === sourceCleanerId);
      if (sourceEntry) {
        const taskIndex = sourceEntry.tasks.findIndex((t: any) =>
          String(t.task_id) === String(taskId) || String(t.logistic_code) === String(logisticCode)
        );
        if (taskIndex !== -1) {
          taskToMove = sourceEntry.tasks.splice(taskIndex, 1)[0];
          // Ricalcola sequence per il cleaner di origine
          sourceEntry.tasks.forEach((t: any, i: number) => {
            t.sequence = i + 1;
            t.followup = i > 0;
          });
        }
      }

      if (!taskToMove) {
        return res.status(404).json({ success: false, message: "Task non trovata nel cleaner di origine" });
      }

      // 2. Aggiungi la task al cleaner di destinazione
      let destEntry = timelineData.cleaners_assignments.find((c: any) => c.cleaner.id === destCleanerId);

      // Se il cleaner di destinazione non esiste ancora, crealo
      if (!destEntry) {
        // Carica i dati del cleaner da PostgreSQL
        const cleanersData = await workspaceFiles.loadSelectedCleaners(workDate, resolveScopeFromReq(req));
        const cleanerInfo = cleanersData?.cleaners?.find((c: any) => c.id === destCleanerId);

        if (!cleanerInfo) {
          return res.status(404).json({ success: false, message: "Cleaner di destinazione non trovato" });
        }

        destEntry = {
          cleaner: cleanerInfo,
          tasks: []
        };
        timelineData.cleaners_assignments.push(destEntry);
      }

      // 3. Inserisci la task nella posizione specificata e aggiorna reason
      const targetIndex = destIndex !== undefined
        ? Math.max(0, Math.min(destIndex, destEntry.tasks.length))
        : destEntry.tasks.length;

      // Aggiorna la reason per indicare lo spostamento manuale
      taskToMove.reasons = taskToMove.reasons || [];
      if (!taskToMove.reasons.includes('manual_assignment')) {
        taskToMove.reasons.push('manual_assignment');
      }
      // Rimuovi eventuali reason automatiche
      taskToMove.reasons = taskToMove.reasons.filter((r: string) =>
        !['auto_assignment', 'early_out_assignment', 'high_priority_assignment', 'low_priority_assignment'].includes(r)
      );
      taskToMove.manually_moved = true;

      destEntry.tasks.splice(targetIndex, 0, taskToMove);

      // 4. Ricalcola tempi per il cleaner di origine e destinazione
      try {
        // Ricalcola cleaner di origine (se ha ancora task)
        if (sourceEntry && sourceEntry.tasks.length > 0) {
          await hydrateTasksFromContainers(sourceEntry, workDate);
          const updatedSourceData = await recalculateCleanerTimes(sourceEntry, workDate);
          sourceEntry.tasks = updatedSourceData.tasks;
          console.log(`✅ Tempi ricalcolati per cleaner sorgente ${sourceCleanerId}`);
        }

        // Ricalcola cleaner di destinazione
        await hydrateTasksFromContainers(destEntry, workDate);
        const updatedDestData = await recalculateCleanerTimes(destEntry, workDate);
        destEntry.tasks = updatedDestData.tasks;
        console.log(`✅ Tempi ricalcolati per cleaner destinazione ${destCleanerId}`);
      } catch (pythonError: any) {
        console.error(`⚠️ Errore nel ricalcolo dei tempi, continuo senza ricalcolare:`, pythonError.message);
        // Fallback: ricalcola solo sequence manualmente
        if (sourceEntry && sourceEntry.tasks.length > 0) {
          sourceEntry.tasks.forEach((t: any, i: number) => {
            t.sequence = i + 1;
            t.followup = i > 0;
          });
        }
        destEntry.tasks.forEach((t: any, i: number) => {
          t.sequence = i + 1;
          t.followup = i > 0;
        });
      }

      // 5. Aggiorna metadata (mantieni cleaner anche se vuoti), preservando created_by e aggiornando modified_by
      const modifyingUser = req.body.modified_by || req.body.created_by || getCurrentUsername(req);

      timelineData.metadata = timelineData.metadata || {};
      timelineData.metadata.last_updated = getRomeTimestamp();
      timelineData.metadata.date = workDate;

      // Preserva created_by se già esiste
      if (!timelineData.metadata.created_by) {
        timelineData.metadata.created_by = modifyingUser;
      }

      // Aggiorna modified_by array solo se l'utente non è 'system' o 'unknown'
      timelineData.metadata.modified_by = timelineData.metadata.modified_by || [];
      // Rimuovi 'system' e 'unknown' dall'array se presenti
      timelineData.metadata.modified_by = timelineData.metadata.modified_by.filter((user: string) =>
        user !== 'system' && user !== 'unknown'
      );
      if (modifyingUser && modifyingUser !== 'system' && modifyingUser !== 'unknown' && !timelineData.metadata.modified_by.includes(modifyingUser)) {
        timelineData.metadata.modified_by.push(modifyingUser);
      }

      timelineData.meta.total_cleaners = timelineData.cleaners_assignments.length;
      timelineData.meta.total_tasks = timelineData.cleaners_assignments.reduce(
        (sum: number, c: any) => sum + c.tasks.length,
        0
      );

      // Salva timeline (dual-write: filesystem + Object Storage)
      await workspaceFiles.saveTimeline(workDate, timelineData, false, modifyingUser, 'dnd_between_cleaners', undefined, resolveScopeFromReq(req));

      console.log(`✅ Task ${logisticCode} spostata da cleaner ${sourceCleanerId} a cleaner ${destCleanerId}`);
      res.json({ success: true, message: "Task spostata con successo tra cleaners" });
    } catch (error: any) {
      console.error("Errore nello spostamento tra cleaners:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per scambiare tutte le task tra due cleaners
  app.post("/api/swap-cleaners-tasks", async (req, res) => {
    try {
      const { sourceCleanerId, destCleanerId, date, modified_by } = req.body;

      if (!sourceCleanerId || !destCleanerId) {
        return res.status(400).json({
          success: false,
          message: "sourceCleanerId e destCleanerId sono obbligatori"
        });
      }

      if (sourceCleanerId === destCleanerId) {
        return res.status(400).json({
          success: false,
          message: "Non puoi scambiare le task con lo stesso cleaner"
        });
      }

      const workDate = date || format(new Date(), 'yyyy-MM-dd');

      // ENFORCEMENT: swap implica assegnazione reciproca, quindi blocca se uno dei due è locked
      const [sourceLocked, destLocked] = await Promise.all([
        isCleanerLocked(workDate, Number(sourceCleanerId)),
        isCleanerLocked(workDate, Number(destCleanerId))
      ]);
      if (sourceLocked || destLocked) {
        const lockedIds = [
          sourceLocked ? Number(sourceCleanerId) : null,
          destLocked ? Number(destCleanerId) : null
        ].filter((x): x is number => x !== null);

        console.log(`🔒 BLOCKED: Swap refused due to locked cleaners (${lockedIds.join(",")}) for ${workDate}`);
        return res.status(423).json({
          success: false,
          error: "CLEANER_LOCKED",
          message: "Cleaner bloccato: impossibile assegnare",
          workDate,
          lockedCleanerIds: lockedIds
        });
      }

      // Carica timeline da PostgreSQL
      let timelineData: any = await workspaceFiles.loadTimeline(workDate, resolveScopeFromReq(req));
      if (!timelineData) {
        timelineData = { cleaners_assignments: [], metadata: { date: workDate }, meta: { total_cleaners: 0, used_cleaners: 0, assigned_tasks: 0 } };
      }
      // Assicurati che meta esista sempre
      timelineData.meta = timelineData.meta || { total_cleaners: 0, used_cleaners: 0, assigned_tasks: 0 };

      // Trova entrambi i cleaners (creali se non esistono)
      let sourceEntry = timelineData.cleaners_assignments.find((c: any) => c.cleaner.id === sourceCleanerId);
      let destEntry = timelineData.cleaners_assignments.find((c: any) => c.cleaner.id === destCleanerId);

      // Se non esistono, creali con array vuoto (usa PostgreSQL)
      const selectedData = await workspaceFiles.loadSelectedCleaners(workDate, resolveScopeFromReq(req));
      
      if (!sourceEntry) {
        const cleanerData = selectedData?.cleaners?.find((c: any) => c.id === sourceCleanerId);

        if (!cleanerData) {
          return res.status(404).json({
            success: false,
            message: `Cleaner sorgente ${sourceCleanerId} non trovato`
          });
        }

        sourceEntry = {
          cleaner: {
            id: cleanerData.id,
            name: cleanerData.name,
            lastname: cleanerData.lastname,
            role: cleanerData.role,
            premium: cleanerData.role === "Premium"
          },
          tasks: []
        };
        timelineData.cleaners_assignments.push(sourceEntry);
      }

      if (!destEntry) {
        const cleanerData = selectedData?.cleaners?.find((c: any) => c.id === destCleanerId);

        if (!cleanerData) {
          return res.status(404).json({
            success: false,
            message: `Cleaner destinazione ${destCleanerId} non trovato`
          });
        }

        destEntry = {
          cleaner: {
            id: cleanerData.id,
            name: cleanerData.name,
            lastname: cleanerData.lastname,
            role: cleanerData.role,
            premium: cleanerData.role === "Premium"
          },
          tasks: []
        };
        timelineData.cleaners_assignments.push(destEntry);
      }

      // Scambia SOLO le task array tra i due cleaner specificati
      const sourceTasks = sourceEntry.tasks;
      const destTasks = destEntry.tasks;

      // Preserve current primary mapping for swapped tasks to maintain the rule:
      // if a primary collaborator is replaced by the destination cleaner, the destination becomes primary.
      const swappedTaskIds = Array.from(new Set([
        ...sourceTasks.map((t: any) => Number(t.task_id ?? t.id)).filter((x: any) => Number.isFinite(x)),
        ...destTasks.map((t: any) => Number(t.task_id ?? t.id)).filter((x: any) => Number.isFinite(x)),
      ]));

      const primaryBeforeSwap = new Map<number, number>();
      if (swappedTaskIds.length > 0) {
        const { query } = await import("../shared/pg-db");
        const primRes = await query(
          `SELECT task_id, cleaner_id
           FROM task_collaborators
           WHERE work_date = $1 AND is_primary = true AND task_id = ANY($2::int[])`,
          [workDate, swappedTaskIds]
        );
        for (const r of primRes.rows) {
          primaryBeforeSwap.set(Number(r.task_id), Number(r.cleaner_id));
        }
      }

      sourceEntry.tasks = destTasks;
      destEntry.tasks = sourceTasks;

      // Marca tutte le task come manual_assignment
      const markTasksAsManual = (tasks: any[]) => {
        tasks.forEach((task: any) => {
          task.reasons = task.reasons || [];
          if (!task.reasons.includes('manual_assignment')) {
            task.reasons.push('manual_assignment');
          }
          // Rimuovi eventuali reason automatiche
          task.reasons = task.reasons.filter((r: string) =>
            !['auto_assignment', 'early_out_assignment', 'high_priority_assignment', 'low_priority_assignment'].includes(r)
          );
        });
      };

      markTasksAsManual(sourceEntry.tasks);
      markTasksAsManual(destEntry.tasks);
      for (const task of sourceEntry.tasks) task.manually_moved = true;
      for (const task of destEntry.tasks) task.manually_moved = true;

      // CRITICAL: Non modificare timelineData.cleaners_assignments
      // Gli entry sourceEntry e destEntry sono riferimenti diretti agli oggetti nell'array
      // quindi lo scambio è già applicato senza dover riassegnare l'array

      // Ricalcola tempi per entrambi i cleaners
      try {
        if (sourceEntry.tasks.length > 0) {
          await hydrateTasksFromContainers(sourceEntry, workDate);
          const updatedSourceData = await recalculateCleanerTimes(sourceEntry, workDate);
          sourceEntry.tasks = updatedSourceData.tasks;
          console.log(`✅ Tempi ricalcolati per cleaner ${sourceCleanerId} (dopo swap)`);
        }

        if (destEntry.tasks.length > 0) {
          await hydrateTasksFromContainers(destEntry, workDate);
          const updatedDestData = await recalculateCleanerTimes(destEntry, workDate);
          destEntry.tasks = updatedDestData.tasks;
          console.log(`✅ Tempi ricalcolati per cleaner ${destCleanerId} (dopo swap)`);
        }
      } catch (pythonError: any) {
        console.error(`⚠️ Errore nel ricalcolo dei tempi, continuo senza ricalcolare:`, pythonError.message);
        // Fallback: ricalcola solo sequence manualmente
        const updateSequence = (tasks: any[]) => {
          tasks.forEach((t: any, i: number) => {
            t.sequence = i + 1;
            t.followup = i > 0;
          });
        };
        updateSequence(sourceEntry.tasks);
        updateSequence(destEntry.tasks);
      }

      // Aggiorna metadata (mantieni cleaner anche se vuoti), preservando created_by e aggiornando modified_by
      const modifyingUser = modified_by || getCurrentUsername(req);

      timelineData.metadata = timelineData.metadata || {};
      timelineData.metadata.last_updated = getRomeTimestamp();
      timelineData.metadata.date = workDate;

      // Preserva created_by se già esiste
      if (!timelineData.metadata.created_by) {
        timelineData.metadata.created_by = modifyingUser;
      }

      // Aggiorna modified_by array solo se l'utente non è 'system' o 'unknown'
      timelineData.metadata.modified_by = timelineData.metadata.modified_by || [];
      timelineData.metadata.modified_by = timelineData.metadata.modified_by.filter((user: string) =>
        user !== 'system' && user !== 'unknown'
      );
      if (modifyingUser && modifyingUser !== 'system' && modifyingUser !== 'unknown' && !timelineData.metadata.modified_by.includes(modifyingUser)) {
        timelineData.metadata.modified_by.push(modifyingUser);
      }

      // Inizializza meta se non esiste
      timelineData.meta = timelineData.meta || {};
      timelineData.meta.total_cleaners = timelineData.cleaners_assignments.length;
      timelineData.meta.total_tasks = timelineData.cleaners_assignments.reduce(
        (sum: number, c: any) => sum + c.tasks.length,
        0
      );

      // Salva timeline (dual-write: filesystem + Object Storage)
      await workspaceFiles.saveTimeline(workDate, timelineData, false, modifyingUser, 'swap_cleaners_tasks', undefined, resolveScopeFromReq(req));

      // After swap + reconcile, restore primary according to swapped cleaner mapping (best-effort).
      // Note: saveTimeline already reconciles membership; here we only adjust primary when needed.
      try {
        const { taskCollaborationService } = await import("./services/pg-task-collaboration-service");
        for (const taskIdNum of swappedTaskIds) {
          const prevPrimary = primaryBeforeSwap.get(taskIdNum);
          if (!prevPrimary) continue;
          if (prevPrimary === Number(sourceCleanerId)) {
            await taskCollaborationService.setPrimaryCollaborator(workDate, taskIdNum, Number(destCleanerId));
          } else if (prevPrimary === Number(destCleanerId)) {
            await taskCollaborationService.setPrimaryCollaborator(workDate, taskIdNum, Number(sourceCleanerId));
          }
        }
      } catch (primaryErr) {
        console.warn("⚠️ Swap: errore nel ripristino primary (best-effort):", primaryErr);
      }

      console.log(`✅ Task scambiate tra cleaner ${sourceCleanerId} e cleaner ${destCleanerId}`);
      res.json({
        success: true,
        message: "Task scambiate con successo tra cleaners",
        swapped: {
          source: { cleanerId: sourceCleanerId, tasksCount: sourceEntry.tasks.length },
          dest: { cleanerId: destCleanerId, tasksCount: destEntry.tasks.length }
        }
      });
    } catch (error: any) {
      console.error("Errore nello scambio task tra cleaners:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per leggere la timeline corrente da DB (daily_assignments_current)
  // Il frontend dovrebbe usare questo endpoint invece di leggere direttamente timeline.json
  app.get("/api/timeline", async (req, res) => {
    try {
      const dateParam = (req.query.date as string) || format(new Date(), "yyyy-MM-dd");
      const workDate = dateParam;
      const officeScope = isOfficeScope(req.query.scope);

      console.log(`📖 GET /api/timeline - Caricamento timeline per ${workDate}`);

      // Carica la timeline da PostgreSQL
      const timeline = await workspaceFiles.loadTimeline(workDate, officeScope ? "office" : "housekeeping");

      if (!timeline) {
        // Restituisci struttura vuota invece di 404 per compatibilità frontend
        return res.json({
          metadata: { date: workDate },
          cleaners_assignments: [],
          meta: { total_cleaners: 0, used_cleaners: 0, assigned_tasks: 0 }
        });
      }

      console.log(`✅ Timeline caricata per ${workDate}: ${timeline.cleaners_assignments?.length || 0} cleaners`);
      res.json(timeline);
    } catch (error: any) {
      console.error("Errore nel load della timeline:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  // Endpoint per leggere i containers correnti da PostgreSQL
  // Il frontend dovrebbe usare questo endpoint invece di leggere direttamente containers.json
  app.get("/api/containers", async (req, res) => {
    try {
      const dateParam = (req.query.date as string) || format(new Date(), "yyyy-MM-dd");
      const workDate = dateParam;
      const officeScope = isOfficeScope(req.query.scope);

      console.log(`📖 GET /api/containers - Caricamento containers per ${workDate}`);

      const containers = await workspaceFiles.loadContainers(workDate, officeScope ? "office" : "housekeeping");

      if (!containers) {
        return res.json({
          containers: {
            early_out: { tasks: [], count: 0 },
            high_priority: { tasks: [], count: 0 },
            low_priority: { tasks: [], count: 0 }
          },
          summary: {
            early_out: 0,
            high_priority: 0,
            low_priority: 0,
            total_tasks: 0
          },
          metadata: { date: workDate }
        });
      }

      const responsePayload = officeScope
        ? filterContainersForOfficeScope(containers)
        : containers;

      console.log(
        `✅ Containers caricati per ${workDate}: ${responsePayload.summary?.total_tasks || 0} task totali`
      );
      res.json(responsePayload);
    } catch (error: any) {
      console.error("Errore nel load dei containers:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  // Endpoint per leggere i cleaners selezionati da PostgreSQL
  // PostgreSQL è l'unica fonte di dati per i selected cleaners
  app.get("/api/selected-cleaners", async (req, res) => {
    try {
      const dateParam = (req.query.date as string) || format(new Date(), "yyyy-MM-dd");
      const workDate = dateParam;
      const officeScope = isOfficeScope(req.query.scope);

      console.log(`📖 GET /api/selected-cleaners - Caricamento cleaners selezionati per ${workDate}`);

      const selectedCleaners = await workspaceFiles.loadSelectedCleaners(workDate, officeScope ? "office" : "housekeeping");

      if (!selectedCleaners) {
        return res.json({
          cleaners: [],
          total_selected: 0,
          metadata: { date: workDate }
        });
      }

      // Arricchisci con last_worked_date e show_plus_one (stessa logica di GET /api/cleaners) per la timeline
      const cleanersList = selectedCleaners.cleaners || [];
      if (cleanersList.length > 0) {
        const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
        const lastTransfer = await pgDailyAssignmentsService.getLastTransferToAdamTimestamp(
          workDate,
          officeScope ? "office" : "housekeeping"
        );
        let inProgramIds: Set<number>;
        if (!lastTransfer) {
          const selectedIds = await pgDailyAssignmentsService.loadSelectedCleaners(
            workDate,
            officeScope ? "office" : "housekeeping"
          );
          inProgramIds = new Set(selectedIds ?? []);
        } else {
          inProgramIds = new Set();
        }
        const hasReportIds = new Set<number>();
        const lastWorkedByCleanerId = new Map<number, string>();

        try {
          const adamConnection = await mysql.createConnection({
            host: databaseConfig.mysql.host,
            port: databaseConfig.mysql.port,
            user: databaseConfig.mysql.user,
            password: databaseConfig.mysql.password,
            database: databaseConfig.mysql.database,
          });
          try {
            const [rows]: any = await adamConnection.execute(
              `SELECT cleaned_by_us, MAX(checkout) AS latest_cleaning
               FROM app_housekeeping
               WHERE cleaned = 1
               GROUP BY cleaned_by_us`
            );
            const list = Array.isArray(rows) ? rows : [];
            for (const r of list) {
              const id = Number(r?.cleaned_by_us);
              const checkout = r?.latest_cleaning;
              if (!Number.isFinite(id) || checkout == null) continue;
              let dateStr: string;
              if (checkout instanceof Date) {
                dateStr = format(checkout, "yyyy-MM-dd");
              } else {
                const s = String(checkout).trim();
                const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
                if (isoMatch) {
                  dateStr = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
                } else {
                  const d = new Date(s);
                  dateStr = !isNaN(d.getTime()) ? format(d, "yyyy-MM-dd") : "";
                }
              }
              if (dateStr) lastWorkedByCleanerId.set(id, dateStr);
            }

            const rcm = await import("./services/adam-report-collaboration-mysql");
            await rcm.mergeLastWorkedFromHousekeepingCollaborations(
              adamConnection,
              lastWorkedByCleanerId
            );
            await rcm.mergeLastWorkedFromReportCollaboration(adamConnection, lastWorkedByCleanerId);

            if (lastTransfer) {
              const [titRows]: any = await adamConnection.execute(
                `SELECT DISTINCT cleaned_by_us FROM app_housekeeping
                 WHERE checkout = ? AND deleted_at IS NULL AND deleted_at_client IS NULL`,
                [workDate]
              );
              const [collabRows]: any = await adamConnection.execute(
                `SELECT DISTINCT c.user_id FROM app_housekeeping_collaborations c
                 INNER JOIN app_housekeeping h ON c.housekeeping_id = h.id
                 WHERE h.checkout = ? AND h.deleted_at IS NULL AND h.deleted_at_client IS NULL AND (c.deleted_at IS NULL OR c.deleted_at = 0)`,
                [workDate]
              );
              for (const r of Array.isArray(titRows) ? titRows : []) {
                const id = Number(r?.cleaned_by_us);
                if (Number.isFinite(id)) inProgramIds.add(id);
              }
              for (const r of Array.isArray(collabRows) ? collabRows : []) {
                const id = Number(r?.user_id);
                if (Number.isFinite(id)) inProgramIds.add(id);
              }
            }

            const [reportRows]: any = await adamConnection.execute(
              `SELECT user_id FROM app_housekeeping_report WHERE DATE(updated_at) = ?`,
              [workDate]
            );
            for (const r of Array.isArray(reportRows) ? reportRows : []) {
              const id = Number(r?.user_id);
              if (Number.isFinite(id)) hasReportIds.add(id);
            }
            await rcm.addCollaboratorUserIdsWithReportOnDate(adamConnection, workDate, hasReportIds);
          } finally {
            await adamConnection.end();
          }
        } catch (adamErr: any) {
          console.warn("⚠️ ADAM non disponibile per selected-cleaners enrichment:", adamErr?.message);
        }

        selectedCleaners.cleaners = cleanersList.map((c: any) => {
          const cId = Number(c.id);
          return {
            ...c,
            last_worked_date: lastWorkedByCleanerId.get(cId) ?? null,
            show_plus_one: inProgramIds.has(cId) && !hasReportIds.has(cId),
          };
        });
      }

      console.log(`✅ Selected cleaners caricati per ${workDate}: ${selectedCleaners.cleaners?.length || 0} cleaners`);
      res.json(selectedCleaners);
    } catch (error: any) {
      console.error("Errore nel load dei selected cleaners:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  // Endpoint per leggere tutti i cleaners per una data da PostgreSQL
  // PostgreSQL è l'unica fonte di dati (cleaners.json non è più utilizzato)
  app.get("/api/cleaners", async (req, res) => {
    try {
      const dateParam = (req.query.date as string) || format(new Date(), "yyyy-MM-dd");
      const workDate = dateParam;
      const officeScope = isOfficeScope(req.query.scope);

      console.log(`📖 GET /api/cleaners - Caricamento cleaners per ${workDate}`);

      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      let cleaners = await pgDailyAssignmentsService.loadCleanersForDate(
        workDate,
        officeScope ? "office" : "housekeeping"
      );

      if (!cleaners || cleaners.length === 0) {
        // PostgreSQL is the only source of truth - no filesystem fallback
        console.log(`ℹ️ Nessun cleaner trovato in PostgreSQL per ${workDate}`);
        return res.json({
          cleaners: [],
          total: 0,
          metadata: { date: workDate, source: 'postgresql' }
        });
      }

      // show_plus_one: in programma per la data ma senza report ancora. Fonte "in programma": prima invio = selected_cleaners, dopo invio = ADAM (titolari + collaboratori)
      const lastTransfer = await pgDailyAssignmentsService.getLastTransferToAdamTimestamp(
        workDate,
        officeScope ? "office" : "housekeeping"
      );
      let inProgramIds: Set<number>;
      if (!lastTransfer) {
        const selectedIds = await pgDailyAssignmentsService.loadSelectedCleaners(
          workDate,
          officeScope ? "office" : "housekeeping"
        );
        inProgramIds = new Set(selectedIds ?? []);
      } else {
        inProgramIds = new Set();
      }
      const hasReportIds = new Set<number>();

      // Arricchisci con last_worked_date, in_program (se post-invio) e has_report da ADAM
      const lastWorkedByCleanerId = new Map<number, string>();
      try {
        const adamConnection = await mysql.createConnection({
          host: databaseConfig.mysql.host,
          port: databaseConfig.mysql.port,
          user: databaseConfig.mysql.user,
          password: databaseConfig.mysql.password,
          database: databaseConfig.mysql.database,
        });
        try {
          const [rows]: any = await adamConnection.execute(
            `SELECT cleaned_by_us, MAX(checkout) AS latest_cleaning
             FROM app_housekeeping
             WHERE cleaned = 1
             GROUP BY cleaned_by_us`
          );
          const list = Array.isArray(rows) ? rows : [];
          for (const r of list) {
            const id = Number(r?.cleaned_by_us);
            const checkout = r?.latest_cleaning;
            if (!Number.isFinite(id) || checkout == null) continue;
            let dateStr: string;
            if (checkout instanceof Date) {
              dateStr = format(checkout, "yyyy-MM-dd");
            } else {
              const s = String(checkout).trim();
              const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
              if (isoMatch) {
                dateStr = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
              } else {
                const d = new Date(s);
                dateStr = !isNaN(d.getTime()) ? format(d, "yyyy-MM-dd") : "";
              }
            }
            if (dateStr) lastWorkedByCleanerId.set(id, dateStr);
          }

          const rcm = await import("./services/adam-report-collaboration-mysql");
          await rcm.mergeLastWorkedFromHousekeepingCollaborations(
            adamConnection,
            lastWorkedByCleanerId
          );
          await rcm.mergeLastWorkedFromReportCollaboration(adamConnection, lastWorkedByCleanerId);

          // Dopo invio ADAM: "in programma" = titolari + collaboratori da app_housekeeping
          if (lastTransfer) {
            const [titRows]: any = await adamConnection.execute(
              `SELECT DISTINCT cleaned_by_us FROM app_housekeeping
               WHERE checkout = ? AND deleted_at IS NULL AND deleted_at_client IS NULL`,
              [workDate]
            );
            const [collabRows]: any = await adamConnection.execute(
              `SELECT DISTINCT c.user_id FROM app_housekeeping_collaborations c
               INNER JOIN app_housekeeping h ON c.housekeeping_id = h.id
               WHERE h.checkout = ? AND h.deleted_at IS NULL AND h.deleted_at_client IS NULL AND (c.deleted_at IS NULL OR c.deleted_at = 0)`,
              [workDate]
            );
            for (const r of Array.isArray(titRows) ? titRows : []) {
              const id = Number(r?.cleaned_by_us);
              if (Number.isFinite(id)) inProgramIds.add(id);
            }
            for (const r of Array.isArray(collabRows) ? collabRows : []) {
              const id = Number(r?.user_id);
              if (Number.isFinite(id)) inProgramIds.add(id);
            }
          }

          // Chi ha già report per questa data (app_housekeeping_report)
          const [reportRows]: any = await adamConnection.execute(
            `SELECT user_id FROM app_housekeeping_report WHERE DATE(updated_at) = ?`,
            [workDate]
          );
          for (const r of Array.isArray(reportRows) ? reportRows : []) {
            const id = Number(r?.user_id);
            if (Number.isFinite(id)) hasReportIds.add(id);
          }
          await rcm.addCollaboratorUserIdsWithReportOnDate(adamConnection, workDate, hasReportIds);
        } finally {
          await adamConnection.end();
        }
      } catch (adamErr: any) {
        console.warn("⚠️ ADAM non disponibile per last_worked_date / show_plus_one:", adamErr?.message);
      }

      cleaners = cleaners.map((c: any) => {
        const cId = Number(c.id);
        const show_plus_one = inProgramIds.has(cId) && !hasReportIds.has(cId);
        return {
          ...c,
          last_worked_date: lastWorkedByCleanerId.get(cId) ?? null,
          show_plus_one,
        };
      });

      console.log(`✅ Cleaners caricati da PostgreSQL per ${workDate}: ${cleaners.length}`);
      res.json({
        cleaners,
        total: cleaners.length,
        metadata: { date: workDate, source: 'postgresql' }
      });
    } catch (error: any) {
      console.error("Errore nel load dei cleaners:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  // GET /api/operations - Operazioni attive da DB (app_structure_operation + langs)
  // Query: for=logistics → enable_route_drivers (pagina WASS Logistics); default → enable_wass (housekeeping)
  app.get("/api/operations", async (req, res) => {
    let connection: mysql.Connection | null = null;
    try {
      const forLogistics =
        String(req.query.for || "").toLowerCase() === "logistics" ||
        String(req.query.workflow || "").toLowerCase() === "logistics";
      const forOffice =
        isOfficeScope(req.query.scope) ||
        String(req.query.for || "").toLowerCase() === "office" ||
        String(req.query.workflow || "").toLowerCase() === "office";
      connection = await mysql.createConnection({
        host: databaseConfig.mysql.host,
        port: databaseConfig.mysql.port,
        user: databaseConfig.mysql.user,
        password: databaseConfig.mysql.password,
        database: databaseConfig.mysql.database,
      });
      let rows: any[] = [];
      if (forOffice) {
        const [officeRows]: any = await connection.execute(
          `SELECT o.id, l.name
           FROM app_structure_operation o
           LEFT JOIN app_structure_operation_langs l
             ON l.structure_operation_id = o.id AND l.id_lang = 1
           WHERE o.id IN (15, 38)
           ORDER BY FIELD(o.id, 15, 38)`
        );
        rows = Array.isArray(officeRows) ? officeRows : [];
      } else {
        const enableClause = forLogistics ? "o.enable_route_drivers = 1" : "o.enable_wass = 1";
        const [defaultRows]: any = await connection.execute(
          `SELECT o.id, l.name
           FROM app_structure_operation o
           INNER JOIN app_structure_operation_langs l
             ON l.structure_operation_id = o.id AND l.id_lang = 1
           WHERE o.active = 1 AND ${enableClause}
           ORDER BY o.id`
        );
        rows = Array.isArray(defaultRows) ? defaultRows : [];
      }
      const list = Array.isArray(rows) ? rows : [];
      const officeFallbackNames: Record<number, string> = {
        15: "PULIZIA UFFICI/ALTRO",
        38: "PULIZIA UFFICI/ALTRO STRAORDINARIA",
      };
      const active_operations = list
        .map((r: any) => {
          const id = Number(r?.id);
          const rawName = r?.name != null ? String(r.name).trim() : "";
          const name = rawName || officeFallbackNames[id] || "";
          return { id, name };
        })
        .filter((op: { id: number }) => Number.isFinite(op.id));

      if (forOffice) {
        const byId = new Map(active_operations.map((op: { id: number; name: string }) => [op.id, op]));
        for (const id of [15, 38]) {
          if (!byId.has(id)) {
            active_operations.push({ id, name: officeFallbackNames[id] });
          }
        }
        active_operations.sort((a: { id: number }, b: { id: number }) => a.id - b.id);
      }
      res.json({
        active_operations,
        total_operations: active_operations.length,
      });
    } catch (error: any) {
      console.error("Errore GET /api/operations:", error?.message);
      res.status(500).json({ success: false, error: error?.message || "Server error" });
    } finally {
      if (connection) {
        try {
          await connection.end();
        } catch {
          // ignore
        }
      }
    }
  });

  // GET /api/cleaners-aliases - Carica alias cleaners da aliases (permanente)
  app.get("/api/cleaners-aliases", async (req, res) => {
    try {
      const dateParam = req.query.date as string;
      const workDate = dateParam || format(new Date(), "yyyy-MM-dd");

      console.log(`📖 GET /api/cleaners-aliases - Caricamento alias permanenti`);

      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      
      // Load from permanent aliases table (date-independent)
      const aliasMap = await pgDailyAssignmentsService.getAllCleanerAliases();

      // Convert Map to object format for API response
      const aliases: Record<string, { id: number; name: string; lastname: string; alias: string }> = {};
      
      aliasMap.forEach((data, cleanerId) => {
        aliases[cleanerId.toString()] = {
          id: cleanerId,
          name: data.name || '',
          lastname: data.lastname || '',
          alias: data.alias
        };
      });

      console.log(`✅ Alias caricati da aliases: ${Object.keys(aliases).length}`);
      res.json({
        aliases,
        metadata: { date: workDate, source: 'aliases', last_updated: getRomeTimestamp() }
      });
    } catch (error: any) {
      console.error("Errore nel load degli alias:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  // POST /api/timeline - Salva timeline completa (per script Python)
  app.post("/api/timeline", async (req, res) => {
    try {
      const { date, timeline, scope } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      const resolvedScope = isOfficeScope(scope) ? "office" : "housekeeping";

      if (!timeline) {
        return res.status(400).json({ success: false, error: "timeline data required" });
      }

      console.log(`📝 POST /api/timeline - Salvando timeline per ${workDate}`);

      // Assicura che metadata abbia la data corretta
      const timelineData = {
        ...timeline,
        metadata: {
          ...timeline.metadata,
          date: workDate,
          last_updated: getRomeTimestamp()
        }
      };

      // Hydrate coords + recalculate times per ogni cleaner
      if (timelineData.cleaners_assignments && Array.isArray(timelineData.cleaners_assignments)) {
        for (let idx = 0; idx < timelineData.cleaners_assignments.length; idx++) {
          let entry = timelineData.cleaners_assignments[idx];
          const tasks = entry.tasks;

          if (!tasks || !Array.isArray(tasks) || tasks.length === 0) continue;

          // 1) Ordina per sequence (NON per start_time)
          tasks.sort((a: any, b: any) => (a.sequence ?? 9999) - (b.sequence ?? 9999));

          // 2) Normalizza sequence + followup
          for (let i = 0; i < tasks.length; i++) {
            tasks[i].sequence = i + 1;
            tasks[i].followup = i > 0;
          }

          // 3) Hydrate coords/address (fondamentale per travel_time realistico)
          entry = await hydrateTasksFromContainers(entry, workDate);

          // 4) Ricalcolo reale start/end/travel via Python
          entry = await recalculateCleanerTimes(entry, workDate);

          // 5) Salva back
          timelineData.cleaners_assignments[idx] = entry;
        }
        console.log(`   ✅ Sequence normalizzate per ${timelineData.cleaners_assignments.length} cleaners`);
      }

      // Salva via workspaceFiles (scrive su PostgreSQL + filesystem per compatibilità)
      await workspaceFiles.saveTimeline(
        workDate,
        timelineData,
        false,
        'python_script',
        'api_save_timeline',
        undefined,
        resolvedScope
      );

      const taskCount = timelineData.cleaners_assignments?.reduce(
        (sum: number, c: any) => sum + (c.tasks?.length || 0), 0
      ) || 0;

      console.log(`✅ Timeline salvata per ${workDate}: ${timelineData.cleaners_assignments?.length || 0} cleaners, ${taskCount} task`);
      res.json({ 
        success: true, 
        message: `Timeline salvata per ${workDate}`,
        cleaners_count: timelineData.cleaners_assignments?.length || 0,
        tasks_count: taskCount
      });
    } catch (error: any) {
      console.error("Errore nel salvataggio timeline:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  // POST /api/containers - Salva containers completi (per script Python)
  app.post("/api/containers", async (req, res) => {
    try {
      const { date, containers, scope } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      const resolvedScope = isOfficeScope(scope) ? "office" : "housekeeping";

      if (!containers) {
        return res.status(400).json({ success: false, error: "containers data required" });
      }

      console.log(`📝 POST /api/containers - Salvando containers per ${workDate}`);

      // Normalizza struttura containers
      const containersData = containers.containers ? containers : { containers };
      
      // Aggiungi metadata se mancante
      if (!containersData.metadata) {
        containersData.metadata = { date: workDate, last_updated: getRomeTimestamp() };
      }
      containersData.metadata.date = workDate;
      containersData.metadata.last_updated = getRomeTimestamp();

      // Calcola summary
      const eoTasks = containersData.containers?.early_out?.tasks || [];
      const hpTasks = containersData.containers?.high_priority?.tasks || [];
      const lpTasks = containersData.containers?.low_priority?.tasks || [];

      containersData.summary = {
        early_out: eoTasks.length,
        high_priority: hpTasks.length,
        low_priority: lpTasks.length,
        total_tasks: eoTasks.length + hpTasks.length + lpTasks.length
      };

      // Salva via workspaceFiles (scrive su PostgreSQL + filesystem per compatibilità)
      await workspaceFiles.saveContainers(workDate, containersData, 'system', 'manual', resolvedScope);

      console.log(`✅ Containers salvati per ${workDate}: EO=${eoTasks.length}, HP=${hpTasks.length}, LP=${lpTasks.length}`);
      res.json({ 
        success: true, 
        message: `Containers salvati per ${workDate}`,
        summary: containersData.summary
      });
    } catch (error: any) {
      console.error("Errore nel salvataggio containers:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  // POST /api/containers/refresh - Force refresh containers da ADAM
  app.post("/api/containers/refresh", async (req, res) => {
    try {
      const { date, modified_by, scope } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      const currentUsername = modified_by || getCurrentUsername(req);
      const officeScope = isOfficeScope(scope);

      console.log(`🔄 Force refresh containers da ADAM per ${workDate}...`);

      const { refreshContainersFromAdam } = await import("./services/containers-refresh-service");
      const refreshResult = await refreshContainersFromAdam(
        workDate,
        currentUsername,
        officeScope ? "office" : "housekeeping"
      );

      if (!refreshResult.success) {
        return res.status(500).json({
          success: false,
          error: refreshResult.error || "Errore nel refresh containers"
        });
      }

      console.log(`✅ Containers refreshati da ADAM: rimossi ${refreshResult.removedCount} duplicati già assegnati`);
      res.json({
        success: true,
        message: `Containers rigenerati da ADAM per ${workDate}`,
        removedDuplicates: refreshResult.removedCount
      });
    } catch (error: any) {
      console.error("Errore nel refresh containers:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  // --- WASS Logistics containers (daily_logistics_*, enable_route_drivers ADAM) ---
  app.get("/api/logistics-containers", async (req, res) => {
    try {
      const dateParam = (req.query.date as string) || format(new Date(), "yyyy-MM-dd");
      const workDate = dateParam;
      console.log(`📖 GET /api/logistics-containers - ${workDate}`);
      const containers = await workspaceFiles.loadLogisticsContainers(workDate);
      if (!containers) {
        return res.json({
          containers: {
            early_out: { tasks: [], count: 0 },
            high_priority: { tasks: [], count: 0 },
            low_priority: { tasks: [], count: 0 },
          },
          summary: {
            early_out: 0,
            high_priority: 0,
            low_priority: 0,
            total_tasks: 0,
          },
          metadata: { date: workDate },
        });
      }
      res.json({
        ...containers,
        metadata: { ...(containers as any).metadata, date: workDate },
      });
    } catch (error: any) {
      console.error("Errore GET logistics-containers:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/logistics-containers", async (req, res) => {
    try {
      const { date, containers } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      if (!containers) {
        return res.status(400).json({ success: false, error: "containers data required" });
      }
      const containersData = containers.containers ? containers : { containers };
      if (!containersData.metadata) {
        containersData.metadata = { date: workDate, last_updated: getRomeTimestamp() };
      }
      containersData.metadata.date = workDate;
      containersData.metadata.last_updated = getRomeTimestamp();
      const eoTasks = containersData.containers?.early_out?.tasks || [];
      const hpTasks = containersData.containers?.high_priority?.tasks || [];
      const lpTasks = containersData.containers?.low_priority?.tasks || [];
      containersData.summary = {
        early_out: eoTasks.length,
        high_priority: hpTasks.length,
        low_priority: lpTasks.length,
        total_tasks: eoTasks.length + hpTasks.length + lpTasks.length,
      };
      await workspaceFiles.saveLogisticsContainers(workDate, containersData);
      res.json({
        success: true,
        message: `Logistics containers salvati per ${workDate}`,
        summary: containersData.summary,
      });
    } catch (error: any) {
      console.error("Errore POST logistics-containers:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/logistics-containers/refresh", async (req, res) => {
    try {
      const { date, modified_by } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      const currentUsername = modified_by || getCurrentUsername(req);
      const { refreshLogisticsContainersFromAdam } = await import("./services/containers-refresh-service");
      const refreshResult = await refreshLogisticsContainersFromAdam(workDate, currentUsername);
      if (!refreshResult.success) {
        return res.status(500).json({
          success: false,
          error: refreshResult.error || "Errore refresh logistics containers",
        });
      }
      res.json({
        success: true,
        message: `Logistics containers rigenerati da ADAM per ${workDate}`,
        removedDuplicates: refreshResult.removedCount,
      });
    } catch (error: any) {
      console.error("Errore refresh logistics-containers:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/logistics-timeline", async (req, res) => {
    try {
      const workDate = (req.query.date as string) || format(new Date(), "yyyy-MM-dd");
      const timeline = await workspaceFiles.loadLogisticsTimeline(workDate);
      if (!timeline) {
        return res.json({
          metadata: { date: workDate },
          drivers_assignments: [],
          meta: { total_drivers: 0, used_drivers: 0, assigned_tasks: 0 },
        });
      }
      res.json(timeline);
    } catch (error: any) {
      console.error("GET /api/logistics-timeline:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/logistics-timeline", async (req, res) => {
    try {
      const { date, timeline } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      if (!timeline) {
        return res.status(400).json({ success: false, error: "timeline required" });
      }
      const timelineData = {
        ...timeline,
        metadata: { ...timeline.metadata, date: workDate, last_updated: getRomeTimestamp() },
      };
      if (timelineData.drivers_assignments && Array.isArray(timelineData.drivers_assignments)) {
        for (let idx = 0; idx < timelineData.drivers_assignments.length; idx++) {
          let entry = timelineData.drivers_assignments[idx];
          const tasks = entry.tasks;
          if (!tasks?.length) continue;
          tasks.sort((a: any, b: any) => (a.sequence ?? 9999) - (b.sequence ?? 9999));
          for (let i = 0; i < tasks.length; i++) {
            tasks[i].sequence = i + 1;
            tasks[i].followup = i > 0;
          }
          await hydrateTasksFromLogisticsContainers(entry, workDate);
          entry = await recalculateLogisticsDriverTimes(entry, workDate);
          timelineData.drivers_assignments[idx] = entry;
        }
      }
      await workspaceFiles.saveLogisticsTimeline(workDate, timelineData, false, "python_script", "api_save_logistics_timeline");
      const taskCount =
        timelineData.drivers_assignments?.reduce((s: number, d: any) => s + (d.tasks?.length || 0), 0) || 0;
      res.json({
        success: true,
        drivers_count: timelineData.drivers_assignments?.length || 0,
        tasks_count: taskCount,
      });
    } catch (error: any) {
      console.error("POST /api/logistics-timeline:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Resolve housekeeping cleaner for a logistics task (daily_assignments_current + aliases)
  app.get("/api/logistics-task-housekeeping-cleaner", async (req, res) => {
    try {
      const workDate = (req.query.date as string) || format(new Date(), "yyyy-MM-dd");
      const taskIdRaw = req.query.taskId as string | undefined;
      const logisticCodeRaw = req.query.logisticCode as string | undefined;
      const normalizedTaskId = String(taskIdRaw ?? "").trim();
      const normalizedLogisticCode = String(logisticCodeRaw ?? "").trim();
      const matchCandidates = Array.from(
        new Set([normalizedTaskId, normalizedLogisticCode].filter((v) => v.length > 0))
      );
      if (matchCandidates.length === 0) {
        return res.status(400).json({ success: false, error: "taskId or logisticCode required" });
      }

      const { query } = await import("../shared/pg-db");
      const [housekeepingResult, logisticsResult] = await Promise.all([
        query(
          `
            SELECT
              dac.cleaner_id,
              dac.cleaner_name,
              dac.cleaner_lastname,
              dac.sequence,
              dac.start_time::text AS start_time,
              dac.end_time::text AS end_time,
              dac.travel_time,
              a.alias,
              COALESCE(
                NULLIF(TRIM(a.alias), ''),
                NULLIF(TRIM(CONCAT(COALESCE(dac.cleaner_name, ''), ' ', COALESCE(dac.cleaner_lastname, ''))), ''),
                'Cleaner ' || dac.cleaner_id::text
              ) AS cleaner_label
            FROM daily_assignments_current dac
            LEFT JOIN aliases a ON a.cleaner_id = dac.cleaner_id
            WHERE dac.work_date = $1
              AND (dac.scope = 'housekeeping' OR dac.scope IS NULL)
              AND (dac.task_id::text = ANY($2::text[]) OR dac.logistic_code::text = ANY($2::text[]))
            ORDER BY
              EXISTS (
                SELECT 1 FROM task_collaborators tc
                WHERE tc.work_date = dac.work_date
                  AND tc.task_id = dac.task_id
                  AND tc.cleaner_id = dac.cleaner_id
                  AND tc.is_primary IS TRUE
              ) DESC,
              dac.sequence ASC NULLS LAST,
              dac.id ASC
            LIMIT 1
          `,
          [workDate, matchCandidates]
        ),
        query(
          `
            SELECT lt.sequence
            FROM lg_timeline lt
            WHERE lt.work_date = $1
              AND (lt.task_id::text = ANY($2::text[]) OR lt.logistic_code::text = ANY($2::text[]))
            ORDER BY lt.sequence ASC, lt.id ASC
            LIMIT 1
          `,
          [workDate, matchCandidates]
        ),
      ]);

      const hkRow = housekeepingResult.rows?.[0];
      const lgRow = logisticsResult.rows?.[0];

      if (!hkRow && !lgRow) {
        return res.json({ success: true, found: false });
      }

      res.json({
        success: true,
        found: true,
        cleanerId: hkRow?.cleaner_id ?? null,
        alias: hkRow?.alias || null,
        cleanerName: hkRow?.cleaner_name || null,
        cleanerLastname: hkRow?.cleaner_lastname || null,
        sequence: hkRow?.sequence ?? null,
        startTime: hkRow?.start_time ?? null,
        endTime: hkRow?.end_time ?? null,
        travelTime: hkRow?.travel_time ?? null,
        logisticsSequence: lgRow?.sequence ?? null,
        cleanerLabel: hkRow?.cleaner_label || null,
      });
    } catch (error: any) {
      console.error("GET /api/logistics-task-housekeeping-cleaner:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Lightweight endpoint: logistics driver badge + logistics sequence for current task
  app.get("/api/logistics-task-driver-details", async (req, res) => {
    try {
      const workDate = (req.query.date as string) || format(new Date(), "yyyy-MM-dd");
      const taskIdRaw = req.query.taskId as string;
      const preferredDriverIdRaw = req.query.driverId as string | undefined;
      const structureIdRaw = req.query.structureId as string | undefined;
      const taskId = Number(taskIdRaw);
      const preferredDriverId =
        preferredDriverIdRaw != null && preferredDriverIdRaw !== ""
          ? Number(preferredDriverIdRaw)
          : null;

      if (!Number.isFinite(taskId)) {
        return res.status(400).json({ success: false, error: "taskId must be numeric" });
      }

      const { query } = await import("../shared/pg-db");
      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      const sanitizeHousekeepingNotes = (value: unknown): string =>
        String(value ?? "")
          .replace(/<\s*\/?\s*br\s*\/?\s*>/gi, "\n")
          .replace(/<[^>]*>/g, " ")
          .replace(/\r\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .replace(/[ \t]{2,}/g, " ")
          .trim();
      const toNullableInt = (value: unknown): number | null => {
        if (value === null || value === undefined || value === "") return null;
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      };

      const result = await query(
        `
          SELECT
            lt.driver_id,
            lt.sequence,
            lt.id,
            lt.task_id,
            lt.logistic_code,
            d.name AS driver_name,
            d.lastname AS driver_lastname,
            a.alias AS driver_alias
          FROM lg_timeline lt
          LEFT JOIN lg_drivers d
            ON d.work_date = lt.work_date
           AND d.driver_id = lt.driver_id
          LEFT JOIN aliases a
            ON a.cleaner_id = lt.driver_id
          WHERE lt.work_date = $1
            AND (lt.task_id = $2 OR lt.logistic_code = $2)
          ORDER BY
            CASE WHEN $3::int IS NOT NULL AND lt.driver_id = $3::int THEN 0 ELSE 1 END,
            lt.sequence ASC,
            lt.id ASC
          LIMIT 1
        `,
        [workDate, taskId, Number.isFinite(preferredDriverId as number) ? preferredDriverId : null]
      );

      const row = result.rows?.[0];
      let housekeepingNotes: string | null = null;
      let structureBeds: {
        single_beds: number | null;
        double_beds: number | null;
        single_sofabeds: number | null;
        double_sofabeds: number | null;
      } | null = null;
      let structureAlertKeys: number | null = null;

      const noteLookupCandidates = [
        Number(row?.task_id),
        taskId,
      ].filter((id, idx, arr) => Number.isFinite(id) && arr.indexOf(id) === idx);

      const structureLookupCandidates: number[] = [];
      const pushStructureCandidate = (value: unknown) => {
        const num = Number(value);
        if (!Number.isFinite(num)) return;
        if (!structureLookupCandidates.includes(num)) {
          structureLookupCandidates.push(num);
        }
      };
      const logisticCodeLookupCandidates: number[] = [];
      const pushLogisticCodeCandidate = (value: unknown) => {
        const num = Number(value);
        if (!Number.isFinite(num)) return;
        if (!logisticCodeLookupCandidates.includes(num)) {
          logisticCodeLookupCandidates.push(num);
        }
      };
      // Priorita': structure_id esplicito dal client (app_structures.id).
      pushStructureCandidate(structureIdRaw);
      // Fallback robusto: logistic_code del record timeline.
      pushLogisticCodeCandidate(row?.logistic_code);

      if (noteLookupCandidates.length > 0 || structureLookupCandidates.length > 0) {
        try {
          const adamConnection = await mysql.createConnection({
            host: databaseConfig.mysql.host,
            port: databaseConfig.mysql.port,
            user: databaseConfig.mysql.user,
            password: databaseConfig.mysql.password,
            database: databaseConfig.mysql.database,
          });
          try {
            for (const noteTaskId of noteLookupCandidates) {
              const [rows]: any = await adamConnection.execute(
                `
                  SELECT
                    h.notes,
                    h.structure_id
                  FROM app_housekeeping h
                  WHERE h.id = ?
                  LIMIT 1
                `,
                [noteTaskId]
              );
              const rowRaw = rows?.[0] ?? null;
              if (!rowRaw) continue;
              const noteRaw = rowRaw.notes;
              const noteText = sanitizeHousekeepingNotes(noteRaw);
              pushStructureCandidate(rowRaw.structure_id);
              if (noteText) {
                housekeepingNotes = noteText;
              }
              break;
            }

            for (const structureId of structureLookupCandidates) {
              const [rows]: any = await adamConnection.execute(
                `
                  SELECT
                    single_beds,
                    double_beds,
                    single_sofabeds,
                    double_sofabeds,
                    alert_keys
                  FROM app_structures
                  WHERE id = ?
                  LIMIT 1
                `,
                [structureId]
              );
              const structureRaw = rows?.[0] ?? null;
              if (!structureRaw) continue;
              structureBeds = {
                single_beds: toNullableInt(structureRaw.single_beds),
                double_beds: toNullableInt(structureRaw.double_beds),
                single_sofabeds: toNullableInt(structureRaw.single_sofabeds),
                double_sofabeds: toNullableInt(structureRaw.double_sofabeds),
              };
              structureAlertKeys = toNullableInt(structureRaw.alert_keys);
              break;
            }

            // Fallback: se non troviamo per id, prova con app_structures.logistic_code.
            if (!structureBeds) {
              for (const logisticCode of logisticCodeLookupCandidates) {
                const [rows]: any = await adamConnection.execute(
                  `
                    SELECT
                      single_beds,
                      double_beds,
                      single_sofabeds,
                      double_sofabeds,
                      alert_keys
                    FROM app_structures
                    WHERE logistic_code = ?
                    LIMIT 1
                  `,
                  [logisticCode]
                );
                const structureRaw = rows?.[0] ?? null;
                if (!structureRaw) continue;
                structureBeds = {
                  single_beds: toNullableInt(structureRaw.single_beds),
                  double_beds: toNullableInt(structureRaw.double_beds),
                  single_sofabeds: toNullableInt(structureRaw.single_sofabeds),
                  double_sofabeds: toNullableInt(structureRaw.double_sofabeds),
                };
                structureAlertKeys = toNullableInt(structureRaw.alert_keys);
                break;
              }
            }
          } finally {
            await adamConnection.end();
          }
        } catch (noteError: any) {
          console.warn(
            "GET /api/logistics-task-driver-details: unable to read app_housekeeping.notes:",
            noteError?.message || noteError
          );
        }
      }

      if (!row) {
        return res.json({ success: true, found: false, housekeepingNotes, structureBeds, structureAlertKeys });
      }

      const driverId = Number(row.driver_id);
      const assignments = await pgDailyAssignmentsService.loadSelectedLogisticsDriverVehicleAssignments(
        workDate
      );
      const assignment = assignments?.[String(driverId)] || null;
      const vehicleName = String(assignment?.vehicle_name ?? "").trim() || "Veicolo N/D";
      const fullName = `${row.driver_name ?? ""} ${row.driver_lastname ?? ""}`.trim();
      const alias = String(row.driver_alias ?? "").trim();
      const driverLabel = alias || fullName || `Driver ${driverId}`;

      res.json({
        success: true,
        found: true,
        driverId,
        driverBadge: `${driverLabel} - ${vehicleName}`,
        sequence: row.sequence ?? null,
        housekeepingNotes,
        structureBeds,
        structureAlertKeys,
      });
    } catch (error: any) {
      console.error("GET /api/logistics-task-driver-details:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/selected-logistics-drivers", async (req, res) => {
    try {
      const workDate = (req.query.date as string) || format(new Date(), "yyyy-MM-dd");
      const { enrichLogisticsDriversFromAdam } = await import("./services/adam-logistics-drivers-enrichment");
      const data = await workspaceFiles.loadSelectedLogisticsDrivers(workDate);
      const payload = data || { drivers: [], total_selected: 0, metadata: { date: workDate } };
      const list = payload.drivers || [];
      if (list.length > 0) {
        payload.drivers = await enrichLogisticsDriversFromAdam(workDate, list);
        payload.total_selected = payload.drivers.length;
      }
      res.json(payload);
    } catch (error: any) {
      console.error("GET /api/selected-logistics-drivers:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /** Roster autisti per data (lg_drivers), estratti da ADAM user_role_id = 9 */
  app.get("/api/logistics-drivers", async (req, res) => {
    try {
      const workDate = (req.query.date as string) || format(new Date(), "yyyy-MM-dd");
      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      const { enrichLogisticsDriversFromAdam } = await import("./services/adam-logistics-drivers-enrichment");
      let drivers = await pgDailyAssignmentsService.loadLgDriversForDate(workDate);
      if (!drivers || drivers.length === 0) {
        return res.json({
          drivers: [],
          total: 0,
          metadata: { date: workDate, source: "postgresql" },
        });
      }
      drivers = await enrichLogisticsDriversFromAdam(workDate, drivers);
      res.json({
        drivers,
        total: drivers.length,
        metadata: { date: workDate, source: "postgresql" },
      });
    } catch (error: any) {
      console.error("GET /api/logistics-drivers:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /** Catalogo veicoli ADAM (structure_kind_id = 6) — non più in lg_drivers. */
  app.get("/api/logistics-vehicles", async (req, res) => {
    let connection: any = null;
    try {
      const workDate = (req.query.date as string) || format(new Date(), "yyyy-MM-dd");
      const { loadLogisticsVehiclesCatalog } = await import("./services/adam-logistics-vehicle-service");
      connection = await mysql.createConnection({
        host: databaseConfig.mysql.host,
        port: databaseConfig.mysql.port,
        user: databaseConfig.mysql.user,
        password: databaseConfig.mysql.password,
        database: databaseConfig.mysql.database,
      });
      const vehicles = await loadLogisticsVehiclesCatalog(connection);
      res.json({
        vehicles,
        total: vehicles.length,
        metadata: { date: workDate, source: "adam_mysql" },
      });
    } catch (error: any) {
      console.error("GET /api/logistics-vehicles:", error);
      res.status(500).json({ success: false, error: error.message });
    } finally {
      if (connection) {
        try {
          await connection.end();
        } catch {
          /* ignore */
        }
      }
    }
  });

  app.post("/api/logistics-drivers", async (req, res) => {
    try {
      const { date, drivers, snapshotReason } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      if (!drivers || !Array.isArray(drivers)) {
        return res.status(400).json({ success: false, error: "drivers array required" });
      }
      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      const existing = await pgDailyAssignmentsService.loadLgDriversForDate(workDate);
      const existingStartTimes = new Map<number, string>();
      if (existing && existing.length > 0) {
        for (const d of existing) {
          if (d.id && d.start_time) {
            existingStartTimes.set(d.id, d.start_time);
          }
        }
      }
      const merged = drivers.map((d: any) => ({
        ...d,
        start_time: existingStartTimes.get(d.id) ?? d.start_time ?? "10:00",
      }));
      const ok = await pgDailyAssignmentsService.saveLgDriversForDate(
        workDate,
        merged,
        snapshotReason || "api_update"
      );
      if (ok) {
        res.json({ success: true, message: `${drivers.length} drivers salvati per ${workDate}` });
      } else {
        res.status(500).json({ success: false, error: "Errore nel salvataggio lg_drivers" });
      }
    } catch (error: any) {
      console.error("POST /api/logistics-drivers:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/save-selected-logistics-drivers", async (req, res) => {
    try {
      const { drivers: selectedDrivers, date, action_type = "replace" } = req.body;
      if (!selectedDrivers || !Array.isArray(selectedDrivers)) {
        return res.status(400).json({ success: false, message: "drivers array required" });
      }
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      const currentUsername = req.body.modified_by || req.body.created_by || getCurrentUsername(req);
      const driverIds = selectedDrivers.map((d: any) => (typeof d === "number" ? d : d.id));
      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      const {
        normalizeVehicleStructureId,
        resolveVehicleStructureIdsToTaskIds,
      } = await import("./services/adam-logistics-vehicle-service");
      const fullRows = await pgDailyAssignmentsService.loadLgDriversByIds(driverIds, workDate);
      const rowById = new Map<number, any>(fullRows.map((r: any) => [Number(r.id), r]));
      const baseEnriched = selectedDrivers.map((d: any) => {
        const id = typeof d === "number" ? d : d.id;
        const row = rowById.get(id);
        const st =
          typeof d === "object" && d && d.start_time != null
            ? d.start_time
            : row?.start_time || "10:00";
        const rawVid =
          typeof d === "object" && d && d.assigned_vehicle_id != null && d.assigned_vehicle_id !== ""
            ? Number(d.assigned_vehicle_id)
            : null;
        const structureId = normalizeVehicleStructureId(rawVid);
        if (row) {
          return {
            id,
            name: row.name || "Driver",
            lastname: row.lastname ?? String(id),
            role: row.role || "Driver",
            premium: row.role === "Premium",
            start_time: st,
            assigned_vehicle_id: structureId,
            assigned_vehicle_name:
              typeof d === "object" && d ? d.assigned_vehicle_name ?? null : null,
            assigned_vehicle_pms_code:
              typeof d === "object" && d ? d.assigned_vehicle_pms_code ?? null : null,
          };
        }
        return typeof d === "number"
          ? {
              id: d,
              name: "Driver",
              lastname: String(d),
              role: "Driver",
              premium: false,
              start_time: st,
              assigned_vehicle_id: structureId,
              assigned_vehicle_name: null,
              assigned_vehicle_pms_code: null,
            }
          : {
              id: d.id,
              name: d.name || "Driver",
              lastname: d.lastname ?? String(d.id),
              role: d.role || "Driver",
              premium: Boolean(d.premium),
              start_time: st,
              assigned_vehicle_id: structureId,
              assigned_vehicle_name: d.assigned_vehicle_name ?? null,
              assigned_vehicle_pms_code: d.assigned_vehicle_pms_code ?? null,
            };
      });

      const toResolve = [
        ...new Set(
          baseEnriched
            .map((e: any) => e.assigned_vehicle_id)
            .filter((sid: any) => sid != null && Number.isFinite(Number(sid)))
        ),
      ] as number[];

      let vehicleWarnings: string[] = [];
      let taskMap = new Map<number, number>();
      if (toResolve.length > 0) {
        let conn: any = null;
        try {
          conn = await mysql.createConnection({
            host: databaseConfig.mysql.host,
            port: databaseConfig.mysql.port,
            user: databaseConfig.mysql.user,
            password: databaseConfig.mysql.password,
            database: databaseConfig.mysql.database,
          });
          const r = await resolveVehicleStructureIdsToTaskIds(conn, workDate, toResolve);
          taskMap = r.map;
          vehicleWarnings = r.warnings;
        } catch (dbErr: any) {
          vehicleWarnings.push(
            `MySQL veicoli: ${dbErr?.message || dbErr} — vehicle_task_id non risolto`
          );
        } finally {
          if (conn) {
            try {
              await conn.end();
            } catch {
              /* ignore */
            }
          }
        }
      }

      const enriched = baseEnriched.map((e: any) => ({
        ...e,
        assigned_vehicle_task_id:
          e.assigned_vehicle_id != null ? taskMap.get(Number(e.assigned_vehicle_id)) ?? null : null,
      }));

      const ok = await workspaceFiles.saveSelectedLogisticsDrivers(
        workDate,
        { drivers: enriched, total_selected: enriched.length, metadata: { date: workDate } },
        false,
        currentUsername,
        action_type
      );
      if (!ok) {
        return res.status(500).json({ success: false, error: "save failed" });
      }
      res.json({
        success: true,
        count: driverIds.length,
        vehicle_warnings: vehicleWarnings,
      });
    } catch (error: any) {
      console.error("POST /api/save-selected-logistics-drivers:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Sync ADAM SOLO driver-veicolo (senza timeline): aggiorna cleaned_by_us sui task veicolo del giorno.
   * Da usare dalla pagina convocazioni subito dopo il save PG.
   */
  app.post("/api/sync-logistics-driver-vehicles-to-adam", async (req, res) => {
    let connection: any = null;
    try {
      const { date, username: reqUsername } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      const username = reqUsername || getCurrentUsername(req);

      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      const vehicleAssignments =
        await pgDailyAssignmentsService.loadSelectedLogisticsDriverVehicleAssignments(workDate);

      const hasVehicleBindings = Object.values(vehicleAssignments || {}).some((a: any) => {
        const v = a?.vehicle_id;
        return v != null && v !== "" && Number.isFinite(Number(v));
      });
      if (!hasVehicleBindings) {
        return res.json({
          success: false,
          message: "Nessuna associazione driver-veicolo da sincronizzare",
        });
      }

      const {
        normalizeVehicleStructureId,
        resolveVehicleStructureIdsToTaskIds,
        listVehicleHousekeepingTaskIdsForDate,
      } = await import("./services/adam-logistics-vehicle-service");

      const taskToDriver = new Map<number, number>();
      const pendingStructureResolve: { structureId: number; driverId: number }[] = [];

      for (const [driverIdStr, a] of Object.entries(vehicleAssignments || {})) {
        const driverId = Number(driverIdStr);
        if (!Number.isFinite(driverId) || !a || typeof a !== "object") continue;
        const sid = normalizeVehicleStructureId(
          a.vehicle_id != null ? Number(a.vehicle_id) : null
        );
        if (!sid) continue;

        const tid: number | null =
          a.vehicle_task_id != null && Number.isFinite(Number(a.vehicle_task_id))
            ? Number(a.vehicle_task_id)
            : null;
        if (tid != null) {
          taskToDriver.set(tid, driverId);
        } else {
          pendingStructureResolve.push({ structureId: sid, driverId });
        }
      }

      connection = await mysql.createConnection({
        host: databaseConfig.mysql.host,
        port: databaseConfig.mysql.port,
        user: databaseConfig.mysql.user,
        password: databaseConfig.mysql.password,
        database: databaseConfig.mysql.database,
      });

      if (pendingStructureResolve.length > 0) {
        const uniqueSids = [...new Set(pendingStructureResolve.map((p) => p.structureId))];
        const { map, warnings } = await resolveVehicleStructureIdsToTaskIds(
          connection,
          workDate,
          uniqueSids
        );
        for (const { structureId, driverId } of pendingStructureResolve) {
          const tid = map.get(structureId);
          if (tid != null) taskToDriver.set(tid, driverId);
        }
        if (warnings.length) {
          console.warn("sync-logistics-driver-vehicles-to-adam warnings:", warnings);
        }
      }

      const { pgUsersService } = await import("./services/pg-users-service");
      const userRecord = await pgUsersService.getUserByUsername(username);
      const adamUpdatedBy = userRecord?.adam_id ? `E${userRecord.adam_id}` : username;

      const allVehicleTaskIds = await listVehicleHousekeepingTaskIdsForDate(connection, workDate);
      const nowRome = format(new Date(), "yyyy-MM-dd HH:mm:ss");
      let updated = 0;
      let errors = 0;
      for (const taskId of allVehicleTaskIds) {
        const cleanedBy = taskToDriver.get(taskId) ?? null;
        const assignedAtUs = cleanedBy != null ? nowRome : null;
        const assignedAtMilliseconds = cleanedBy != null ? Date.now() : null;
        try {
          await connection.execute(
            `UPDATE app_housekeeping
             SET
               cleaned_by_us = ?,
               sequence = NULL,
               updated_by = ?,
               updated_at = ?,
               assigned_at_us = ?,
               assigned_at_milliseconds = ?,
               collaboration = 0,
               collaboration_by = NULL,
               collaboration_at = NULL,
               collaboration_bypass = 0,
               helpwork = 0,
               helpwork_by = 0,
               helpwork_at = NULL,
               startwork = 0,
               startwork_at = NULL,
               startreport = 0,
               startreport_at = NULL,
               extratimes = ''
             WHERE id = ?`,
            [
              cleanedBy,
              adamUpdatedBy,
              nowRome,
              assignedAtUs,
              assignedAtMilliseconds,
              taskId,
            ]
          );
          updated++;
        } catch (e) {
          errors++;
          console.error(`sync-logistics-driver-vehicles-to-adam task ${taskId}:`, e);
        }
      }

      res.json({
        success: true,
        message: `Sync driver-veicolo completata su ${allVehicleTaskIds.length} task veicolo`,
        vehicle_task_count: allVehicleTaskIds.length,
        adam_updates_attempted: updated,
        adam_update_errors: errors,
        synced_by: username,
      });
    } catch (error: any) {
      console.error("POST /api/sync-logistics-driver-vehicles-to-adam:", error);
      res.status(500).json({ success: false, message: error.message });
    } finally {
      if (connection) {
        try {
          await connection.end();
        } catch {
          /* ignore */
        }
      }
    }
  });

  app.post("/api/remove-driver-from-selected", async (req, res) => {
    try {
      const { driverId, date } = req.body;
      if (driverId == null) {
        return res.status(400).json({ success: false, message: "driverId mancante" });
      }
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      const currentUsername = req.body.modified_by || getCurrentUsername(req);

      let selectedData: any = await workspaceFiles.loadSelectedLogisticsDrivers(workDate);
      if (!selectedData) {
        selectedData = { drivers: [], total_selected: 0 };
      }

      let timelineData: any = null;
      let hasTasks = false;
      try {
        timelineData = await workspaceFiles.loadLogisticsTimeline(workDate);
        const driverEntry = timelineData?.drivers_assignments?.find(
          (c: any) => c.driver?.id === Number(driverId)
        );
        hasTasks = Boolean(driverEntry?.tasks?.length);
      } catch {
        hasTasks = false;
      }

      const idNum = Number(driverId);
      const driversBefore = (selectedData.drivers || []).length;
      selectedData.drivers = (selectedData.drivers || []).filter((d: any) => Number(d.id) !== idNum);
      selectedData.total_selected = selectedData.drivers.length;
      selectedData.metadata = selectedData.metadata || {};
      selectedData.metadata.date = workDate;

      const ok = await workspaceFiles.saveSelectedLogisticsDrivers(
        workDate,
        {
          drivers: selectedData.drivers,
          total_selected: selectedData.total_selected,
          metadata: selectedData.metadata,
          actionPayload: { removed_driver_id: idNum },
        },
        false,
        currentUsername,
        "removal"
      );
      if (!ok) {
        return res.status(500).json({ success: false, error: "Salvataggio selezione fallito" });
      }

      let message = "";
      if (!hasTasks && timelineData?.drivers_assignments) {
        timelineData.drivers_assignments = timelineData.drivers_assignments.filter(
          (c: any) => c.driver?.id !== idNum
        );
        timelineData.metadata = timelineData.metadata || {};
        timelineData.metadata.last_updated = getRomeTimestamp();
        timelineData.metadata.date = workDate;
        timelineData.meta = timelineData.meta || {};
        const das = timelineData.drivers_assignments;
        timelineData.meta.total_drivers = das.length;
        timelineData.meta.used_drivers = das.filter((d: any) => (d.tasks?.length || 0) > 0).length;
        timelineData.meta.assigned_tasks = das.reduce(
          (sum: number, d: any) => sum + (d.tasks?.length || 0),
          0
        );
        await workspaceFiles.saveLogisticsTimeline(
          workDate,
          timelineData,
          false,
          currentUsername,
          "driver_removed_from_selection"
        );
        message = "Driver rimosso completamente (nessuna task)";
      } else {
        message = "Driver rimosso dalla selezione (task mantenute)";
      }

      res.json({
        success: true,
        message,
        removedFromTimeline: !hasTasks,
      });
    } catch (error: any) {
      console.error("remove-driver-from-selected:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/update-logistics-driver-field", async (req, res) => {
    try {
      const { driverId, date, field, value, modified_by } = req.body;
      if (driverId == null || !field || !date) {
        return res.status(400).json({
          success: false,
          message: "driverId, field e date sono richiesti",
        });
      }
      const workDate = date;
      const currentUsername = modified_by || getCurrentUsername(req);
      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      const ok = await pgDailyAssignmentsService.updateLgDriverField(
        Number(driverId),
        workDate,
        String(field),
        value
      );
      if (!ok) {
        return res.status(400).json({ success: false, message: "Campo non valido o aggiornamento fallito" });
      }
      console.log(`✅ logistics driver ${driverId} ${field} aggiornato (${workDate}) da ${currentUsername}`);
      res.json({ success: true });
    } catch (error: any) {
      console.error("POST /api/update-logistics-driver-field:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post("/api/update-logistics-driver-start-time", async (req, res) => {
    try {
      const { driverId, startTime, date, modified_by } = req.body;
      if (driverId == null || !startTime || !date) {
        return res.status(400).json({
          success: false,
          message: "driverId, startTime e date sono richiesti",
        });
      }
      const workDate = date;
      const currentUsername = modified_by || getCurrentUsername(req);
      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");

      const selectedResult = await workspaceFiles.loadSelectedLogisticsDrivers(workDate);
      let ids: number[] = selectedResult?.drivers?.map((d: any) => d.id) ?? [];
      if (!ids.includes(Number(driverId))) {
        const rows = await pgDailyAssignmentsService.loadLgDriversByIds([Number(driverId)], workDate);
        if (!rows.length) {
          return res.status(404).json({
            success: false,
            message: "Driver non trovato in lg_drivers per questa data",
          });
        }
        ids = [...ids, Number(driverId)];
      }

      await pgDailyAssignmentsService.updateLgDriverField(Number(driverId), workDate, "start_time", startTime);

      await workspaceFiles.saveSelectedLogisticsDrivers(
        workDate,
        {
          drivers: ids.map((id) => ({ id })),
          total_selected: ids.length,
          metadata: { date: workDate },
        },
        true,
        currentUsername,
        "START_TIME"
      );

      try {
        const timelineData = await workspaceFiles.loadLogisticsTimeline(workDate);
        if (timelineData?.drivers_assignments) {
          const row = timelineData.drivers_assignments.find(
            (da: any) => da.driver?.id === Number(driverId)
          );
          if (row?.driver) {
            row.driver.start_time = startTime;
            timelineData.metadata = timelineData.metadata || {};
            timelineData.metadata.last_updated = getRomeTimestamp();
            timelineData.metadata.date = workDate;
            await workspaceFiles.saveLogisticsTimeline(workDate, timelineData, true);
          }
        }
      } catch {
        /* timeline assente */
      }

      res.json({ success: true, message: "Start time aggiornato" });
    } catch (error: any) {
      console.error("POST /api/update-logistics-driver-start-time:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post("/api/add-driver-to-timeline", async (req, res) => {
    try {
      const { driverId, date, modified_by, created_by } = req.body;
      if (driverId == null) {
        return res.status(400).json({ success: false, error: "driverId richiesto" });
      }
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      const currentUsername = modified_by || created_by || getCurrentUsername(req);
      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");

      const driversFromPg = await pgDailyAssignmentsService.loadLgDriversByIds([Number(driverId)], workDate);
      let driverData = driversFromPg.length > 0 ? driversFromPg[0] : null;
      if (!driverData) {
        return res.status(404).json({ success: false, error: "Driver non trovato" });
      }

      const selectedDriversData = await workspaceFiles.loadSelectedLogisticsDrivers(workDate);
      const existingFromSelected = selectedDriversData?.drivers?.find((d: any) => d.id === Number(driverId));
      if (existingFromSelected?.start_time) {
        driverData.start_time = existingFromSelected.start_time;
      }

      const selectedDriverIds = new Set(
        (selectedDriversData?.drivers || []).map((d: any) => d.id).filter((id: any) => id != null)
      );

      let timelineData: any = await workspaceFiles.loadLogisticsTimeline(workDate);
      if (!timelineData) {
        timelineData = {
          drivers_assignments: [],
          metadata: { date: workDate, last_updated: getRomeTimestamp() },
          meta: { total_drivers: 0, used_drivers: 0, assigned_tasks: 0 },
        };
      }
      timelineData.drivers_assignments = timelineData.drivers_assignments || [];

      const alreadyRow = timelineData.drivers_assignments.some(
        (da: any) => da.driver?.id === Number(driverId)
      );
      if (alreadyRow) {
        return res.status(400).json({
          success: false,
          error: "Il driver è già presente nella timeline",
        });
      }

      const driverToReplace = timelineData.drivers_assignments.find(
        (da: any) => !selectedDriverIds.has(da.driver?.id)
      );

      let replacedDriverId: number | null = null;
      const driverPayload = {
        id: driverData.id,
        name: driverData.name,
        lastname: driverData.lastname,
        role: driverData.role || "Driver",
        premium: driverData.role === "Premium",
        start_time: driverData.start_time || "10:00",
      };

      if (driverToReplace) {
        replacedDriverId = driverToReplace.driver?.id ?? null;
        const taskCount = driverToReplace.tasks?.length || 0;
        driverToReplace.driver = { ...driverPayload };
        if (taskCount > 0) {
          try {
            await hydrateTasksFromLogisticsContainers(driverToReplace, workDate);
            await recalculateLogisticsDriverTimes(driverToReplace, workDate);
          } catch (err) {
            console.warn("⚠️ Ricalcolo tempi logistics driver fallito:", err);
          }
        }
      } else {
        const insertIndex = (selectedDriversData?.drivers || []).findIndex(
          (d: any) => d.id === Number(driverId)
        );
        const newEntry = { driver: { ...driverPayload }, tasks: [] };
        if (insertIndex >= 0 && insertIndex < timelineData.drivers_assignments.length) {
          timelineData.drivers_assignments.splice(insertIndex, 0, newEntry);
        } else {
          timelineData.drivers_assignments.push(newEntry);
        }
      }

      timelineData.metadata = timelineData.metadata || {};
      timelineData.metadata.last_updated = getRomeTimestamp();
      timelineData.metadata.date = workDate;
      const totalTasks = timelineData.drivers_assignments.reduce(
        (sum: number, da: any) => sum + (da.tasks?.length || 0),
        0
      );
      timelineData.meta = timelineData.meta || {};
      timelineData.meta.total_drivers = timelineData.drivers_assignments.length;
      timelineData.meta.used_drivers = timelineData.drivers_assignments.filter(
        (da: any) => (da.tasks?.length || 0) > 0
      ).length;
      timelineData.meta.assigned_tasks = totalTasks;

      await workspaceFiles.saveLogisticsTimeline(
        workDate,
        timelineData,
        false,
        currentUsername,
        replacedDriverId ? "driver_replaced" : "driver_added_to_timeline"
      );

      let ids: number[] = (selectedDriversData?.drivers || []).map((d: any) => d.id);
      const did = Number(driverId);
      if (!ids.includes(did)) {
        ids.push(did);
      }

      await workspaceFiles.saveSelectedLogisticsDrivers(
        workDate,
        {
          drivers: ids.map((id) => ({ id })),
          total_selected: ids.length,
          metadata: { date: workDate },
        },
        false,
        currentUsername,
        replacedDriverId ? "DRIVER_REPLACED" : "DRIVER_ADDED"
      );

      res.json({
        success: true,
        replaced: replacedDriverId,
        message: replacedDriverId
          ? `Driver ${replacedDriverId} sostituito con ${driverId}`
          : `Driver ${driverId} aggiunto`,
      });
    } catch (error: any) {
      console.error("POST /api/add-driver-to-timeline:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /** Ultimo trasferimento / snapshot timeline logistica marcato come transfer_to_adam (revision PG). */
  app.get("/api/logistics-last-adam-transfer", async (req, res) => {
    try {
      const date = req.query.date as string;
      if (!date) {
        return res.status(400).json({ success: false, error: "date parameter required" });
      }
      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      const lastTransfer = await pgDailyAssignmentsService.getLastLogisticsTransferToAdamTimestamp(date);
      res.json({
        success: true,
        lastTransfer: lastTransfer ? lastTransfer.toISOString() : null,
      });
    } catch (error: any) {
      console.error("GET /api/logistics-last-adam-transfer:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Registra una revisione `transfer_to_adam` della timeline logistica su PG (senza sync ADAM).
   */
  app.post("/api/transfer-logistics-to-adam", async (req, res) => {
    try {
      const { date, username: reqUsername } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      const username = reqUsername || getCurrentUsername(req);

      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      const timelineData =
        (await workspaceFiles.loadLogisticsTimeline(workDate)) ?? {
          metadata: { date: workDate, last_updated: getRomeTimestamp() },
          drivers_assignments: [],
          meta: { total_drivers: 0, used_drivers: 0, assigned_tasks: 0 },
        };
      const hasAssignments = timelineData?.drivers_assignments?.some((da: any) =>
        Array.isArray(da.tasks) && da.tasks.length > 0
      );
      if (!hasAssignments) {
        return res.json({
          success: false,
          message: "Nessuna task assegnata nella timeline logistica",
        });
      }
      await pgDailyAssignmentsService.saveLogisticsTimelineToHistory(
        workDate,
        timelineData,
        username,
        "transfer_to_adam",
        [],
        [],
        []
      );

      res.json({
        success: true,
        message: "Trasferimento logistica registrato (revisione e snapshot su PostgreSQL).",
      });
    } catch (error: any) {
      console.error("POST /api/transfer-logistics-to-adam:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post("/api/reset-logistics-timeline-assignments", async (req, res) => {
    try {
      const { date, modified_by } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      const currentUsername = modified_by || getCurrentUsername(req);
      const emptyTimeline = {
        metadata: {
          last_updated: getRomeTimestamp(),
          date: workDate,
          created_by: currentUsername,
        },
        drivers_assignments: [],
        meta: { total_drivers: 0, used_drivers: 0, assigned_tasks: 0 },
      };
      const saved = await workspaceFiles.saveLogisticsTimeline(
        workDate,
        emptyTimeline,
        false,
        currentUsername,
        "timeline_reset"
      );
      if (!saved) {
        return res.status(500).json({ success: false, error: "reset timeline failed" });
      }
      const { refreshLogisticsContainersFromAdam } = await import("./services/containers-refresh-service");
      const refreshResult = await refreshLogisticsContainersFromAdam(workDate, currentUsername);
      res.json({
        success: true,
        message: "Logistics timeline reset e containers refresh",
        containersRefreshed: refreshResult.success,
      });
    } catch (error: any) {
      console.error("reset-logistics-timeline-assignments:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  registerLogisticsTimelineMutationRoutes(app, { getCurrentUsername, getRomeTimestamp });

  app.get("/api/logistics-optimizer/prerequisites", async (req, res) => {
    try {
      const workDate = (req.query.workDate as string) || format(new Date(), "yyyy-MM-dd");
      const { getLogisticsOptimizerPrerequisites } = await import(
        "./services/logistics-optimizer/runAllPhasesLogistics"
      );
      const pre = await getLogisticsOptimizerPrerequisites(workDate);
      res.json({ success: true, ...pre });
    } catch (error: any) {
      console.error("GET /api/logistics-optimizer/prerequisites:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/logistics-optimizer/run-all", async (req, res) => {
    try {
      const workDate = req.body?.date || req.body?.workDate || format(new Date(), "yyyy-MM-dd");
      const dryRun = Boolean(req.body?.dryRun);
      const modifiedBy = req.body?.modified_by || getCurrentUsername(req);
      const { runAllPhasesLogistics } = await import("./services/logistics-optimizer/runAllPhasesLogistics");
      const out = await runAllPhasesLogistics(workDate, { dryRun, modifiedBy });
      res.json({ success: out.status !== "failed", ...out });
    } catch (error: any) {
      console.error("POST /api/logistics-optimizer/run-all:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/logistics-optimizer/apply", async (req, res) => {
    try {
      const workDate = req.body?.date || req.body?.workDate || format(new Date(), "yyyy-MM-dd");
      const dryRun = Boolean(req.body?.dryRun);
      const modifiedBy = req.body?.modified_by || getCurrentUsername(req);
      const { runAllPhasesLogistics } = await import("./services/logistics-optimizer/runAllPhasesLogistics");
      const out = await runAllPhasesLogistics(workDate, { dryRun, modifiedBy });
      if (out.status === "failed" || !out.timelinePayload) {
        return res.status(400).json({
          success: false,
          error: out.error || "Pipeline failed or no timeline",
          ...out,
        });
      }
      const saved = await workspaceFiles.saveLogisticsTimeline(
        workDate,
        out.timelinePayload as any,
        false,
        modifiedBy,
        "logistics_optimizer_apply"
      );
      if (!saved) {
        return res.status(500).json({ success: false, error: "saveLogisticsTimeline failed", ...out });
      }
      res.json({ success: true, ...out, saved: true });
    } catch (error: any) {
      console.error("POST /api/logistics-optimizer/apply:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/selected-cleaners - Salva selected cleaners (per script Python)
  app.post("/api/selected-cleaners", async (req, res) => {
    try {
      const { date, cleaner_ids, cleaners, scope } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      const resolvedScope = isOfficeScope(scope) ? "office" : "housekeeping";

      // Supporta sia array di ID che array di oggetti cleaner
      let ids: number[] = [];
      if (cleaner_ids && Array.isArray(cleaner_ids)) {
        ids = cleaner_ids;
      } else if (cleaners && Array.isArray(cleaners)) {
        ids = cleaners.map((c: any) => c.id).filter((id: any) => id !== undefined);
      }

      if (ids.length === 0) {
        return res.status(400).json({ success: false, error: "cleaner_ids or cleaners array required" });
      }

      console.log(`📝 POST /api/selected-cleaners - Salvando ${ids.length} cleaners per ${workDate}`);

      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      const actionType = req.body.action_type || 'API_UPDATE';
      const performedBy = req.body.performed_by || 'api';
      await pgDailyAssignmentsService.saveSelectedCleaners(
        workDate,
        ids,
        actionType,
        null,
        performedBy,
        resolvedScope
      );

      console.log(`✅ Selected cleaners salvati per ${workDate}: ${ids.length} cleaners`);
      res.json({ 
        success: true, 
        message: `${ids.length} cleaners selezionati salvati per ${workDate}`,
        count: ids.length
      });
    } catch (error: any) {
      console.error("Errore nel salvataggio selected cleaners:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  // Endpoint per salvare/aggiornare i cleaners per una data (bulk import)
  app.post("/api/cleaners", async (req, res) => {
    try {
      const { date, cleaners, snapshotReason, scope } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      const resolvedScope = isOfficeScope(scope) ? "office" : "housekeeping";

      if (!cleaners || !Array.isArray(cleaners)) {
        return res.status(400).json({ success: false, error: "cleaners array required" });
      }

      console.log(`📝 POST /api/cleaners - Salvando ${cleaners.length} cleaners per ${workDate}`);

      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      
      // CRITICAL: Carica gli start_time esistenti da PostgreSQL PRIMA di sovrascrivere
      // Questo preserva gli start_time custom impostati dall'utente
      const existingCleaners = await pgDailyAssignmentsService.loadCleanersForDate(workDate, resolvedScope);
      const existingStartTimes = new Map<number, string>();
      if (existingCleaners && existingCleaners.length > 0) {
        for (const c of existingCleaners) {
          if (c.id && c.start_time) {
            existingStartTimes.set(c.id, c.start_time);
          }
        }
        console.log(`✅ Preservati ${existingStartTimes.size} start_time custom da PostgreSQL`);
      }
      
      // Merge: usa lo start_time esistente se presente e non nullo, altrimenti usa quello passato
      const mergedCleaners = cleaners.map((c: any) => {
        const existingStartTime = existingStartTimes.get(c.id);
        // Preserva lo start_time esistente solo se è custom (diverso da '10:00' o tw_start da ADAM)
        // Se il cleaner passato ha start_time e anche PostgreSQL ha uno start_time diverso dal default,
        // usa quello di PostgreSQL (è quello impostato dall'utente)
        return {
          ...c,
          start_time: existingStartTime ?? c.start_time ?? '10:00'
        };
      });
      
      const success = await pgDailyAssignmentsService.saveCleanersForDate(
        workDate,
        mergedCleaners,
        snapshotReason || 'api_update',
        resolvedScope
      );

      if (success) {
        res.json({ success: true, message: `${cleaners.length} cleaners salvati per ${workDate}` });
      } else {
        res.status(500).json({ success: false, error: "Errore nel salvataggio cleaners" });
      }
    } catch (error: any) {
      console.error("Errore nel salvataggio cleaners:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  // Endpoint per verificare i dati su PostgreSQL (DigitalOcean)
  app.get("/api/pg-assignments", async (req, res) => {
    try {
      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      const dateParam = (req.query.date as string) || format(new Date(), "yyyy-MM-dd");
      
      const assignments = await pgDailyAssignmentsService.getAssignments(dateParam, resolveScopeFromReq(req));
      const count = assignments.length;
      
      console.log(`📊 PG: ${count} assegnazioni trovate per ${dateParam}`);
      
      res.json({
        success: true,
        date: dateParam,
        count,
        assignments
      });
    } catch (error: any) {
      console.error("Errore nel caricamento da PostgreSQL:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  // Endpoint per verificare la history su PostgreSQL
  app.get("/api/pg-history", async (req, res) => {
    try {
      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      const dateParam = (req.query.date as string) || format(new Date(), "yyyy-MM-dd");
      const revisionParam = req.query.revision ? parseInt(req.query.revision as string) : null;
      
      if (revisionParam) {
        // Get specific revision
        const assignments = await pgDailyAssignmentsService.getHistoryByRevision(dateParam, revisionParam, resolveScopeFromReq(req));
        res.json({
          success: true,
          date: dateParam,
          revision: revisionParam,
          count: assignments.length,
          assignments
        });
      } else {
        // Get list of revisions
        const revisions = await pgDailyAssignmentsService.getHistoryRevisions(dateParam, resolveScopeFromReq(req));
        console.log(`📜 PG History: ${revisions.length} revisioni trovate per ${dateParam}`);
        
        res.json({
          success: true,
          date: dateParam,
          revisions
        });
      }
    } catch (error: any) {
      console.error("Errore nel caricamento history da PostgreSQL:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  // Endpoint per salvare un'assegnazione nella timeline
  app.post("/api/save-timeline-assignment", async (req, res) => {
    try {
      const { taskId, cleanerId, logisticCode, date, dropIndex, taskData, priority, modified_by, insertAt, modification_type } = req.body;
      const workDate = date || format(new Date(), 'yyyy-MM-dd');
      const currentUsername = modified_by || getCurrentUsername(req);
      const modificationType = modification_type || 'task_assigned_manually';

      // ENFORCEMENT: blocca assegnazioni manuali verso cleaner locked
      console.log(`🔍 CHECKING: save-timeline-assignment for cleanerId=${cleanerId}, workDate=${workDate}`);
      if (cleanerId && Number.isFinite(Number(cleanerId))) {
        const locked = await isCleanerLocked(workDate, Number(cleanerId));
        console.log(`🔍 RESULT: isCleanerLocked(${workDate}, ${Number(cleanerId)}) = ${locked}`);
        if (locked) {
          console.log(`🔒 BLOCKED: Cleaner ${cleanerId} locked for ${workDate}, manual assignment refused`);
          return res.status(423).json({
            success: false,
            error: "CLEANER_LOCKED",
            message: "Cleaner bloccato: impossibile assegnare",
            workDate,
            cleanerId: Number(cleanerId)
          });
        }
      } else {
        console.log(`⚠️ SKIPPING lock check: cleanerId=${cleanerId} (invalid or missing)`);
      }

      // ENFORCEMENT: Verifica se la task è bloccata prima di assegnare
      if (taskId) {
        const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
        const isLocked = await pgDailyAssignmentsService.isTaskLocked(workDate, Number(taskId));
        if (isLocked) {
          const lockInfo = await pgDailyAssignmentsService.getTaskLock(workDate, Number(taskId));
          console.log(`🔒 BLOCKED: Task ${taskId} è bloccata, assegnazione rifiutata`);
          return res.status(423).json({
            success: false,
            error: "TASK_LOCKED",
            message: "Task bloccata: impossibile assegnare",
            locked_reason: lockInfo?.lockedReason
          });
        }
      }

      // Carica containers per ottenere i dati completi del task
      let fullTaskData: any = null;
      let sourceContainerType: string | null = null; // To track where the task came from

      // SEMPRE carica i containers da PostgreSQL - necessario per salvare la history e rimuovere la task
      let containersData = null;
      try {
        containersData = await workspaceFiles.loadContainers(workDate, resolveScopeFromReq(req));
      } catch (error) {
        console.error(`Failed to load containers:`, error);
        // Continue without containers data
      }

      // Cerca la task nei containers per ottenere tutti i dati
      if (containersData) {
        for (const containerType of ['early_out', 'high_priority', 'low_priority']) {
          const container = containersData.containers?.[containerType];
          if (container && container.tasks) {
            const foundTask = container.tasks.find((t: any) =>
              String(t.task_id) === String(taskId) || String(t.logistic_code) === String(logisticCode)
            );
            if (foundTask) {
              // Crea una copia profonda per evitare modifiche all'originale
              fullTaskData = JSON.parse(JSON.stringify(foundTask));
              sourceContainerType = containerType;
              console.log(`✅ Task completa trovata in ${containerType}:`, {
                task_id: fullTaskData.task_id,
                logistic_code: fullTaskData.logistic_code,
                cleaning_time: fullTaskData.cleaning_time,
                address: fullTaskData.address
              });
              break;
            }
          }
        }
      }

      // Se non trovata nei containers, usa i dati passati (fallback)
      if (!fullTaskData && taskData) {
        console.log('⚠️ Task non trovata nei containers, usando dati passati');
        fullTaskData = JSON.parse(JSON.stringify(taskData));
      }

      // Se ancora non abbiamo dati, errore
      if (!fullTaskData) {
        console.error(`❌ Task ${logisticCode} non trovata`);
        return res.status(404).json({
          success: false,
          error: `Task ${logisticCode} non trovata`
        });
      }

      // Mappa i campi dal formato frontend (se necessario)
      // Il frontend usa: id, name, duration
      // Il backend richiede: task_id, logistic_code, cleaning_time
      if (!fullTaskData.task_id && fullTaskData.id) {
        fullTaskData.task_id = fullTaskData.id;
      }
      if (!fullTaskData.logistic_code && fullTaskData.name) {
        fullTaskData.logistic_code = fullTaskData.name;
      }
      if (!fullTaskData.cleaning_time && fullTaskData.duration) {
        // Converti duration da formato "1.5" (ore.minuti) a minuti
        const duration = String(fullTaskData.duration);
        const [hours, mins] = duration.split('.').map(Number);
        fullTaskData.cleaning_time = (hours || 0) * 60 + (mins || 0);
      }
      // Ensure essential fields are present, even if empty strings or null
      fullTaskData.address = fullTaskData.address || null;
      fullTaskData.lat = fullTaskData.lat || null;
      fullTaskData.lng = fullTaskData.lng || null;
      fullTaskData.premium = fullTaskData.premium || false;
      fullTaskData.cleaning_time = fullTaskData.cleaning_time || 0;


      // Carica timeline esistente o crea nuova struttura usando workspace helper
      let timelineData = await workspaceFiles.loadTimeline(workDate, resolveScopeFromReq(req));

      if (!timelineData) {
        // Crea nuova struttura se non esiste
        timelineData = {
          cleaners_assignments: [],
          current_date: workDate,
          meta: {
            total_cleaners: 0,
            total_tasks: 0,
            last_updated: getRomeTimestamp()
          },
          metadata: {
            date: workDate,
            last_updated: getRomeTimestamp(),
            created_by: currentUsername,
            modified_by: []
          }
        };
        console.log(`Creazione nuovo file timeline per ${workDate} da utente ${currentUsername}`);
      } else {
        // Preserva created_by e aggiorna modified_by
        timelineData.metadata = timelineData.metadata || {};
        if (!timelineData.metadata.created_by) {
          timelineData.metadata.created_by = currentUsername;
        }
        timelineData.metadata.modified_by = timelineData.metadata.modified_by || [];
        if (currentUsername && !timelineData.metadata.modified_by.includes(currentUsername)) {
          timelineData.metadata.modified_by.push(currentUsername);
        }
      }

      // Migrazione da vecchia struttura a nuova se necessario
      if (timelineData.assignments && !timelineData.cleaners_assignments) {
        timelineData.cleaners_assignments = [];
        timelineData.meta = {
          total_cleaners: 0,
          total_tasks: 0,
          last_updated: getRomeTimestamp()
        };
      }

      const normalizedLogisticCode = String(logisticCode);
      const normalizedTaskId = String(taskId);
      const normalizedCleanerId = Number(cleanerId);

      // Trova o crea l'entry per questo cleaner
      let cleanerEntry = timelineData.cleaners_assignments.find(
        (c: any) => c.cleaner.id === normalizedCleanerId
      );

      if (!cleanerEntry) {
        // Carica dati del cleaner da PostgreSQL
        const cleanersData = await workspaceFiles.loadSelectedCleaners(workDate, resolveScopeFromReq(req)) || { cleaners: [] };
        const cleanerInfo = cleanersData.cleaners?.find((c: any) => c.id === normalizedCleanerId);

        cleanerEntry = {
          cleaner: {
            id: normalizedCleanerId,
            name: cleanerInfo?.name || 'Unknown',
            lastname: cleanerInfo?.lastname || '',
            role: cleanerInfo?.role || 'Standard',
            premium: cleanerInfo?.premium || false
          },
          tasks: []
        };
        timelineData.cleaners_assignments.push(cleanerEntry);
      }

      // Rimuovi il task se già presente (evita duplicazioni)
      cleanerEntry.tasks = cleanerEntry.tasks.filter((t: any) =>
        String(t.logistic_code) !== normalizedLogisticCode && String(t.task_id) !== normalizedTaskId
      );

      // Normalizza la task al formato usato dagli script Python (IDENTICO agli script)
      const taskForTimeline = {
        // Campi identificativi (sempre come numeri)
        task_id: parseInt(String(fullTaskData.task_id || fullTaskData.id)),
        logistic_code: parseInt(String(fullTaskData.logistic_code || fullTaskData.name)),
        client_id: fullTaskData.client_id || null,

        // Flag booleani
        premium: Boolean(fullTaskData.premium),

        // Coordinate e indirizzo
        address: fullTaskData.address || null,
        lat: fullTaskData.lat || null,
        lng: fullTaskData.lng || null,

        // Tempo di pulizia (sempre in minuti)
        cleaning_time: fullTaskData.cleaning_time || 0,

        // Date e orari (formato ISO per le date)
        checkin_date: fullTaskData.checkin_date || null,
        checkout_date: fullTaskData.checkout_date || null,
        checkin_time: fullTaskData.checkin_time || null,
        checkout_time: fullTaskData.checkout_time || null,

        // Pax (sempre numeri)
        pax_in: fullTaskData.pax_in || 0,
        pax_out: fullTaskData.pax_out || 0,

        // Equipment e operazioni
        small_equipment: Boolean(fullTaskData.small_equipment),
        operation_id: fullTaskData.operation_id !== undefined ? fullTaskData.operation_id : 2,
        confirmed_operation: fullTaskData.confirmed_operation !== undefined ? Boolean(fullTaskData.confirmed_operation) : true,

        // Straordinaria (solo questo campo, come negli script)
        straordinaria: isTaskEquivalentToStraordinaria(fullTaskData),

        // Tipo appartamento e alias
        type_apt: fullTaskData.type_apt || null,
        alias: fullTaskData.alias || null,
        customer_name: fullTaskData.customer_name || fullTaskData.type || null,
        customer_reference: fullTaskData.customer_reference || null,

        // Reasons (combina quelle da containers con quella timeline)
        reasons: [
          ...(fullTaskData.reasons || []),
          'manually_moved_to_timeline'
        ],
        manually_moved: true,

        // Campi specifici timeline (formato orario HH:MM)
        priority: priority || sourceContainerType || 'low_priority',
        start_time: null,
        end_time: null,
        followup: false,
        sequence: 0,
        travel_time: 0
        // Note: modified_by is tracked in timeline.metadata, not per-task
      };

      console.log('📝 Task salvato in timeline:', {
        task_id: taskForTimeline.task_id,
        logistic_code: taskForTimeline.logistic_code,
        cleaning_time: taskForTimeline.cleaning_time,
        priority: taskForTimeline.priority
      });

      // Inserisci in posizione insertAt (il parametro effettivo che arriva dal frontend)
      const targetIndex = insertAt !== undefined
        ? Math.max(0, Math.min(insertAt, cleanerEntry.tasks.length))
        : cleanerEntry.tasks.length;

      cleanerEntry.tasks.splice(targetIndex, 0, taskForTimeline);

      // CRITICAL: Carica start_time aggiornato da PostgreSQL PRIMA di ricalcolare
      try {
        const selectedCleanersData = await workspaceFiles.loadSelectedCleaners(workDate, resolveScopeFromReq(req));
        const selectedCleaner = selectedCleanersData?.cleaners?.find((c: any) => c.id === normalizedCleanerId);
        
        if (selectedCleaner?.start_time) {
          cleanerEntry.cleaner.start_time = selectedCleaner.start_time;
          console.log(`✅ Loaded start_time ${selectedCleaner.start_time} from PostgreSQL for cleaner ${normalizedCleanerId}`);
        } else {
          console.warn(`⚠️ No start_time found for cleaner ${normalizedCleanerId}, using default 10:00`);
          cleanerEntry.cleaner.start_time = "10:00";
        }
      } catch (err) {
        console.warn(`⚠️ Could not load start_time from PostgreSQL for cleaner ${normalizedCleanerId}, using default`);
        cleanerEntry.cleaner.start_time = "10:00";
      }

      // Ricalcola travel_time, start_time, end_time usando lo script Python
      try {
        await hydrateTasksFromContainers(cleanerEntry, workDate);
        const updatedCleanerData = await recalculateCleanerTimes(cleanerEntry, workDate);
        cleanerEntry.tasks = updatedCleanerData.tasks;
        console.log(`✅ Tempi ricalcolati per cleaner ${normalizedCleanerId}`);
      } catch (pythonError: any) {
        console.error(`⚠️ Errore nel ricalcolo dei tempi, continuo senza ricalcolare:`, pythonError.message);
        // Fallback: ricalcola solo sequence manualmente
        cleanerEntry.tasks.forEach((t: any, i: number) => {
          t.sequence = i + 1;
          t.followup = i > 0;
        });
      }

      // Aggiorna metadata e meta, preservando created_by e aggiornando modified_by
      const modifyingUser = req.body.modified_by || req.body.created_by || currentUsername;

      timelineData.metadata = timelineData.metadata || {};
      timelineData.metadata.last_updated = getRomeTimestamp();
      timelineData.metadata.date = workDate;

      // Inizializza meta se non esiste (può accadere con dati da PostgreSQL)
      timelineData.meta = timelineData.meta || {};

      // Ottieni username corretto dalla richiesta
      const modifyingUserFromRequest = req.body.modified_by || req.body.created_by || currentUsername;

      // Preserva created_by se già esiste, altrimenti usa l'utente corrente
      if (!timelineData.metadata.created_by) {
        timelineData.metadata.created_by = modifyingUserFromRequest;
      }

      // Aggiorna modified_by array solo se l'utente non è 'system' o 'unknown'
      timelineData.metadata.modified_by = timelineData.metadata.modified_by || [];
      // Rimuovi 'system' e 'unknown' dall'array se presenti
      timelineData.metadata.modified_by = timelineData.metadata.modified_by.filter((user: string) =>
        user !== 'system' && user !== 'unknown'
      );
      if (modifyingUserFromRequest && modifyingUserFromRequest !== 'system' && modifyingUserFromRequest !== 'unknown' && !timelineData.metadata.modified_by.includes(modifyingUserFromRequest)) {
        timelineData.metadata.modified_by.push(modifyingUserFromRequest);
      }

      timelineData.meta.total_cleaners = timelineData.cleaners_assignments.length;
      timelineData.meta.total_tasks = timelineData.cleaners_assignments.reduce(
        (sum: number, c: any) => sum + c.tasks.length,
        0
      );

      // Salva timeline usando workspace helper (scrive su filesystem + Object Storage)
      await workspaceFiles.saveTimeline(workDate, timelineData, false, modifyingUserFromRequest, modificationType, undefined, resolveScopeFromReq(req));

      // RIMUOVI SEMPRE la task da containers.json quando salvata in timeline
      if (containersData && containersData.containers) {
        try {
          let taskRemoved = false;
          
          // CRITICAL: Salva revisione containers PRIMA di modificare (per supporto undo)
          try {
            const { pgDailyAssignmentsService } = await import('./services/pg-daily-assignments-service');
            await pgDailyAssignmentsService.saveContainersToHistory(workDate, modifyingUserFromRequest, 'task_moved_to_timeline');
            console.log(`📜 Containers history saved before removing task ${normalizedTaskId}`);
          } catch (historyError) {
            console.warn(`⚠️ Could not save containers history (non-blocking):`, historyError);
          }

          // Cerca in tutti i container e rimuovi TUTTI i duplicati basandosi su task_id univoco
          for (const [containerType, container] of Object.entries(containersData.containers)) {
            const containerObj = container as any;
            if (!containerObj.tasks) continue;

            const originalCount = containerObj.tasks.length;
            // Usa solo task_id come chiave univoca per rimuovere duplicati
            containerObj.tasks = containerObj.tasks.filter((t: any) =>
              String(t.task_id) !== normalizedTaskId
            );
            const newCount = containerObj.tasks.length;

            if (originalCount > newCount) {
              containerObj.count = newCount;
              taskRemoved = true;
              const removedCount = originalCount - newCount;
              console.log(`✅ Rimoss${removedCount > 1 ? 'e' : 'a'} ${removedCount} task ${normalizedLogisticCode} (duplicat${removedCount > 1 ? 'i' : 'o'}) da ${containerType}`);
            }
          }

          if (taskRemoved) {
            // Aggiorna summary
            if (containersData.summary) {
              containersData.summary.early_out = containersData.containers.early_out?.count || 0;
              containersData.summary.high_priority = containersData.containers.high_priority?.count || 0;
              containersData.summary.low_priority = containersData.containers.low_priority?.count || 0;
              containersData.summary.total_tasks =
                containersData.summary.early_out +
                containersData.summary.high_priority +
                containersData.summary.low_priority;
            }

            // Salva containers.json aggiornato usando workspace helper (filesystem + Object Storage)
            await workspaceFiles.saveContainers(workDate, containersData, 'system', 'manual', resolveScopeFromReq(req));
            console.log(`✅ Containers.json aggiornato e sincronizzato con timeline`);
          }
        } catch (containerError) {
          console.warn('Errore nella rimozione da containers.json:', containerError);
          // Non bloccare la risposta, l'assegnazione timeline è già salvata
        }
      }

      console.log(`✅ Salvato assignment per cleaner ${normalizedCleanerId} in posizione ${targetIndex}`);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Errore nel salvataggio dell'assegnazione nella timeline:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per rimuovere un'assegnazione dalla timeline
  app.post("/api/remove-timeline-assignment", async (req, res) => {
    try {
      const { taskId, logisticCode, date, modified_by } = req.body;
      const workDate = date || format(new Date(), 'yyyy-MM-dd');
      const currentUsername = modified_by || getCurrentUsername(req);

      console.log(`Rimozione assegnazione timeline - taskId: ${taskId}, logisticCode: ${logisticCode}, date: ${workDate}`);

      // Carica timeline usando workspace helper
      let assignmentsData = await workspaceFiles.loadTimeline(workDate, resolveScopeFromReq(req));
      if (!assignmentsData) {
        // Crea struttura vuota se non esiste
        assignmentsData = {
          cleaners_assignments: [],
          current_date: workDate,
          meta: { total_cleaners: 0, total_tasks: 0, last_updated: getRomeTimestamp() },
          metadata: { date: workDate, last_updated: getRomeTimestamp() }
        };
      }

      let removedCount = 0;
      let removedTask: any = null;

      // Rimuovi l'assegnazione per questo task da tutti i cleaner
      assignmentsData.cleaners_assignments = assignmentsData.cleaners_assignments.map((cleanerEntry: any) => {
        const initialTaskCountForCleaner = cleanerEntry.tasks?.length || 0;
        cleanerEntry.tasks = cleanerEntry.tasks.filter(
          (t: any) => {
            const matchCode = String(t.logistic_code) === String(logisticCode);
            const matchId = String(t.task_id) === String(taskId);
            if (matchCode || matchId) {
              removedTask = t; // Salva la task rimossa
            }
            return !matchCode && !matchId;
          }
        );
        const thisCleanerRemovedCount = initialTaskCountForCleaner - (cleanerEntry.tasks?.length || 0);
        removedCount += thisCleanerRemovedCount;
        
        // CRITICAL: Rinumera le sequence SUBITO per le task rimanenti (1, 2, 3...)
        // Il ricalcolo completo con hydrate+recalculate avverrà dopo con async
        if (cleanerEntry.tasks.length > 0 && thisCleanerRemovedCount > 0) {
          cleanerEntry.tasks = cleanerEntry.tasks.map((task: any, idx: number) => {
            task.sequence = idx + 1;
            task.followup = idx > 0;
            return task;
          });
          cleanerEntry._needsRecalculation = true; // Flag per ricalcolo async
          console.log(`🔢 Sequence rinumerata per ${cleanerEntry.tasks.length} task di cleaner ${cleanerEntry.cleaner?.id}`);
        }
        
        return cleanerEntry;
      }).filter((c: any) => c.tasks.length > 0); // Rimuovi cleaner vuoti
      
      // ASYNC: Ricalcola travel_time e start/end time per i cleaner che hanno perso task
      for (const cleanerEntry of assignmentsData.cleaners_assignments) {
        if (cleanerEntry._needsRecalculation) {
          try {
            await hydrateTasksFromContainers(cleanerEntry, workDate);
            const updatedData = await recalculateCleanerTimes(cleanerEntry, workDate);
            Object.assign(cleanerEntry, updatedData);
            console.log(`✅ Ricalcolati travel_time e orari per cleaner ${cleanerEntry.cleaner?.id}`);
          } catch (recalcError: any) {
            console.warn(`⚠️ Errore ricalcolo per cleaner ${cleanerEntry.cleaner?.id}: ${recalcError.message}`);
          }
          delete cleanerEntry._needsRecalculation;
        }
      }

      console.log(`Rimosse ${removedCount} assegnazioni`);

      // Aggiorna metadata e meta, preservando created_by e aggiornando modified_by
      const modifyingUser = req.body.modified_by || req.body.created_by || currentUsername;

      assignmentsData.metadata = assignmentsData.metadata || {};
      assignmentsData.metadata.last_updated = getRomeTimestamp();
      assignmentsData.metadata.date = workDate;

      // Preserva created_by se già esiste
      if (!assignmentsData.metadata.created_by) {
        assignmentsData.metadata.created_by = modifyingUser;
      }

      // Aggiorna modified_by array solo se l'utente non è 'system' o 'unknown'
      assignmentsData.metadata.modified_by = assignmentsData.metadata.modified_by || [];
      // Rimuovi 'system' e 'unknown' dall'array se presenti
      assignmentsData.metadata.modified_by = assignmentsData.metadata.modified_by.filter((user: string) =>
        user !== 'system' && user !== 'unknown'
      );
      if (modifyingUser && modifyingUser !== 'system' && modifyingUser !== 'unknown' && !assignmentsData.metadata.modified_by.includes(modifyingUser)) {
        assignmentsData.metadata.modified_by.push(modifyingUser);
      }

      assignmentsData.meta.total_cleaners = assignmentsData.cleaners_assignments.length;
      assignmentsData.meta.total_tasks = assignmentsData.cleaners_assignments.reduce(
        (sum: number, c: any) => sum + c.tasks.length,
        0
      );

      // Salva timeline usando workspace helper (filesystem + Object Storage)
      await workspaceFiles.saveTimeline(workDate, assignmentsData, false, modifyingUser, 'task_removed_from_timeline', undefined, resolveScopeFromReq(req));

      // RIPORTA la task nel container corretto
      if (removedTask) {
        try {
          // CRITICAL: Salva revisione containers PRIMA di modificare (per supporto undo)
          try {
            const { pgDailyAssignmentsService } = await import('./services/pg-daily-assignments-service');
            await pgDailyAssignmentsService.saveContainersToHistory(workDate, modifyingUser, 'task_returned_to_container');
            console.log(`📜 Containers history saved before adding task back`);
          } catch (historyError) {
            console.warn(`⚠️ Could not save containers history (non-blocking):`, historyError);
          }
          
          const containersData = await workspaceFiles.loadContainers(workDate, resolveScopeFromReq(req)) || { containers: { early_out: { tasks: [] }, high_priority: { tasks: [] }, low_priority: { tasks: [] } }, summary: {} };

          // Determina il container corretto in base alla priority della task
          const priority = removedTask.priority || 'low_priority';
          const containerType = priority === 'early_out' ? 'early_out'
            : priority === 'high_priority' ? 'high_priority'
            : 'low_priority';

          // Rimuovi campi specifici della timeline
          delete removedTask.start_time;
          delete removedTask.end_time;
          delete removedTask.travel_time;
          delete removedTask.sequence;
          delete removedTask.followup;

          // Filtra reasons automatiche
          if (removedTask.reasons) {
            removedTask.reasons = removedTask.reasons.filter((r: string) =>
              !['automatic_assignment_eo', 'automatic_assignment_hp', 'automatic_assignment_lp', 'manual_assignment', 'manually_moved_to_timeline'].includes(r)
            );
          }

          // Inizializza array se non esiste
          if (!containersData.containers[containerType].tasks) {
            containersData.containers[containerType].tasks = [];
          }

          // CRITICAL: Rimuovi eventuali duplicati esistenti prima di aggiungere
          const removedTaskId = String(removedTask.task_id);
          containersData.containers[containerType].tasks = containersData.containers[containerType].tasks.filter(
            (t: any) => String(t.task_id) !== removedTaskId
          );

          // Aggiungi la task (ora garantito senza duplicati)
          containersData.containers[containerType].tasks.push(removedTask);
          containersData.containers[containerType].count = containersData.containers[containerType].tasks.length;

          // Aggiorna summary
          if (containersData.summary) {
            containersData.summary.early_out = containersData.containers.early_out?.count || 0;
            containersData.summary.high_priority = containersData.containers.high_priority?.count || 0;
            containersData.summary.low_priority = containersData.containers.low_priority?.count || 0;
            containersData.summary.total_tasks =
              containersData.summary.early_out +
              containersData.summary.high_priority +
              containersData.summary.low_priority;
          }

          // Salva containers.json usando workspace helper (filesystem + Object Storage)
          await workspaceFiles.saveContainers(workDate, containersData, 'system', 'manual', resolveScopeFromReq(req));
          console.log(`✅ Task ${logisticCode} riportata nel container ${containerType}`);
        } catch (containerError) {
          console.warn('Errore nel ripristino del container:', containerError);
        }
      }

      res.json({ success: true, message: "Assegnazione rimossa dalla timeline con successo" });
    } catch (error: any) {
      console.error("Errore nella rimozione dell'assegnazione dalla timeline:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per verificare SE esistono assegnazioni salvate nel database (senza caricarle)
  app.post("/api/check-saved-assignments", async (req, res) => {
    try {
      const workDate = req.body?.date || format(new Date(), "yyyy-MM-dd");
      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");

      // Usa la tabella daily_assignments_revisions (PostgreSQL) come sorgente di verità
      const revisions = await pgDailyAssignmentsService.getHistoryRevisions(workDate, resolveScopeFromReq(req));

      if (revisions && revisions.length > 0) {
        const latest = revisions[0];
        const createdAt = latest.created_at ? new Date(latest.created_at) : new Date(workDate);

        return res.json({
          success: true,
          found: true,
          revision: latest.revision,
          formattedDateTime: format(createdAt, "dd/MM/yyyy HH:mm", { locale: it })
        });
      }

      // Nessuna revisione trovata
      return res.json({ success: true, found: false });
    } catch (error: any) {
      console.error("check-saved-assignments error:", error);
      return res.status(200).json({
        success: false,
        found: false,
        error: String(error?.message || error)
      });
    }
  });

  // [DEPRECATED] Endpoint per confermare le assegnazioni - ora il salvataggio è automatico su PostgreSQL
  app.post("/api/confirm-assignments", async (req, res) => {
    // Questo endpoint non è più necessario - il salvataggio avviene automaticamente
    // via workspace-files.ts che salva in PostgreSQL ad ogni modifica
    console.log("[DEPRECATED] /api/confirm-assignments chiamato - salvataggio automatico già attivo");
    res.json({ success: true, message: "Salvataggio automatico attivo - questo endpoint è deprecato" });
  });

  // Endpoint per caricare assegnazioni salvate dal database (PostgreSQL)
  app.post("/api/load-saved-assignments", async (req, res) => {
    try {
      const workDate = req.body?.date || format(new Date(), "yyyy-MM-dd");
      const officeScope = isOfficeScope(req.body?.scope);

      console.log(`📥 Caricamento assegnazioni dal database per ${workDate}...`);

      // Carica timeline, selected_cleaners E CONTAINERS da PostgreSQL via workspace-files
      const timelineData = await workspaceFiles.loadTimeline(workDate, resolveScopeFromReq(req));
      const selectedCleanersData = await workspaceFiles.loadSelectedCleaners(workDate, resolveScopeFromReq(req));
      let containersData = await workspaceFiles.loadContainers(workDate, resolveScopeFromReq(req));

      // CRITICAL: Considera found=true anche se abbiamo solo containers (per date passate)
      if (!timelineData && !selectedCleanersData && !containersData) {
        console.log(`ℹ️ Nessuna assegnazione salvata per ${workDate}`);
        return res.json({
          success: true,
          found: false,
          message: "Nessuna assegnazione salvata per questa data"
        });
      }

      // SEMPRE rigenera containers dal DB ADAM (per avere le task aggiornate)
      console.log(`🔄 Rigenerazione containers dal DB ADAM per ${workDate}...`);
      const createContainersPath = path.join(process.cwd(), 'client/public/scripts/create_containers.py');
      const workflowArg = officeScope ? ' --workflow office' : '';
      try {
        await new Promise<string>((resolve, reject) => {
          exec(`python3 "${createContainersPath}" --date "${workDate}" --skip-extract --use-api${workflowArg}`, (error, stdout, stderr) => {
            if (error) {
              console.error(`❌ Errore create_containers: ${error.message}`);
              reject(new Error(stderr || error.message));
            } else {
              console.log(`create_containers output: ${stdout}`);
              resolve(stdout);
            }
          });
        });

        // Carica i containers appena rigenerati da PostgreSQL (salvati da Python via API)
        containersData = await workspaceFiles.loadContainers(workDate, resolveScopeFromReq(req));
        // Guard against null containersData
        if (!containersData) {
          containersData = {
            containers: { early_out: { tasks: [], count: 0 }, high_priority: { tasks: [], count: 0 }, low_priority: { tasks: [], count: 0 } },
            summary: { early_out: 0, high_priority: 0, low_priority: 0, total_tasks: 0 },
            metadata: { date: workDate }
          };
        }
        console.log(`✅ Containers rigenerati dal DB ADAM per ${workDate} (caricati da PostgreSQL)`);

        // Sincronizza: rimuovi task già assegnate dai containers
        const assignedTaskIds = new Set<number>();
        if (timelineData?.cleaners_assignments) {
          for (const cleanerEntry of timelineData.cleaners_assignments) {
            for (const task of cleanerEntry.tasks || []) {
              assignedTaskIds.add(task.task_id);
            }
          }
        }

        console.log(`🔍 Task assegnate trovate in timeline: ${assignedTaskIds.size}`);

        let removedCount = 0;
        for (const containerType of ['early_out', 'high_priority', 'low_priority']) {
          const container = containersData.containers?.[containerType];
          if (container?.tasks) {
            const originalCount = container.tasks.length;
            container.tasks = container.tasks.filter((t: any) => !assignedTaskIds.has(t.task_id));
            container.count = container.tasks.length;
            removedCount += (originalCount - container.tasks.length);
          }
        }

        if (containersData.summary) {
          containersData.summary.early_out = containersData.containers.early_out?.count || 0;
          containersData.summary.high_priority = containersData.containers.high_priority?.count || 0;
          containersData.summary.low_priority = containersData.containers.low_priority?.count || 0;
          containersData.summary.total_tasks =
            containersData.summary.early_out +
            containersData.summary.high_priority +
            containersData.summary.low_priority;
        }

        // Salva containers sincronizzati su PostgreSQL (e filesystem come cache per Python scripts)
        await workspaceFiles.saveContainers(workDate, containersData, 'system', 'containers_synced_from_adam', resolveScopeFromReq(req));
        console.log(`✅ Containers sincronizzati: rimosse ${removedCount} task già assegnate, salvati su PostgreSQL`);
      } catch (err) {
        console.error('❌ Errore nella rigenerazione containers:', err);
        if (!containersData) {
          console.warn('⚠️ Impossibile rigenerare containers e nessun dato containers salvato disponibile');
        }
      }

      // Selected cleaners già caricati da PostgreSQL - nessuna scrittura filesystem necessaria
      if (selectedCleanersData && selectedCleanersData.cleaners) {
        const cleanerCount = selectedCleanersData.cleaners?.length || 0;
        console.log(`✅ Selected cleaners sincronizzati da PostgreSQL per ${workDate} (${cleanerCount} cleaners)`);
      } else {
        console.log(`✅ Nessun selected_cleaners trovato in PostgreSQL per ${workDate}`);
      }

      // CRITICAL: Sincronizza timeline da database a filesystem per Python scripts
      if (timelineData) {
        // Aggiorna metadata con la data corretta
        timelineData.metadata = timelineData.metadata || {};
        timelineData.metadata.date = workDate;
        timelineData.metadata.loaded_from_database = true;
        timelineData.metadata.loaded_at = getRomeTimestamp().replace('T', ' ').slice(0, 19);

        // Salva timeline su PostgreSQL (e filesystem come cache per Python scripts)
        await workspaceFiles.saveTimeline(workDate, timelineData, true, 'system', 'timeline_loaded_from_db', undefined, resolveScopeFromReq(req));
        const taskCount = timelineData.cleaners_assignments?.reduce((sum: number, c: any) => sum + (c.tasks?.length || 0), 0) || 0;
        console.log(`✅ Timeline sincronizzata da database per ${workDate} (${taskCount} task)`);
      } else {
        // Nessun dato timeline in database - crea struttura vuota
        const emptyTimeline = {
          metadata: { date: workDate, saved_at: getRomeTimestamp() },
          cleaners_assignments: []
        };
        await workspaceFiles.saveTimeline(workDate, emptyTimeline, true, 'system', 'timeline_initialized_empty', undefined, resolveScopeFromReq(req));
        console.log(`✅ Inizializzato timeline vuota per ${workDate} (nessun dato in database)`);
      }

      // Formatta data/ora per risposta
      const now = new Date();
      const dateObj = new Date(workDate);
      const day = String(dateObj.getDate()).padStart(2, '0');
      const month = String(dateObj.getMonth() + 1).padStart(2, '0');
      const year = String(dateObj.getFullYear()).slice(-2);
      const hours = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      const formattedDateTime = `${day}/${month}/${year} alle ${hours}:${minutes}`;

      res.json({
        success: true,
        found: true,
        formattedDateTime,
        data: timelineData,
        message: `Assegnazioni caricate dal database per ${workDate}`
      });
    } catch (error: any) {
      console.error("Errore nel caricamento delle assegnazioni:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per rimuovere un cleaner da PostgreSQL
  app.post("/api/remove-cleaner-from-selected", async (req, res) => {
    try {
      const { cleanerId, date } = req.body;

      if (!cleanerId) {
        return res.status(400).json({
          success: false,
          message: "cleanerId mancante"
        });
      }

      const workDate = date || format(new Date(), 'yyyy-MM-dd');

      // Carica i cleaners selezionati da PostgreSQL
      let selectedData: any = await workspaceFiles.loadSelectedCleaners(workDate, resolveScopeFromReq(req));
      if (!selectedData) {
        selectedData = { cleaners: [], total_selected: 0 };
      }

      // Carica timeline da PostgreSQL per verificare se il cleaner ha task
      let timelineData: any;
      let hasTasks = false;
      try {
        timelineData = await workspaceFiles.loadTimeline(workDate, resolveScopeFromReq(req));

        const cleanerEntry = timelineData?.cleaners_assignments?.find(
          (c: any) => c.cleaner?.id === cleanerId
        );
        hasTasks = cleanerEntry && cleanerEntry.tasks && cleanerEntry.tasks.length > 0;
      } catch (error) {
        // Timeline non esiste, nessuna task
        hasTasks = false;
      }

      // Rimuovi il cleaner dai selected cleaners in PostgreSQL
      const cleanersBefore = selectedData.cleaners.length;
      selectedData.cleaners = selectedData.cleaners.filter((c: any) => c.id !== cleanerId);
      selectedData.total_selected = selectedData.cleaners.length;
      selectedData.metadata = selectedData.metadata || {};
      selectedData.metadata.date = workDate;

      // Get username from request
      const currentUsername = req.body.modified_by || getCurrentUsername(req);

      // Salva su PostgreSQL con action_type 'removal'
      const { pgDailyAssignmentsService: pgService } = await import('./services/pg-daily-assignments-service');
      const remainingIds = selectedData.cleaners.map((c: any) => typeof c === 'number' ? c : c.id);
      await pgService.saveSelectedCleaners(
        workDate,
        remainingIds,
        'removal',
        { removed_cleaner_id: cleanerId },
        currentUsername,
        resolveScopeFromReq(req)
      );

      // Salva selected_cleaners usando workspace helper (filesystem come cache)
      await workspaceFiles.saveSelectedCleaners(workDate, selectedData, false, currentUsername, 'MANUAL', resolveScopeFromReq(req));

      let message = "";

      // Se il cleaner NON ha task, rimuovilo anche da timeline.json
      if (!hasTasks && timelineData) {
        timelineData.cleaners_assignments = timelineData.cleaners_assignments.filter(
          (c: any) => c.cleaner?.id !== cleanerId
        );

        // Aggiorna metadata
        timelineData.metadata = timelineData.metadata || {};
        timelineData.metadata.last_updated = getRomeTimestamp();
        timelineData.metadata.date = workDate;
        timelineData.meta = timelineData.meta || {};
        timelineData.meta.total_cleaners = timelineData.cleaners_assignments.length;
        timelineData.meta.total_tasks = timelineData.cleaners_assignments.reduce(
          (sum: number, c: any) => sum + (c.tasks?.length || 0),
          0
        );

        // Salva timeline.json (dual-write: filesystem + Object Storage)
        await workspaceFiles.saveTimeline(workDate, timelineData, false, currentUsername, 'cleaner_removed_from_selection', undefined, resolveScopeFromReq(req));

        console.log(`✅ Cleaner ${cleanerId} rimosso completamente (nessuna task)`);
        console.log(`   - Rimosso da PostgreSQL selected_cleaners (${cleanersBefore} -> ${selectedData.cleaners.length})`);
        console.log(`   - Rimosso da timeline`);
        message = "Cleaner rimosso completamente (nessuna task)";
      } else {
        console.log(`✅ Cleaner ${cleanerId} rimosso da PostgreSQL selected_cleaners (${cleanersBefore} -> ${selectedData.cleaners.length})`);
        console.log(`   Il cleaner rimane in timeline con le sue task fino a sostituzione`);
        message = "Cleaner rimosso dalla selezione (task mantenute)";
      }

      res.json({
        success: true,
        message,
        removedFromTimeline: !hasTasks
      });
    } catch (error: any) {
      console.error("Errore nella rimozione del cleaner:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per salvare i cleaners selezionati (PostgreSQL only)
  app.post("/api/save-selected-cleaners", async (req, res) => {
    try {
      const { cleaners: selectedCleaners, total_selected, date, action_type = 'replace', scope } = req.body;

      if (!selectedCleaners || !Array.isArray(selectedCleaners)) {
        return res.status(400).json({
          success: false,
          message: "Dati cleaners non validi"
        });
      }

      // Usa la data fornita o la data corrente
      const workDate = date || format(new Date(), 'yyyy-MM-dd');
      const resolvedScope = isOfficeScope(scope) ? "office" : "housekeeping";

      // Carica dati completi dei cleaners da PostgreSQL
      const { pgDailyAssignmentsService } = await import('./services/pg-daily-assignments-service');
      const cleanerIds = selectedCleaners.map((c: any) => typeof c === 'number' ? c : c.id);
      const fullCleanersData = await pgDailyAssignmentsService.loadCleanersByIds(cleanerIds, workDate, resolvedScope);

      // Crea mappa completa dei cleaners per ID
      const cleanersMap = new Map();
      fullCleanersData.forEach((c: any) => {
        cleanersMap.set(c.id, c);
      });

      // Arricchisci i cleaners con i dati completi da PostgreSQL
      // Preserva solo lo start_time se è stato modificato dall'utente
      const enrichedCleaners = selectedCleaners.map((c: any) => {
        const cleanerId = typeof c === 'number' ? c : c.id;
        const fullCleaner = cleanersMap.get(cleanerId);
        if (fullCleaner) {
          // Usa l'oggetto completo, ma preserva start_time custom se presente
          return {
            ...fullCleaner,
            start_time: c.start_time || fullCleaner.start_time
          };
        }
        // Fallback: usa i dati passati se non trovato in PostgreSQL
        return typeof c === 'number' ? { id: c, name: 'Unknown', start_time: '10:00' } : c;
      });

      const dataToSave = {
        cleaners: enrichedCleaners,
        total_selected: total_selected || enrichedCleaners.length,
        metadata: {
          date: workDate,
          saved_at: getRomeTimestamp()
        }
      };

      // Get username from request
      const currentUsername = req.body.modified_by || req.body.created_by || getCurrentUsername(req);

      // Salva su PostgreSQL con action_type descrittivo
      const { pgDailyAssignmentsService: pgService } = await import('./services/pg-daily-assignments-service');
      await pgService.saveSelectedCleaners(workDate, cleanerIds, action_type, null, currentUsername, resolvedScope);
      
      // Salva anche su filesystem per backward compat
      await workspaceFiles.saveSelectedCleaners(workDate, dataToSave, false, currentUsername, 'MANUAL', resolvedScope);

      console.log(`✅ Salvati ${enrichedCleaners.length} cleaners in PostgreSQL per ${workDate} by ${currentUsername}`);

      res.json({
        success: true,
        message: `${selectedCleaners.length} cleaners salvati con successo`,
        count: selectedCleaners.length
      });
    } catch (error: any) {
      console.error("Errore nel salvataggio selected_cleaners su PostgreSQL:", error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Endpoint per aggiungere un cleaner alla timeline (sostituisce cleaner rimossi da selected_cleaners)
  app.post("/api/add-cleaner-to-timeline", async (req, res) => {
    try {
      const { cleanerId, date, modified_by, created_by } = req.body;
      const workDate = date || format(new Date(), 'yyyy-MM-dd');
      const currentUsername = modified_by || created_by || getCurrentUsername(req);

      console.log(`Aggiunta cleaner ${cleanerId} alla timeline per data ${workDate}`);

      // Carica dati del cleaner da PostgreSQL
      const { pgDailyAssignmentsService } = await import('./services/pg-daily-assignments-service');
      const cleanersFromPg = await pgDailyAssignmentsService.loadCleanersByIds([cleanerId], workDate, resolveScopeFromReq(req));
      
      let cleanerData = cleanersFromPg.length > 0 ? cleanersFromPg[0] : null;

      if (!cleanerData) {
        console.error(`Cleaner ${cleanerId} non trovato in PostgreSQL`);
        return res.status(404).json({ success: false, error: "Cleaner non trovato" });
      }

      // Verifica se esiste già uno start_time impostato dall'utente in selected_cleaners
      const selectedCleanersData = await workspaceFiles.loadSelectedCleaners(workDate, resolveScopeFromReq(req)) || { cleaners: [], total_selected: 0, metadata: { date: workDate } };
      const existingCleaner = selectedCleanersData.cleaners?.find((c: any) => c.id === cleanerId);
      if (existingCleaner?.start_time) {
        cleanerData.start_time = existingCleaner.start_time;
        console.log(`✅ Usando start_time ${existingCleaner.start_time} esistente da PostgreSQL per cleaner ${cleanerId}`);
      } else {
        console.log(`ℹ️ Nessun start_time pre-esistente, usando default ${cleanerData.start_time || '10:00'}`);
      }

      const selectedCleanerIds = new Set(selectedCleanersData.cleaners.map((c: any) => c.id));

      // Carica timeline da PostgreSQL
      let timelineData: any = await workspaceFiles.loadTimeline(workDate, resolveScopeFromReq(req));
      
      if (!timelineData) {
        console.log("Timeline non trovata, creazione nuova struttura");
        timelineData = {
          cleaners_assignments: [],
          current_date: workDate,
          meta: { total_cleaners: 0, total_tasks: 0, last_updated: getRomeTimestamp() },
          metadata: { last_updated: getRomeTimestamp(), date: workDate }
        };
      }

      // CRITICAL: Cerca un cleaner in timeline CHE NON sia in selected_cleaners
      // Questi sono i cleaners rimossi che hanno ancora task
      const cleanerToReplace = timelineData.cleaners_assignments.find(
        (c: any) => !selectedCleanerIds.has(c.cleaner?.id || c.cleaner_id)
      );

      let replacedCleanerId: number | null = null;

      if (cleanerToReplace) {
        // SOSTITUZIONE: Questo cleaner è stato rimosso da selected_cleaners ma ha task
        replacedCleanerId = cleanerToReplace.cleaner?.id || cleanerToReplace.cleaner_id;
        const taskCount = cleanerToReplace.tasks?.length || 0;

        console.log(`🔄 SOSTITUZIONE cleaner rimosso ${replacedCleanerId} (con ${taskCount} task) con cleaner ${cleanerId}`);

        // Sostituisci SOLO i dati del cleaner, mantieni le task e la posizione
        cleanerToReplace.cleaner = {
          id: cleanerData.id,
          name: cleanerData.name,
          lastname: cleanerData.lastname,
          role: cleanerData.role,
          premium: cleanerData.role === "Premium"
        };

        // Ricalcola i tempi per le task con il nuovo cleaner
        if (taskCount > 0) {
          try {
            await hydrateTasksFromContainers(cleanerToReplace, workDate);
            const updatedData = await recalculateCleanerTimes(cleanerToReplace, workDate);
            cleanerToReplace.tasks = updatedData.tasks;
            console.log(`✅ Tempi ricalcolati per ${taskCount} task del nuovo cleaner ${cleanerId}`);
          } catch (err) {
            console.warn(`⚠️ Errore ricalcolo tempi, continuo senza ricalcolare`);
          }
        }
      } else {
        // AGGIUNTA: Nessun cleaner rimosso da sostituire, aggiungi alla fine
        console.log(`➕ Nessun cleaner da sostituire, aggiunta nuovo cleaner ${cleanerId} (senza task)`);

        // Cerca la posizione corretta basandoti su selected_cleaners da PostgreSQL
        // per mantenere l'ordine visivo
        const insertIndex = selectedCleanersData.cleaners.findIndex((c: any) => c.id === cleanerId);

        const newCleanerEntry = {
          cleaner: {
            id: cleanerData.id,
            name: cleanerData.name,
            lastname: cleanerData.lastname,
            role: cleanerData.role,
            premium: cleanerData.role === "Premium"
          },
          tasks: []
        };

        // Inserisci alla posizione corretta invece di append
        if (insertIndex >= 0 && insertIndex < timelineData.cleaners_assignments.length) {
          timelineData.cleaners_assignments.splice(insertIndex, 0, newCleanerEntry);
        } else {
          timelineData.cleaners_assignments.push(newCleanerEntry);
        }
      }

      // Aggiorna metadata timeline
      timelineData.metadata = timelineData.metadata || {};
      timelineData.metadata.last_updated = getRomeTimestamp();
      timelineData.metadata.date = workDate;
      timelineData.meta.total_cleaners = timelineData.cleaners_assignments.length;
      timelineData.meta.total_tasks = timelineData.cleaners_assignments.reduce(
        (sum: number, c: any) => sum + (c.tasks?.length || 0),
        0
      );

      // Salva timeline (dual-write: filesystem + Object Storage)
      await workspaceFiles.saveTimeline(workDate, timelineData, false, currentUsername, replacedCleanerId ? 'cleaner_replaced' : 'cleaner_added_to_timeline', undefined, resolveScopeFromReq(req));

      // Aggiungi il cleaner a PostgreSQL (se non già presente)
      const existingCleanerIndex = selectedCleanersData.cleaners.findIndex((c: any) => c.id === cleanerId);

      if (existingCleanerIndex === -1) {
        // Cleaner non presente, aggiungilo con l'oggetto completo
        selectedCleanersData.cleaners.push(cleanerData);
        selectedCleanersData.total_selected = selectedCleanersData.cleaners.length;
        selectedCleanersData.metadata = selectedCleanersData.metadata || {};
        selectedCleanersData.metadata.date = workDate;
        console.log(`✅ Cleaner ${cleanerId} aggiunto a PostgreSQL selected_cleaners`);
      } else {
        // Cleaner già presente, aggiorna i suoi dati con l'oggetto completo
        selectedCleanersData.cleaners[existingCleanerIndex] = cleanerData;
        selectedCleanersData.metadata = selectedCleanersData.metadata || {};
        selectedCleanersData.metadata.date = workDate;
        console.log(`✅ Cleaner ${cleanerId} aggiornato in PostgreSQL selected_cleaners`);
      }

      // Salva selected_cleaners su PostgreSQL
      await workspaceFiles.saveSelectedCleaners(workDate, selectedCleanersData, false, currentUsername, 'MANUAL', resolveScopeFromReq(req));

      console.log(`✅ Operazione completata: cleaner ${cleanerId} ${replacedCleanerId ? `ha sostituito ${replacedCleanerId}` : 'aggiunto'}`);

      res.json({
        success: true,
        replaced: replacedCleanerId,
        message: replacedCleanerId
          ? `Cleaner ${replacedCleanerId} sostituito con ${cleanerId}`
          : `Cleaner ${cleanerId} aggiunto`
      });
    } catch (error: any) {
      console.error("Errore nell'aggiunta del cleaner alla timeline:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per aggiornare assignments.json quando un task viene assegnato a un cleaner
  app.post("/api/update-assignments", async (req, res) => {
    try {
      const { cleanerId, tasks, date } = req.body;
      const workDate = date || format(new Date(), 'yyyy-MM-dd');

      const assignmentsPath = path.join(process.cwd(), 'client/public/data/output/assignments.json');

      // Carica i dati dei cleaners da PostgreSQL
      const cleanersData = await workspaceFiles.loadSelectedCleaners(workDate, resolveScopeFromReq(req)) || { cleaners: [] };

      // Trova il cleaner corrispondente (per ora usa un mapping, poi sarà dinamico)
      const cleanerMapping: { [key: string]: number } = {
        'lopez': 24,  // ID del primo cleaner
        'garcia': 249, // ID del secondo cleaner
        'rossi': 287   // ID del terzo cleaner
      };

      const cleanerRealId = cleanerMapping[cleanerId];
      const cleaner = cleanersData.cleaners?.find((c: any) => c.id === cleanerRealId);

      if (!cleaner) {
        res.status(404).json({ success: false, message: "Cleaner non trovato" });
        return;
      }

      // Carica o crea assignments.json
      let assignmentsData: any = { assignments: [] };
      try {
        const existingData = await fs.readFile(assignmentsPath, 'utf8');
        assignmentsData = JSON.parse(existingData);
      } catch (error) {
        // File non esiste, usa struttura vuota
      }

      // Rimuovi eventuali assegnazioni precedenti per questo cleaner
      assignmentsData.assignments = assignmentsData.assignments.filter(
        (a: any) => a.cleaner_id !== cleanerRealId
      );

      // Calcola cleaning_time totale
      const totalCleaningTime = tasks.reduce((sum: number, task: any) => {
        const duration = task.duration || "0.0";
        const [hours, minutes] = duration.split('.').map(Number);
        return sum + (hours * 60) + (minutes || 0);
      }, 0);

      // Crea i task con i nuovi campi
      const assignedTasks = tasks.map((task: any, index: number) => ({
        // Dati del task
        task_id: parseInt(task.id),
        logistic_code: parseInt(task.name),
        address: task.address,
        cleaning_time: task.duration,
        checkin_date: task.checkin_date,
        checkout_date: task.checkout_date,
        checkin_time: task.checkin_time,
        checkout_time: task.checkout_time,
        premium: task.premium,
        straordinaria: isTaskEquivalentToStraordinaria(task),
        confirmed_operation: task.confirmed_operation,
        pax_in: task.pax_in,
        pax_out: task.pax_out,
        operation_id: task.operation_id,
        customer_name: task.customer_name,
        type_apt: task.type_apt,

        // Nuovi campi di assegnazione
        sequence: index + 1,
        assignment_reason: "manually_assigned"
      }));

      // Crea l'assegnazione completa
      const assignment = {
        cleaner_id: cleanerRealId,
        cleaner_name: cleaner.name,
        cleaner_lastname: cleaner.lastname,
        cleaner_role: cleaner.role,
        cleaner_contract_type: cleaner.contract_type,
        cleaner_start_time: cleaner.start_time,

        // Campi specifici dell'assegnazione
        total_tasks: tasks.length,
        complessive_time: totalCleaningTime,

        // Lista dei task assegnati
        assigned_tasks: assignedTasks
      };

      // Aggiungi la nuova assegnazione
      assignmentsData.assignments.push(assignment);

      // Salva il file
      await fs.writeFile(assignmentsPath, JSON.stringify(assignmentsData, null, 2));

      res.json({ success: true, message: "Assignments aggiornato con successo" });
    } catch (error: any) {
      console.error("Errore nell'aggiornamento di assignments:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per aggiornare i file JSON quando un task viene spostato
  app.post("/api/update-task-json", async (req, res) => {
    try {
      const {
        taskId,
        logisticCode,
        fromContainer,
        toContainer,
        sourceIndex,
        destIndex,
        date,
      } = req.body as {
        taskId?: string | number;
        logisticCode?: string | number;
        fromContainer?: 'early_out' | 'high_priority' | 'low_priority';
        toContainer?: 'early_out' | 'high_priority' | 'low_priority';
        sourceIndex?: number;
        destIndex?: number;
        date?: string;
      };
      const workDate = date || format(new Date(), 'yyyy-MM-dd');

      if (!fromContainer || !toContainer) {
        return res.status(400).json({ success: false, message: 'fromContainer e toContainer sono obbligatori' });
      }

      // Carica containers da PostgreSQL
      const containersData: any = await workspaceFiles.loadContainers(workDate, resolveScopeFromReq(req));

      const containers = containersData?.containers;
      if (!containers) {
        return res.status(500).json({ success: false, message: 'Struttura containers mancante' });
      }

      const recalc = () => {
        const eo = containers.early_out?.tasks?.length ?? 0;
        const hp = containers.high_priority?.tasks?.length ?? 0;
        const lp = containers.low_priority?.tasks?.length ?? 0;

        containers.early_out.count = eo;
        containers.high_priority.count = hp;
        containers.low_priority.count = lp;

        containersData.summary = {
          total_tasks: eo + hp + lp,
          early_out: eo,
          high_priority: hp,
          low_priority: lp,
        };
      };

      const findIndexById = (arr: any[]) => {
        if (typeof taskId !== 'undefined') {
          const idStr = String(taskId);
          const idx = arr.findIndex((t) => String(t?.task_id) === idStr || String(t?.id) === idStr);
          if (idx !== -1) return idx;
        }
        if (typeof logisticCode !== 'undefined') {
          const codeStr = String(logisticCode);
          const idx = arr.findIndex((t) => String(t?.logistic_code) === codeStr);
          if (idx !== -1) return idx;
        }
        return -1;
      };

      // Colonne sorgente/destinazione
      const srcCol = containers[fromContainer];
      const dstCol = containers[toContainer];

      if (!srcCol?.tasks || !dstCol?.tasks) {
        return res.status(400).json({ success: false, message: 'Container non valido (early_out | high_priority | low_priority)' });
      }

      // --- Caso A: RIORDINO nello STESSO container --------------------------
      if (fromContainer === toContainer) {
        const tasks = srcCol.tasks as any[];

        if (typeof sourceIndex === 'number' && typeof destIndex === 'number') {
          if (sourceIndex < 0 || sourceIndex >= tasks.length) {
            return res.status(400).json({ success: false, message: 'sourceIndex fuori range' });
          }
          const [moved] = tasks.splice(sourceIndex, 1);
          const safeDest = Math.min(Math.max(destIndex, 0), tasks.length);
          tasks.splice(safeDest, 0, moved);

          recalc();
          // Salva containers (dual-write: filesystem + Object Storage)
          await workspaceFiles.saveContainers(workDate, containersData, 'system', 'manual', resolveScopeFromReq(req));

          return res.json({ success: true, message: 'Riordino nello stesso container eseguito' });
        }

        // fallback: trova la task e mettila in fondo (non ideale ma sicuro)
        const idx = findIndexById(tasks);
        if (idx === -1) {
          return res.status(404).json({ success: false, message: 'Task non trovata nel container' });
        }
        const [moved] = tasks.splice(idx, 1);
        tasks.push(moved);

        recalc();
        // Salva containers (dual-write: filesystem + Object Storage)
        await workspaceFiles.saveContainers(workDate, containersData, 'system', 'manual', resolveScopeFromReq(req));

        return res.json({ success: true, message: 'Riordino fallback (append) eseguito' });
      }

      // --- Caso B: SPOSTAMENTO TRA container diversi ------------------------
      const srcTasks = srcCol.tasks as any[];
      const dstTasks = dstCol.tasks as any[];

      // prova prima con sourceIndex se disponibile, altrimenti cerca per id/codice
      let takeIndex = -1;
      if (typeof sourceIndex === 'number' && sourceIndex >= 0 && sourceIndex < srcTasks.length) {
        takeIndex = sourceIndex;
      } else {
        takeIndex = findIndexById(srcTasks);
      }

      if (takeIndex === -1) {
        return res.status(404).json({ success: false, message: 'Task non trovata nel container sorgente' });
      }

      const [taskToMove] = srcTasks.splice(takeIndex, 1);

      // inserisci in posizione precisa se destIndex è valido; altrimenti in fondo
      if (typeof destIndex === 'number' && destIndex >= 0 && destIndex <= dstTasks.length) {
        dstTasks.splice(destIndex, 0, taskToMove);
      } else {
        dstTasks.push(taskToMove);
      }

      // Aggiorna count + summary
      recalc();

      // Salva containers (dual-write: filesystem + Object Storage)
      await workspaceFiles.saveContainers(workDate, containersData, 'system', 'manual', resolveScopeFromReq(req));

      return res.json({ success: true, message: 'Task spostata tra containers' });
    } catch (err: any) {
      console.error('update-task-json error:', err);
      return res.status(500).json({ success: false, message: 'Errore interno', error: String(err?.message ?? err) });
    }
  });

  // Endpoint per aggiornare lo start time di un cleaner
  app.post("/api/update-cleaner-start-time", async (req, res) => {
    try {
      const { cleanerId, startTime, date, modified_by } = req.body;
      const cleanerIdNum = Number(cleanerId);

      if (!Number.isFinite(cleanerIdNum) || !startTime || !date) {
        return res.status(400).json({
          success: false,
          message: "cleanerId, startTime e date sono richiesti"
        });
      }

      const workDate = date;
      const currentUsername = modified_by || getCurrentUsername(req);

      // Carica selected_cleaners da PostgreSQL
      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      const selectedCleanersResult = await workspaceFiles.loadSelectedCleaners(workDate, resolveScopeFromReq(req));
      let selectedCleanersData = selectedCleanersResult || {
        cleaners: [],
        total_selected: 0,
        metadata: { date: workDate }
      };

      // Trova e aggiorna il cleaner se esiste
      const cleanerIndex = selectedCleanersData.cleaners.findIndex((c: any) => Number(c.id) === cleanerIdNum);
      if (cleanerIndex !== -1) {
        selectedCleanersData.cleaners[cleanerIndex].start_time = startTime;
      } else {
        // CRITICAL: Se il cleaner non esiste ancora in selected_cleaners,
        // caricalo da PostgreSQL e aggiungilo con lo start_time
        const cleaners = await pgDailyAssignmentsService.loadCleanersForDate(workDate, resolveScopeFromReq(req));
        let cleanerData = cleaners?.find((c: any) => Number(c.id) === cleanerIdNum);

        if (!cleanerData) {
          return res.status(404).json({
            success: false,
            message: "Cleaner non trovato in PostgreSQL"
          });
        }

        // Aggiungi il cleaner con lo start_time
        cleanerData.start_time = startTime;
        selectedCleanersData.cleaners.push(cleanerData);
        selectedCleanersData.total_selected = selectedCleanersData.cleaners.length;
        console.log(`✅ Cleaner ${cleanerId} aggiunto a selected_cleaners con start_time ${startTime}`);
      }

      // Aggiorna start_time in PostgreSQL cleaners table
      await pgDailyAssignmentsService.updateCleanerField(cleanerIdNum, workDate, 'start_time', startTime);

      // Salva selected_cleaners su PostgreSQL (skipRevision=true)
      await workspaceFiles.saveSelectedCleaners(workDate, selectedCleanersData, true, 'system', 'INIT', resolveScopeFromReq(req));

      // Aggiorna anche la timeline se il cleaner è presente
      try {
        const timelineData = await workspaceFiles.loadTimeline(workDate, resolveScopeFromReq(req));
        if (timelineData) {
          const cleanerAssignment = timelineData.cleaners_assignments?.find((ca: any) => Number(ca.cleaner?.id) === cleanerIdNum);
          if (cleanerAssignment && cleanerAssignment.cleaner) {
            cleanerAssignment.cleaner.start_time = startTime;

            // Aggiorna i metadata
            timelineData.metadata = timelineData.metadata || {};
            timelineData.metadata.last_updated = getRomeTimestamp();
            timelineData.metadata.date = workDate;

            // Preserva created_by e aggiorna modified_by
            if (!timelineData.metadata.created_by) {
              timelineData.metadata.created_by = currentUsername;
            }
            timelineData.metadata.modified_by = timelineData.metadata.modified_by || [];
            if (currentUsername && currentUsername !== 'system' && currentUsername !== 'unknown' && !timelineData.metadata.modified_by.includes(currentUsername)) {
              timelineData.metadata.modified_by.push(currentUsername);
            }

            // Salva timeline su PostgreSQL (skipRevision=true)
            await workspaceFiles.saveTimeline(workDate, timelineData, true, 'system', 'manual', undefined, resolveScopeFromReq(req));
          }
        }
      } catch (error) {
        console.log('Timeline non trovata o non aggiornata');
      }

      console.log(`✅ Start time aggiornato per cleaner ${cleanerId}: ${startTime}`);
      res.json({
        success: true,
        message: "Start time aggiornato con successo"
      });
    } catch (error: any) {
      console.error('Errore aggiornamento start time:', error);
      res.status(500).json({
        success: false,
        message: error.message || "Errore nel salvataggio dello start time"
      });
    }
  });

  // Endpoint per aggiornare l'alias di un cleaner (PostgreSQL)
  app.post("/api/update-cleaner-alias", async (req, res) => {
    try {
      const { cleanerId, alias, date } = req.body;

      if (!cleanerId) {
        return res.status(400).json({ success: false, error: "cleanerId richiesto" });
      }

      const workDate = date || format(new Date(), "yyyy-MM-dd");
      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");

      // Aggiorna alias direttamente in PostgreSQL
      const success = await pgDailyAssignmentsService.updateCleanerField(
        cleanerId,
        workDate,
        'alias',
        alias || null
      );

      if (!success) {
        return res.status(500).json({ success: false, error: "Errore nel salvataggio alias in PostgreSQL" });
      }

      console.log(`✅ Alias aggiornato in PostgreSQL per cleaner ${cleanerId}: "${alias}"`);
      res.json({ success: true, message: "Alias aggiornato con successo" });
    } catch (error: any) {
      console.error("Errore nell'aggiornamento dell'alias:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per bloccare/sbloccare una task
  // Source of truth: daily_task_locks table in PostgreSQL
  app.post("/api/lock-task", async (req, res) => {
    try {
      const { task_id, logistic_code, locked, locked_reason, locked_by } = req.body;
      const workDate = req.body.date || format(new Date(), "yyyy-MM-dd");
      const currentUser = getCurrentUsername(req) || locked_by || 'unknown';

      if (!task_id) {
        return res.status(400).json({ success: false, error: "task_id richiesto" });
      }

      console.log(`🔒 Lock task request: task_id=${task_id}, locked=${locked}, reason="${locked_reason}", by="${currentUser}"`);

      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      
      // Aggiorna nella tabella daily_task_locks (source of truth)
      await pgDailyAssignmentsService.updateTaskLockStatus(
        workDate, 
        Number(task_id), 
        locked, 
        locked_reason || null, 
        currentUser
      );
      
      // Sincronizza anche su daily_containers per backward compatibility
      await pgDailyAssignmentsService.syncLockToContainers(task_id, workDate, locked, locked_reason);

      console.log(`✅ Task ${task_id} ${locked ? 'bloccata' : 'sbloccata'} in daily_task_locks`);
      res.json({ success: true, locked, locked_reason, locked_by: currentUser });
    } catch (error: any) {
      console.error("Errore nel blocco task:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per bloccare/sbloccare multiple tasks
  app.post("/api/bulk-lock-tasks", async (req, res) => {
    try {
      const { task_ids, locked, locked_reason, locked_by } = req.body;
      const workDate = req.body.date || format(new Date(), "yyyy-MM-dd");
      const currentUser = getCurrentUsername(req) || locked_by || 'unknown';

      if (!task_ids || !Array.isArray(task_ids) || task_ids.length === 0) {
        return res.status(400).json({ success: false, error: "task_ids array richiesto" });
      }

      console.log(`🔒 Bulk lock request: ${task_ids.length} tasks, locked=${locked}`);

      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      
      // Bulk update nella tabella daily_task_locks
      await pgDailyAssignmentsService.bulkUpdateTaskLockStatus(
        workDate,
        task_ids.map(Number),
        locked,
        locked_reason || null,
        currentUser
      );

      // Sincronizza su daily_containers
      for (const taskId of task_ids) {
        await pgDailyAssignmentsService.syncLockToContainers(taskId, workDate, locked, locked_reason);
      }

      console.log(`✅ ${task_ids.length} tasks ${locked ? 'bloccate' : 'sbloccate'}`);
      res.json({ success: true, locked, count: task_ids.length });
    } catch (error: any) {
      console.error("Errore nel bulk lock tasks:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per ottenere tutti i lock per una data
  app.get("/api/task-locks", async (req, res) => {
    try {
      const workDate = (req.query.date as string) || format(new Date(), "yyyy-MM-dd");

      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      const locksMap = await pgDailyAssignmentsService.getLocksMap(workDate);
      
      // Converti Map in oggetto per JSON response
      const locks: { [taskId: number]: { locked: boolean; lockedReason: string | null; lockedBy: string | null } } = {};
      locksMap.forEach((value, key) => {
        locks[key] = value;
      });

      res.json({ success: true, workDate, locks });
    } catch (error: any) {
      console.error("Errore nel caricamento locks:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ==================== CLEANER LOCKS (daily_cleaner_locks) ====================

  // POST /api/cleaner-locks/set
  // Body: { date, cleanerId, isLocked }
  // DB: UPSERT - non cancella righe, mantiene storico (is_locked=false quando sblocchi)
  app.post("/api/cleaner-locks/set", async (req, res) => {
    try {
      const { date, cleanerId, isLocked } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");

      if (!cleanerId || isNaN(Number(cleanerId))) {
        return res.status(400).json({ success: false, error: "cleanerId richiesto e deve essere un numero" });
      }
      if (typeof isLocked !== "boolean") {
        return res.status(400).json({ success: false, error: "isLocked richiesto e deve essere boolean" });
      }

      const { query } = await import("../shared/pg-db");

      await query(
        `
          INSERT INTO daily_cleaner_locks (work_date, cleaner_id, is_locked)
          VALUES ($1, $2, $3)
          ON CONFLICT (work_date, cleaner_id)
          DO UPDATE SET is_locked = EXCLUDED.is_locked, updated_at = now()
        `,
        [workDate, Number(cleanerId), isLocked]
      );

      console.log(`🔒 Cleaner lock set: date=${workDate}, cleanerId=${Number(cleanerId)}, isLocked=${isLocked}`);
      res.json({ success: true, workDate, cleanerId: Number(cleanerId), isLocked });
    } catch (error: any) {
      console.error("Errore nel set cleaner lock:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // GET /api/cleaner-locks?date=YYYY-MM-DD
  // Response: { lockedCleanerIds: number[] }
  app.get("/api/cleaner-locks", async (req, res) => {
    try {
      const workDate = (req.query.date as string) || format(new Date(), "yyyy-MM-dd");
      const { query } = await import("../shared/pg-db");

      const result = await query(
        `
          SELECT cleaner_id
          FROM daily_cleaner_locks
          WHERE work_date = $1 AND is_locked = true
          ORDER BY cleaner_id
        `,
        [workDate]
      );

      const lockedCleanerIds = result.rows
        .map((r: any) => Number(r.cleaner_id))
        .filter((n: number) => Number.isFinite(n));

      res.json({ success: true, workDate, lockedCleanerIds });
    } catch (error: any) {
      console.error("Errore nel caricamento cleaner locks:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ==================== TASK COLLABORATION ENDPOINTS ====================

  // GET /api/tasks/:taskId/collaborators - Info collaborazione per UI
  app.get("/api/tasks/:taskId/collaborators", async (req, res) => {
    try {
      const taskId = parseInt(req.params.taskId, 10);
      const workDate = (req.query.date as string) || format(new Date(), "yyyy-MM-dd");

      if (isNaN(taskId)) {
        return res.status(400).json({ success: false, error: "taskId deve essere un numero" });
      }

      const { taskCollaborationService } = await import("./services/pg-task-collaboration-service");
      
      const collaboration = await taskCollaborationService.getCollaboration(workDate, taskId);
      
      // Recupera alias e nominativi per i collaboratori
      const { query } = await import("../shared/pg-db");
      const [aliasesResult, cleanersResult] = await Promise.all([
        query(
          `SELECT cleaner_id, alias FROM aliases WHERE cleaner_id = ANY($1)`,
          [collaboration.cleanerIds]
        ),
        query(
          `SELECT cleaner_id, name, lastname
           FROM cleaners
           WHERE cleaner_id = ANY($1)
             AND work_date = $2`,
          [collaboration.cleanerIds, workDate]
        ),
      ]);
      
      const aliasMap = new Map(aliasesResult.rows.map(r => [r.cleaner_id, r.alias]));
      const cleanerNameMap = new Map(
        cleanersResult.rows.map((r: any) => [
          r.cleaner_id,
          `${String(r.name ?? "").trim()} ${String(r.lastname ?? "").trim()}`.trim(),
        ])
      );
      
      const collaborators = collaboration.cleanerIds.map(id => ({
        id,
        alias: String(aliasMap.get(id) ?? "").trim() || cleanerNameMap.get(id) || `Cleaner ${id}`,
        isPrimary: id === collaboration.primaryCleanerId
      }));

      res.json({
        success: true,
        workDate,
        taskId,
        collaborators,
        primaryCleanerId: collaboration.primaryCleanerId,
        count: collaboration.count
      });
    } catch (error: any) {
      console.error("Errore nel caricamento collaborazione:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/tasks/:taskId/collaborators/add - Caso A: aggiungi collaboratore a task esistente
  app.post("/api/tasks/:taskId/collaborators/add", async (req, res) => {
    try {
      const taskId = parseInt(req.params.taskId, 10);
      const { date, cleanerId } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");

      if (isNaN(taskId)) {
        return res.status(400).json({ success: false, error: "taskId deve essere un numero" });
      }
      if (!cleanerId || isNaN(Number(cleanerId))) {
        return res.status(400).json({ success: false, error: "cleanerId richiesto e deve essere un numero" });
      }

      const { query } = await import("../shared/pg-db");
      const pool = (await import("../shared/pg-db")).default;
      const { taskCollaborationService } = await import("./services/pg-task-collaboration-service");
      const { recomputeSchedule, validateOverlap } = await import("./schedule/recompute");

      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        // 1. Verifica che il task esista già in timeline
        const existingTask = await client.query(
          `SELECT * FROM daily_assignments_current 
           WHERE work_date = $1 AND task_id = $2 
           ORDER BY cleaner_id LIMIT 1`,
          [workDate, taskId]
        );

        if (existingTask.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ 
            success: false, 
            error: "Task non trovato in timeline. Usa /assign per assegnare da containers." 
          });
        }

        const originalRow = existingTask.rows[0];
        const baseCleaningTime = originalRow.base_cleaning_time || originalRow.cleaning_time;

        // 2. Identifica il primary cleaner
        const existingCollaboration = await taskCollaborationService.getCollaboration(workDate, taskId);
        const primaryCleanerId: number = existingCollaboration.primaryCleanerId ?? originalRow.cleaner_id;

        // 3. Verifica che il nuovo cleaner non sia già un collaboratore
        if (existingCollaboration.cleanerIds.includes(Number(cleanerId))) {
          await client.query('ROLLBACK');
          return res.status(400).json({ 
            success: false, 
            error: "Il cleaner è già un collaboratore di questa task" 
          });
        }

        // 3.5 AUTO-CONVOCAZIONE: Se il cleaner non è nei selected_cleaners, aggiungilo atomicamente
        // Usa UPSERT con ON CONFLICT per evitare race conditions anche quando la riga non esiste
        const selectedScope = resolveScopeFromReq(req);
        const selectedCleanersResult = await client.query(
          `SELECT cleaners
           FROM daily_selected_cleaners
           WHERE work_date = $1 AND scope = $2
           FOR UPDATE`,
          [workDate, selectedScope]
        );
        let currentSelectedCleaners: number[] = selectedCleanersResult.rows[0]?.cleaners || [];
        let wasAutoSummoned = false;
        
        if (!currentSelectedCleaners.includes(Number(cleanerId))) {
          console.log(`🆕 Auto-convocazione cleaner ${cleanerId} per ${workDate}`);
          wasAutoSummoned = true;
          
          // UPSERT atomico: INSERT con ON CONFLICT per gestire sia create che update
          await client.query(
            `INSERT INTO daily_selected_cleaners (work_date, scope, cleaners, updated_at)
             VALUES ($1, $3, ARRAY[$2::integer], NOW())
             ON CONFLICT (work_date, scope) DO UPDATE 
             SET cleaners = ARRAY(SELECT DISTINCT unnest(array_append(daily_selected_cleaners.cleaners, $2::integer))),
                 updated_at = NOW()`,
            [workDate, Number(cleanerId), selectedScope]
          );
          console.log(`✅ Cleaner ${cleanerId} aggiunto ai selected_cleaners per ${workDate}`);
        }

        // 4. Inserisci in task_collaborators
        // Prima il primary (se non esiste già)
        if (!existingCollaboration.cleanerIds.includes(primaryCleanerId)) {
          await client.query(
            `INSERT INTO task_collaborators (work_date, task_id, cleaner_id, is_primary)
             VALUES ($1, $2, $3, true)
             ON CONFLICT (work_date, task_id, cleaner_id) DO UPDATE SET is_primary = true`,
            [workDate, taskId, primaryCleanerId]
          );
        }

        // Poi il nuovo collaboratore
        await client.query(
          `INSERT INTO task_collaborators (work_date, task_id, cleaner_id, is_primary)
           VALUES ($1, $2, $3, false)
           ON CONFLICT (work_date, task_id, cleaner_id) DO NOTHING`,
          [workDate, taskId, Number(cleanerId)]
        );

        // 5. Ri-query count reale dopo tutti gli inserimenti
        const countResult = await client.query(
          `SELECT COUNT(*)::int as count FROM task_collaborators 
           WHERE work_date = $1 AND task_id = $2`,
          [workDate, taskId]
        );
        const newCollabCount = countResult.rows[0].count;
        const effectiveCleaningTime = Math.ceil(baseCleaningTime / newCollabCount);

        // 6. Trova sequence per il nuovo cleaner (append in coda)
        const maxSeqResult = await client.query(
          `SELECT COALESCE(MAX(sequence), 0) as max_seq 
           FROM daily_assignments_current 
           WHERE work_date = $1 AND cleaner_id = $2`,
          [workDate, Number(cleanerId)]
        );
        const newSequence = maxSeqResult.rows[0].max_seq + 1;

        // 7. Crea la riga di assegnazione per il nuovo cleaner
        // Genera un nuovo ID esplicitamente per evitare conflitti con sequence non sincronizzata
        const maxIdResult = await client.query(
          `SELECT COALESCE(MAX(id), 0) + 1 as new_id FROM daily_assignments_current`
        );
        const newId = maxIdResult.rows[0].new_id;

        await client.query(`
          INSERT INTO daily_assignments_current (
            id, work_date, cleaner_id, task_id, logistic_code, client_id,
            premium, address, lat, lng, cleaning_time, base_cleaning_time,
            checkin_date, checkout_date, checkin_time, checkout_time,
            pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
            type_apt, alias, customer_name, customer_reference, reasons, priority,
            start_time, end_time, followup, sequence, travel_time
          )
          SELECT 
            $7, $1, $2, task_id, logistic_code, client_id,
            premium, address, lat, lng, $3, $4,
            checkin_date, checkout_date, checkin_time, checkout_time,
            pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
            type_apt, alias, customer_name, customer_reference, reasons, priority,
            NULL, NULL, followup, $5, 0
          FROM daily_assignments_current
          WHERE work_date = $1 AND task_id = $6 
          LIMIT 1
        `, [workDate, Number(cleanerId), effectiveCleaningTime, baseCleaningTime, newSequence, taskId, newId]);

        // 8. Aggiorna cleaning_time per tutti i collaboratori esistenti
        await client.query(
          `UPDATE daily_assignments_current 
           SET cleaning_time = $1, base_cleaning_time = $2
           WHERE work_date = $3 AND task_id = $4`,
          [effectiveCleaningTime, baseCleaningTime, workDate, taskId]
        );

        // 9. Ricalcola orari per tutti i cleaners coinvolti
        // Ri-query i collaboratori dal DB per includere anche il primary appena inserito
        const collabResult = await client.query(
          `SELECT cleaner_id FROM task_collaborators WHERE work_date = $1 AND task_id = $2`,
          [workDate, taskId]
        );
        const allCollaboratorIds = collabResult.rows.map((r: any) => r.cleaner_id);
        const overlaps: any[] = [];

        for (const cId of allCollaboratorIds) {
          const tasksResult = await client.query(
            `SELECT task_id, logistic_code, cleaner_id,
                    sequence, cleaning_time, address, lat, lng,
                    start_time, end_time, travel_time, priority,
                    checkout_time, checkin_time
             FROM daily_assignments_current
             WHERE work_date = $1 AND cleaner_id = $2
             ORDER BY sequence`,
            [workDate, cId]
          );

          if (tasksResult.rows.length === 0) continue;

          const cleanerStartTime = await getCleanerStartTime(cId, workDate) || '10:00';

          const cleanerData = {
            cleaner: {
              id: cId,
              start_time: cleanerStartTime
            },
            tasks: tasksResult.rows.map((r: any) => ({
              task_id: r.task_id,
              logistic_code: r.logistic_code,
              sequence: r.sequence,
              cleaning_time: r.cleaning_time,
              address: r.address,
              lat: r.lat,
              lng: r.lng,
              start_time: r.start_time,
              end_time: r.end_time,
              travel_time: r.travel_time,
              priority: r.priority ?? null,
              checkout_time: r.checkout_time ?? null,
              checkin_time: r.checkin_time ?? null,
            }))
          };

          // Ricalcola usando il Python script (calcoli accurati)
          const updatedCleanerData = await recalculateCleanerTimes(cleanerData, workDate);

          // Valida overlap
          const recalculatedTasks = updatedCleanerData.tasks || [];
          const overlapCheck = validateOverlap(recalculatedTasks.map((t: any) => ({
            taskId: String(t.task_id),
            startTime: t.start_time,
            endTime: t.end_time
          })), cId);

          if (overlapCheck.hasOverlap) {
            overlaps.push(overlapCheck);
          }

          // Aggiorna gli orari nel DB
          for (const task of recalculatedTasks) {
            await client.query(
              `UPDATE daily_assignments_current 
               SET start_time = $1, end_time = $2, travel_time = $3
               WHERE work_date = $4 AND cleaner_id = $5 AND task_id = $6`,
              [task.start_time, task.end_time, task.travel_time, workDate, cId, task.task_id]
            );
          }
        }

        // 10. Se ci sono overlap, rollback e restituisci 409
        if (overlaps.length > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            success: false,
            error: "Collisione oraria rilevata",
            overlaps
          });
        }

        await client.query('COMMIT');

        console.log(`✅ Collaboratore ${cleanerId} aggiunto a task ${taskId} (${newCollabCount} totali, ${effectiveCleaningTime}min ciascuno)${wasAutoSummoned ? ' [AUTO-CONVOCATO]' : ''}`);
        res.json({
          success: true,
          taskId,
          cleanerId: Number(cleanerId),
          collaboratorCount: newCollabCount,
          effectiveCleaningTime,
          baseCleaningTime,
          primaryCleanerId,
          wasAutoSummoned
        });

      } catch (error: any) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

    } catch (error: any) {
      console.error("Errore nell'aggiunta collaboratore:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/tasks/:taskId/collaborators/assign - Caso B: assegna N collaboratori da containers
  app.post("/api/tasks/:taskId/collaborators/assign", async (req, res) => {
    try {
      const taskId = parseInt(req.params.taskId, 10);
      const { date, cleanerIds } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");

      if (isNaN(taskId)) {
        return res.status(400).json({ success: false, error: "taskId deve essere un numero" });
      }
      if (!cleanerIds || !Array.isArray(cleanerIds) || cleanerIds.length === 0) {
        return res.status(400).json({ success: false, error: "cleanerIds array richiesto" });
      }

      const pool = (await import("../shared/pg-db")).default;
      const { recomputeSchedule, validateOverlap } = await import("./schedule/recompute");

      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        // 1. Verifica che il task NON sia già in timeline
        const existingTask = await client.query(
          `SELECT 1 FROM daily_assignments_current 
           WHERE work_date = $1 AND task_id = $2 LIMIT 1`,
          [workDate, taskId]
        );

        if (existingTask.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ 
            success: false, 
            error: "Task già presente in timeline. Usa /add per aggiungere collaboratori." 
          });
        }

        // 2. Carica il task dai containers
        const containerTask = await client.query(
          `SELECT * FROM daily_containers 
           WHERE work_date = $1 AND task_id = $2 LIMIT 1`,
          [workDate, taskId]
        );

        if (containerTask.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ success: false, error: "Task non trovato nei containers" });
        }

        const sourceTask = containerTask.rows[0];
        const baseCleaningTime = sourceTask.cleaning_time || 60;
        const collaboratorCount = cleanerIds.length;
        const effectiveCleaningTime = Math.ceil(baseCleaningTime / collaboratorCount);

        // 2.5 AUTO-CONVOCAZIONE: Aggiungi atomicamente cleaners non convocati ai selected_cleaners
        // Usa UPSERT con ON CONFLICT per evitare race conditions anche quando la riga non esiste
        const selectedScope = resolveScopeFromReq(req);
        const selectedCleanersResult = await client.query(
          `SELECT cleaners
           FROM daily_selected_cleaners
           WHERE work_date = $1 AND scope = $2
           FOR UPDATE`,
          [workDate, selectedScope]
        );
        let currentSelectedCleaners: number[] = selectedCleanersResult.rows[0]?.cleaners || [];
        const autoSummonedCleaners: number[] = [];
        
        for (const cId of cleanerIds) {
          if (!currentSelectedCleaners.includes(Number(cId))) {
            autoSummonedCleaners.push(Number(cId));
          }
        }
        
        if (autoSummonedCleaners.length > 0) {
          console.log(`🆕 Auto-convocazione ${autoSummonedCleaners.length} cleaners per ${workDate}: ${autoSummonedCleaners.join(', ')}`);
          
          // UPSERT atomico: INSERT con ON CONFLICT per gestire sia create che update
          await client.query(
            `INSERT INTO daily_selected_cleaners (work_date, scope, cleaners, updated_at)
             VALUES ($1, $3, $2::integer[], NOW())
             ON CONFLICT (work_date, scope) DO UPDATE 
             SET cleaners = ARRAY(SELECT DISTINCT unnest(array_cat(daily_selected_cleaners.cleaners, $2::integer[]))),
                 updated_at = NOW()`,
            [workDate, autoSummonedCleaners, selectedScope]
          );
          console.log(`✅ ${autoSummonedCleaners.length} cleaners aggiunti ai selected_cleaners per ${workDate}`);
        }

        // 3. Inserisci pivot per ogni cleaner (il primo è primary)
        for (let i = 0; i < cleanerIds.length; i++) {
          const cId = cleanerIds[i];
          const isPrimary = i === 0; // Il primo cleaner selezionato è il primary
          await client.query(
            `INSERT INTO task_collaborators (work_date, task_id, cleaner_id, is_primary)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (work_date, task_id, cleaner_id) DO UPDATE SET is_primary = $4`,
            [workDate, taskId, Number(cId), isPrimary]
          );
        }
        console.log(`✅ Primo cleaner (${cleanerIds[0]}) impostato come primary per task ${taskId}`);

        // 4. Crea N righe in daily_assignments_current (una per cleaner)
        const overlaps: any[] = [];

        for (const cId of cleanerIds) {
          // Trova sequence per il cleaner (append in coda)
          const maxSeqResult = await client.query(
            `SELECT COALESCE(MAX(sequence), 0) as max_seq 
             FROM daily_assignments_current 
             WHERE work_date = $1 AND cleaner_id = $2`,
            [workDate, Number(cId)]
          );
          const newSequence = maxSeqResult.rows[0].max_seq + 1;

          // Inserisci la riga
          await client.query(`
            INSERT INTO daily_assignments_current (
              work_date, cleaner_id, task_id, logistic_code, client_id,
              premium, address, lat, lng, cleaning_time, base_cleaning_time,
              checkin_date, checkout_date, checkin_time, checkout_time,
              pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
              type_apt, alias, customer_name, customer_reference, reasons, priority,
              start_time, end_time, followup, sequence, travel_time
            ) VALUES (
              $1, $2, $3, $4, $5,
              $6, $7, $8, $9, $10, $11,
              $12, $13, $14, $15,
              $16, $17, $18, $19, $20, $21,
              $22, $23, $24, $25, $26, $27,
              NULL, NULL, $28, $29, 0
            )
          `, [
            workDate, Number(cId), taskId, sourceTask.logistic_code, sourceTask.client_id,
            sourceTask.premium, sourceTask.address, sourceTask.lat, sourceTask.lng, 
            effectiveCleaningTime, baseCleaningTime,
            sourceTask.checkin_date, sourceTask.checkout_date, sourceTask.checkin_time, sourceTask.checkout_time,
            sourceTask.pax_in, sourceTask.pax_out, sourceTask.small_equipment, 
            sourceTask.operation_id, sourceTask.confirmed_operation, isTaskEquivalentToStraordinaria(sourceTask),
            sourceTask.type_apt, sourceTask.alias, sourceTask.customer_name, sourceTask.customer_reference,
            sourceTask.reasons || [], sourceTask.priority,
            sourceTask.followup, newSequence
          ]);
        }

        // 5. Ricalcola orari per ogni cleaner usando Python script (calcoli accurati)
        for (const cId of cleanerIds) {
          const tasksResult = await client.query(
            `SELECT task_id, logistic_code, cleaner_id,
                    sequence, cleaning_time, address, lat, lng,
                    start_time, end_time, travel_time, priority,
                    checkout_time, checkin_time
             FROM daily_assignments_current
             WHERE work_date = $1 AND cleaner_id = $2
             ORDER BY sequence`,
            [workDate, Number(cId)]
          );

          if (tasksResult.rows.length === 0) continue;

          const cleanerStartTime = await getCleanerStartTime(Number(cId), workDate) || '10:00';
          
          const cleanerData = {
            cleaner: {
              id: Number(cId),
              start_time: cleanerStartTime
            },
            tasks: tasksResult.rows.map((r: any) => ({
              task_id: r.task_id,
              logistic_code: r.logistic_code,
              sequence: r.sequence,
              cleaning_time: r.cleaning_time,
              address: r.address,
              lat: r.lat,
              lng: r.lng,
              start_time: r.start_time,
              end_time: r.end_time,
              travel_time: r.travel_time,
              priority: r.priority ?? null,
              checkout_time: r.checkout_time ?? null,
              checkin_time: r.checkin_time ?? null,
            }))
          };

          const updatedCleanerData = await recalculateCleanerTimes(cleanerData, workDate);
          const recalculatedTasks = updatedCleanerData.tasks || [];

          const overlapCheck = validateOverlap(recalculatedTasks.map((t: any) => ({
            taskId: String(t.task_id),
            startTime: t.start_time,
            endTime: t.end_time
          })), Number(cId));

          if (overlapCheck.hasOverlap) {
            overlaps.push(overlapCheck);
          }

          for (const task of recalculatedTasks) {
            await client.query(
              `UPDATE daily_assignments_current 
               SET start_time = $1, end_time = $2, travel_time = $3
               WHERE work_date = $4 AND cleaner_id = $5 AND task_id = $6`,
              [task.start_time, task.end_time, task.travel_time, workDate, Number(cId), task.task_id]
            );
          }
        }

        // 6. Se ci sono overlap, rollback e restituisci 409
        if (overlaps.length > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            success: false,
            error: "Collisione oraria rilevata",
            overlaps
          });
        }

        // 7. Rimuovi il task dai containers
        await client.query(
          `DELETE FROM daily_containers WHERE work_date = $1 AND task_id = $2`,
          [workDate, taskId]
        );

        await client.query('COMMIT');

        console.log(`✅ Task ${taskId} assegnato a ${collaboratorCount} cleaners (${effectiveCleaningTime}min ciascuno)${autoSummonedCleaners.length > 0 ? ` [AUTO-CONVOCATI: ${autoSummonedCleaners.join(',')}]` : ''}`);
        res.json({
          success: true,
          taskId,
          cleanerIds: cleanerIds.map(Number),
          collaboratorCount,
          effectiveCleaningTime,
          baseCleaningTime,
          autoSummonedCleaners
        });

      } catch (error: any) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

    } catch (error: any) {
      console.error("Errore nell'assegnazione collaboratori:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/tasks/:taskId/collaborators/remove - Rimuovi collaboratore
  app.post("/api/tasks/:taskId/collaborators/remove", async (req, res) => {
    try {
      const taskId = parseInt(req.params.taskId, 10);
      const { date, cleanerId } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");

      if (isNaN(taskId)) {
        return res.status(400).json({ success: false, error: "taskId deve essere un numero" });
      }
      if (!cleanerId || isNaN(Number(cleanerId))) {
        return res.status(400).json({ success: false, error: "cleanerId richiesto" });
      }

      const pool = (await import("../shared/pg-db")).default;
      const { taskCollaborationService } = await import("./services/pg-task-collaboration-service");
      const { recomputeSchedule, validateOverlap } = await import("./schedule/recompute");

      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        // 1. Verifica collaborazione esistente
        const existingCollaboration = await taskCollaborationService.getCollaboration(workDate, taskId);

        if (!existingCollaboration.cleanerIds.includes(Number(cleanerId))) {
          await client.query('ROLLBACK');
          return res.status(404).json({ 
            success: false, 
            error: "Il cleaner non è un collaboratore di questa task" 
          });
        }

        // 2. Ottieni base_cleaning_time dalla riga esistente
        const existingRow = await client.query(
          `SELECT base_cleaning_time, cleaning_time FROM daily_assignments_current 
           WHERE work_date = $1 AND task_id = $2 LIMIT 1`,
          [workDate, taskId]
        );
        const baseCleaningTime = existingRow.rows[0]?.base_cleaning_time || existingRow.rows[0]?.cleaning_time || 60;

        // 3. Rimuovi il pivot
        await client.query(
          `DELETE FROM task_collaborators 
           WHERE work_date = $1 AND task_id = $2 AND cleaner_id = $3`,
          [workDate, taskId, Number(cleanerId)]
        );

        // 4. Rimuovi la riga dalla timeline
        await client.query(
          `DELETE FROM daily_assignments_current 
           WHERE work_date = $1 AND task_id = $2 AND cleaner_id = $3`,
          [workDate, taskId, Number(cleanerId)]
        );

        // 5. Conta collaboratori rimanenti
        const remainingResult = await client.query(
          `SELECT cleaner_id FROM task_collaborators 
           WHERE work_date = $1 AND task_id = $2`,
          [workDate, taskId]
        );
        const remainingCount = remainingResult.rows.length;
        const remainingCleanerIds = remainingResult.rows.map((r: any) => r.cleaner_id);

        // 6. Se rimane 1 solo cleaner, elimina pivot (non più collaborativo)
        if (remainingCount === 1) {
          await client.query(
            `DELETE FROM task_collaborators WHERE work_date = $1 AND task_id = $2`,
            [workDate, taskId]
          );
          // Aggiorna cleaning_time al valore base
          await client.query(
            `UPDATE daily_assignments_current 
             SET cleaning_time = base_cleaning_time
             WHERE work_date = $1 AND task_id = $2`,
            [workDate, taskId]
          );
        } else if (remainingCount > 1) {
          // Ricalcola durata effettiva per i rimanenti
          const newEffectiveTime = Math.ceil(baseCleaningTime / remainingCount);
          await client.query(
            `UPDATE daily_assignments_current 
             SET cleaning_time = $1
             WHERE work_date = $2 AND task_id = $3`,
            [newEffectiveTime, workDate, taskId]
          );
        }

        // 7. Ricalcola orari per i cleaners rimanenti + quello rimosso
        const allAffectedCleaners = [...remainingCleanerIds, Number(cleanerId)];
        const overlaps: any[] = [];

        for (const cId of allAffectedCleaners) {
          const tasksResult = await client.query(
            `SELECT task_id, logistic_code, cleaner_id,
                    sequence, cleaning_time, address, lat, lng,
                    start_time, end_time, travel_time, priority,
                    checkout_time, checkin_time
             FROM daily_assignments_current
             WHERE work_date = $1 AND cleaner_id = $2
             ORDER BY sequence`,
            [workDate, cId]
          );

          if (tasksResult.rows.length === 0) continue;

          const cleanerStartTime = await getCleanerStartTime(cId, workDate) || '10:00';
          
          const cleanerData = {
            cleaner: { id: cId, start_time: cleanerStartTime },
            tasks: tasksResult.rows.map((r: any) => ({
              task_id: r.task_id,
              logistic_code: r.logistic_code,
              sequence: r.sequence,
              cleaning_time: r.cleaning_time,
              address: r.address,
              lat: r.lat,
              lng: r.lng,
              start_time: r.start_time,
              end_time: r.end_time,
              travel_time: r.travel_time,
              priority: r.priority ?? null,
              checkout_time: r.checkout_time ?? null,
              checkin_time: r.checkin_time ?? null,
            }))
          };

          const updatedCleanerData = await recalculateCleanerTimes(cleanerData, workDate);
          const recalculatedTasks = updatedCleanerData.tasks || [];

          const overlapCheck = validateOverlap(recalculatedTasks.map((t: any) => ({
            taskId: String(t.task_id),
            startTime: t.start_time,
            endTime: t.end_time
          })), cId);

          if (overlapCheck.hasOverlap) {
            overlaps.push(overlapCheck);
          }

          for (const task of recalculatedTasks) {
            await client.query(
              `UPDATE daily_assignments_current 
               SET start_time = $1, end_time = $2, travel_time = $3
               WHERE work_date = $4 AND cleaner_id = $5 AND task_id = $6`,
              [task.start_time, task.end_time, task.travel_time, workDate, cId, task.task_id]
            );
          }
        }

        // 8. Se overlap sui rimanenti, rollback (nota: non dovrebbe succedere rimuovendo)
        if (overlaps.length > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            success: false,
            error: "Collisione oraria rilevata dopo rimozione",
            overlaps
          });
        }

        await client.query('COMMIT');

        console.log(`✅ Collaboratore ${cleanerId} rimosso da task ${taskId} (${remainingCount} rimanenti)`);
        res.json({
          success: true,
          taskId,
          removedCleanerId: Number(cleanerId),
          remainingCount,
          remainingCleanerIds,
          isCollaborative: remainingCount > 1
        });

      } catch (error: any) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

    } catch (error: any) {
      console.error("Errore nella rimozione collaboratore:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/tasks/:taskId/collaborators/dissolve - Dissolvi TUTTA la collaborazione e riporta task nei containers
  app.post("/api/tasks/:taskId/collaborators/dissolve", async (req, res) => {
    try {
      const taskId = parseInt(req.params.taskId, 10);
      const { date } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");

      if (isNaN(taskId)) {
        return res.status(400).json({ success: false, error: "taskId deve essere un numero" });
      }

      const pool = (await import("../shared/pg-db")).default;
      const { taskCollaborationService } = await import("./services/pg-task-collaboration-service");
      const { recomputeSchedule } = await import("./schedule/recompute");
      const { refreshContainersFromAdam } = await import("./services/containers-refresh-service");

      // Verifica collaborazione
      const existingCollaboration = await taskCollaborationService.getCollaboration(workDate, taskId);

      if (existingCollaboration.count < 2) {
        return res.status(400).json({ 
          success: false, 
          error: "La task non è in collaborazione" 
        });
      }

      // Ottieni dati base dalla timeline
      const preClient = await pool.connect();
      let logisticCode: number;
      let priority: string;
      let originalDuration: number;
      let affectedCleaners: number[];
      
      try {
        const taskDataResult = await preClient.query(
          `SELECT task_id, logistic_code, base_cleaning_time, cleaning_time, priority
           FROM daily_assignments_current 
           WHERE work_date = $1 AND task_id = $2 
           LIMIT 1`,
          [workDate, taskId]
        );

        if (taskDataResult.rows.length === 0) {
          return res.status(404).json({ success: false, error: "Task non trovata in timeline" });
        }

        const taskData = taskDataResult.rows[0];
        logisticCode = taskData.logistic_code;
        priority = taskData.priority || 'high_priority';
        originalDuration = taskData.base_cleaning_time || taskData.cleaning_time;
        affectedCleaners = existingCollaboration.cleanerIds;
      } finally {
        preClient.release();
      }

      // Transazione atomica: elimina collaboratori e assegnazioni, ricalcola orari
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        // 1. Elimina collaboratori
        await client.query(
          `DELETE FROM task_collaborators WHERE work_date = $1 AND task_id = $2`,
          [workDate, taskId]
        );

        // 2. Elimina assegnazioni dalla timeline
        await client.query(
          `DELETE FROM daily_assignments_current WHERE work_date = $1 AND task_id = $2`,
          [workDate, taskId]
        );

        // 3. Ricalcola orari per i cleaners coinvolti usando Python script
        for (const cleanerId of affectedCleaners) {
          const tasksResult = await client.query(
            `SELECT task_id, logistic_code, cleaner_id,
                    sequence, cleaning_time, address, lat, lng,
                    start_time, end_time, travel_time, priority,
                    checkout_time, checkin_time
             FROM daily_assignments_current
             WHERE work_date = $1 AND cleaner_id = $2
             ORDER BY sequence`,
            [workDate, cleanerId]
          );

          if (tasksResult.rows.length === 0) continue;

          let seq = 1;
          for (const task of tasksResult.rows) {
            await client.query(
              `UPDATE daily_assignments_current 
               SET sequence = $1, followup = $2
               WHERE work_date = $3 AND cleaner_id = $4 AND task_id = $5`,
              [seq, seq > 1, workDate, cleanerId, task.task_id]
            );
            task.sequence = seq;
            seq++;
          }

          const cleanerStartTime = await getCleanerStartTime(cleanerId, workDate) || '10:00';
          
          const cleanerData = {
            cleaner: { id: cleanerId, start_time: cleanerStartTime },
            tasks: tasksResult.rows.map((r: any) => ({
              task_id: r.task_id,
              logistic_code: r.logistic_code,
              sequence: r.sequence,
              cleaning_time: r.cleaning_time,
              address: r.address,
              lat: r.lat,
              lng: r.lng,
              start_time: r.start_time,
              end_time: r.end_time,
              travel_time: r.travel_time,
              priority: r.priority ?? null,
              checkout_time: r.checkout_time ?? null,
              checkin_time: r.checkin_time ?? null,
            }))
          };

          const updatedCleanerData = await recalculateCleanerTimes(cleanerData, workDate);
          const recalculatedTasks = updatedCleanerData.tasks || [];

          for (const task of recalculatedTasks) {
            await client.query(
              `UPDATE daily_assignments_current 
               SET start_time = $1, end_time = $2, travel_time = $3
               WHERE work_date = $4 AND cleaner_id = $5 AND task_id = $6`,
              [task.start_time, task.end_time, task.travel_time, workDate, cleanerId, task.task_id]
            );
          }
        }

        await client.query('COMMIT');
        console.log(`✅ Collaborazione dissolta per task ${taskId}: ${affectedCleaners.length} cleaners coinvolti`);

      } catch (error: any) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      // Dopo COMMIT: refresh containers da ADAM (fuori dalla transazione)
      console.log(`🔄 Dissolve: Refresh containers da ADAM per ${workDate}...`);
      const refreshResult = await refreshContainersFromAdam(workDate, 'dissolve_collaboration');
      
      if (!refreshResult.success) {
        console.warn(`⚠️ Dissolve: Refresh containers fallito, la task potrebbe non apparire nei containers`);
      }

      res.json({
        success: true,
        taskId,
        logisticCode,
        originalDuration,
        priority,
        affectedCleaners,
        containersRefreshed: refreshResult.success,
        message: `Collaborazione dissolta, containers aggiornati da ADAM`
      });

    } catch (error: any) {
      console.error("Errore nella dissoluzione collaborazione:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per aggiornare i dettagli di una task (checkout, checkin, durata)
  // skipAdam: se true, aggiorna SOLO PostgreSQL e non propaga su ADAM
  // Supporta sia aggiornamenti singoli che batch (array di updates)
  app.post("/api/update-task-details", async (req, res) => {
    try {
      // Supporto per batch updates (array di updates)
      if (req.body.updates && Array.isArray(req.body.updates)) {
        const updates = req.body.updates;
        const skipAdam = req.body.skipAdam || false;
        const results: { taskId: string; success: boolean; error?: string }[] = [];
        
        // Raggruppa updates per data per ottimizzare i salvataggi
        const updatesByDate = new Map<string, typeof updates>();
        for (const update of updates) {
          const workDate = update.date || format(new Date(), 'yyyy-MM-dd');
          if (!updatesByDate.has(workDate)) {
            updatesByDate.set(workDate, []);
          }
          updatesByDate.get(workDate)!.push(update);
        }
        
        // Apri connessione MySQL una sola volta (se non skipAdam)
        let mysqlConnection: any = null;
        if (!skipAdam) {
          try {
            const mysql = await import('mysql2/promise');
            mysqlConnection = await mysql.createConnection({
              host: databaseConfig.mysql.host,
              port: databaseConfig.mysql.port,
              user: databaseConfig.mysql.user,
              password: databaseConfig.mysql.password,
              database: databaseConfig.mysql.database,
            });
          } catch (dbError: any) {
            console.warn(`⚠️ Connessione ADAM non disponibile: ${dbError.message}`);
          }
        }
        
        // Processa ogni data
        for (const [workDate, dateUpdates] of Array.from(updatesByDate.entries())) {
          try {
            // Carica containers una volta per data
            const containersData = await workspaceFiles.loadContainers(workDate, resolveScopeFromReq(req)) || { containers: {} };
            let anyUpdated = false;
            
            for (const update of dateUpdates) {
              const { taskId, operationId } = update;
              if (!taskId) {
                results.push({ taskId: 'unknown', success: false, error: 'taskId richiesto' });
                continue;
              }
              
              let taskUpdated = false;
              
              // Aggiorna nei containers
              if (containersData.containers) {
                for (const containerType of ['early_out', 'high_priority', 'low_priority']) {
                  const container = (containersData.containers as any)[containerType];
                  if (container?.tasks) {
                    for (const task of container.tasks) {
                      if (String(task.task_id) === String(taskId)) {
                        if (operationId !== undefined) {
                          task.operation_id = operationId;
                          task.confirmed_operation = true;
                          task.straordinaria = operationId === CONTINUAZIONE_PS_OPERATION_ID || Boolean(task.straordinaria);
                        }
                        taskUpdated = true;
                        anyUpdated = true;
                        break;
                      }
                    }
                  }
                  if (taskUpdated) break;
                }
              }
              
              if (taskUpdated) {
                // Propaga su ADAM se connessione disponibile
                if (mysqlConnection && operationId !== undefined) {
                  try {
                    await mysqlConnection.execute(
                      'UPDATE app_housekeeping SET operation_id = ? WHERE id = ?',
                      [operationId, taskId]
                    );
                    console.log(`✅ Task ${taskId} operation_id aggiornato su ADAM: ${operationId}`);
                  } catch (dbError: any) {
                    console.error(`⚠️ Errore ADAM per task ${taskId}:`, dbError.message);
                  }
                }
                results.push({ taskId: String(taskId), success: true });
              } else {
                results.push({ taskId: String(taskId), success: false, error: 'Task non trovata' });
              }
            }
            
            // Salva containers una volta per data (se qualcosa è stato aggiornato)
            if (anyUpdated) {
              await workspaceFiles.saveContainers(workDate, containersData, 'system', 'manual', resolveScopeFromReq(req));
            }
          } catch (err: any) {
            for (const update of dateUpdates) {
              results.push({ taskId: String(update.taskId || 'unknown'), success: false, error: err.message });
            }
          }
        }
        
        // Chiudi connessione MySQL
        if (mysqlConnection) {
          try {
            await mysqlConnection.end();
          } catch (e) {}
        }
        
        const successCount = results.filter(r => r.success).length;
        console.log(`✅ Batch update completato: ${successCount}/${updates.length} task aggiornate`);
        return res.json({ 
          success: successCount > 0, 
          message: `${successCount}/${updates.length} task aggiornate`,
          results 
        });
      }
      
      // Singolo update (comportamento originale)
      const { taskId, logisticCode, checkoutDate, checkoutTime, checkinDate, checkinTime, cleaningTime, paxIn, paxOut, operationId, date, modified_by, skipAdam } = req.body;

      if (!taskId && !logisticCode) {
        return res.status(400).json({ success: false, error: "taskId o logisticCode richiesto" });
      }

      const workDate = date || format(new Date(), 'yyyy-MM-dd');
      const currentUsername = modified_by || getCurrentUsername(req);

      // Carica entrambi da PostgreSQL
      const [containersData, timelineData] = await Promise.all([
        workspaceFiles.loadContainers(workDate, resolveScopeFromReq(req)).then(d => d || { containers: {} }),
        workspaceFiles.loadTimeline(workDate, resolveScopeFromReq(req)).then(d => d || { cleaners_assignments: [] })
      ]);

      let taskUpdated = false;
      let editedFields: string[] = [];
      let oldValues: string[] = [];
      let newValues: string[] = [];

      // Funzione helper per aggiornare una task - SOLO i campi forniti
      // Traccia anche le modifiche per la history
      const updateTask = (task: any) => {
        if (String(task.task_id) === String(taskId) || String(task.logistic_code) === String(logisticCode)) {
          // Traccia le modifiche prima di applicarle
          if (checkoutDate !== undefined && task.checkout_date !== checkoutDate) {
            editedFields.push('checkout_date');
            oldValues.push(String(task.checkout_date ?? 'null'));
            newValues.push(String(checkoutDate));
            task.checkout_date = checkoutDate;
          }
          if (checkoutTime !== undefined && task.checkout_time !== checkoutTime) {
            editedFields.push('checkout_time');
            oldValues.push(String(task.checkout_time ?? 'null'));
            newValues.push(String(checkoutTime));
            task.checkout_time = checkoutTime;
          }
          if (checkinDate !== undefined && task.checkin_date !== checkinDate) {
            editedFields.push('checkin_date');
            oldValues.push(String(task.checkin_date ?? 'null'));
            newValues.push(String(checkinDate));
            task.checkin_date = checkinDate;
          }
          if (checkinTime !== undefined && task.checkin_time !== checkinTime) {
            editedFields.push('checkin_time');
            oldValues.push(String(task.checkin_time ?? 'null'));
            newValues.push(String(checkinTime));
            task.checkin_time = checkinTime;
          }
          if (cleaningTime !== undefined && task.cleaning_time !== cleaningTime) {
            editedFields.push('cleaning_time');
            oldValues.push(String(task.cleaning_time ?? 'null'));
            newValues.push(String(cleaningTime));
            task.cleaning_time = cleaningTime;
          }
          if (paxIn !== undefined && task.pax_in !== paxIn) {
            editedFields.push('pax_in');
            oldValues.push(String(task.pax_in ?? 'null'));
            newValues.push(String(paxIn));
            task.pax_in = paxIn;
          }
          if (paxOut !== undefined && task.pax_out !== paxOut) {
            editedFields.push('pax_out');
            oldValues.push(String(task.pax_out ?? 'null'));
            newValues.push(String(paxOut));
            task.pax_out = paxOut;
          }
          if (operationId !== undefined && task.operation_id !== operationId) {
            editedFields.push('operation_id');
            oldValues.push(String(task.operation_id ?? 'null'));
            newValues.push(String(operationId));
            task.operation_id = operationId;
            task.straordinaria = operationId === CONTINUAZIONE_PS_OPERATION_ID || Boolean(task.straordinaria);
          }
          taskUpdated = true;
          return true;
        }
        return false;
      };

      // Aggiorna nei containers
      if (containersData.containers) {
        for (const containerType of ['early_out', 'high_priority', 'low_priority']) {
          const container = containersData.containers[containerType];
          if (container?.tasks) {
            container.tasks.forEach(updateTask);
          }
        }
      }

      // Aggiorna in timeline
      if (timelineData.cleaners_assignments) {
        for (const cleanerEntry of timelineData.cleaners_assignments) {
          if (cleanerEntry.tasks) {
            cleanerEntry.tasks.forEach(updateTask);
          }
        }
      }

      if (!taskUpdated) {
        return res.status(404).json({ success: false, error: "Task non trovata" });
      }

      // Prepara opzioni di tracking per history
      const editOptions = editedFields.length > 0 ? {
        editedField: editedFields.join(', '),
        oldValue: oldValues.join(', '),
        newValue: newValues.join(', ')
      } : undefined;

      // Salva containers (PostgreSQL)
      await workspaceFiles.saveContainers(workDate, containersData, 'system', 'manual', resolveScopeFromReq(req));
      
      // Salva timeline con tracking delle modifiche (skipRevision=false per creare revision in PostgreSQL)
      await workspaceFiles.saveTimeline(workDate, timelineData, false, currentUsername, 'task_edit', editOptions, resolveScopeFromReq(req));

      // CRITICAL: Propaga le modifiche al database ADAM (app_housekeeping)
      // SOLO se skipAdam non è true
      if (taskId && !skipAdam) {
        try {
          const mysql = await import('mysql2/promise');
          const connection = await mysql.createConnection({
            host: databaseConfig.mysql.host,
            port: databaseConfig.mysql.port,
            user: databaseConfig.mysql.user,
            password: databaseConfig.mysql.password,
            database: databaseConfig.mysql.database,
          });

          // Costruisci query UPDATE dinamica (aggiorna solo i campi forniti)
          const updates: string[] = [];
          const values: any[] = [];

          if (checkoutDate !== undefined) {
            updates.push('checkout = ?');
            values.push(checkoutDate);
          }
          if (checkoutTime !== undefined) {
            updates.push('checkout_time = ?');
            values.push(checkoutTime);
          }
          if (checkinDate !== undefined) {
            updates.push('checkin = ?');
            values.push(checkinDate);
          }
          if (checkinTime !== undefined) {
            updates.push('checkin_time = ?');
            values.push(checkinTime);
          }
          if (paxIn !== undefined) {
            updates.push('checkin_pax = ?');
            values.push(paxIn);
          }
          if (operationId !== undefined) {
            updates.push('operation_id = ?');
            values.push(operationId);
          }

          if (updates.length > 0) {
            values.push(taskId); // WHERE id = ?
            
            // Aggiorna SOLO app_housekeeping
            const query = `UPDATE app_housekeeping SET ${updates.join(', ')} WHERE id = ?`;
            await connection.execute(query, values);
            console.log(`✅ Task ${logisticCode} aggiornata su app_housekeeping`);

            await connection.end();
          }
        } catch (dbError: any) {
          console.error('⚠️ Errore aggiornamento database ADAM:', dbError.message);
          // Non bloccare la risposta, PostgreSQL è comunque salvato
        }
      }

      console.log(`✅ Task ${logisticCode} aggiornata con successo`);
      res.json({ success: true, message: "Task aggiornata con successo" });
    } catch (error: any) {
      console.error("Errore nell'aggiornamento della task:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // GET statistiche task per convocazioni (logica in Node, niente script né file)
  app.get("/api/convocazioni-task-stats", async (req, res) => {
    const dateParam = (req.query.date as string) || format(new Date(), "yyyy-MM-dd");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      return res.status(400).json({ success: false, error: "Parametro date richiesto (yyyy-MM-dd)" });
    }
    let connection: any = null;
    try {
      connection = await mysql.createConnection({
        host: databaseConfig.mysql.host,
        port: databaseConfig.mysql.port,
        user: databaseConfig.mysql.user,
        password: databaseConfig.mysql.password,
        database: databaseConfig.mysql.database,
      });
      const [opRows]: any = await connection.execute(
        `SELECT id FROM app_structure_operation WHERE active = 1 AND enable_wass = 1`
      );
      const activeOpIds = (Array.isArray(opRows) ? opRows : [])
        .map((r: any) => Number(r?.id))
        .filter((n: number) => Number.isFinite(n));
      const placeholders = activeOpIds.length > 0
        ? activeOpIds.map(() => "?").join(",")
        : "";
      const opCondition = activeOpIds.length > 0
        ? `AND (h.operation_id IN (${placeholders}) OR h.operation_id IS NULL OR h.operation_id = 0)`
        : "";
      const params: any[] = [dateParam];
      if (activeOpIds.length > 0) params.push(...activeOpIds);
      const [rows]: any = await connection.execute(
        `SELECT h.id AS task_id, s.premium, h.operation_id
         FROM app_housekeeping h
         JOIN app_structures s ON h.structure_id = s.id
         WHERE h.checkout = ?
           AND h.deleted_at IS NULL
           AND h.deleted_at_client IS NULL
           AND s.lat IS NOT NULL AND s.lng IS NOT NULL
           AND s.lat != '' AND s.lng != ''
           AND s.lat != '0' AND s.lng != '0'
         ${opCondition}`,
        params
      );
      const list = Array.isArray(rows) ? rows : [];
      const task_stats = {
        total: 0,
        premium: 0,
        standard: 0,
        straordinarie: 0,
      };
      for (const r of list) {
        const premium = r?.premium === 1 || r?.premium === true || r?.premium === "1";
        const opId = r?.operation_id != null ? Number(r.operation_id) : null;
        task_stats.total += 1;
        if (premium) task_stats.premium += 1;
        else task_stats.standard += 1;
        if (opId === 3 || opId === CONTINUAZIONE_PS_OPERATION_ID) task_stats.straordinarie += 1;
      }
      res.json({
        success: true,
        task_stats,
        metadata: { date: dateParam, last_updated: getRomeTimestamp() },
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error?.message || "Server error",
      });
    } finally {
      if (connection) {
        try {
          await connection.end();
        } catch {
          // ignore
        }
      }
    }
  });

// =====================================================
// ENDPOINT
// =====================================================
app.post("/api/transfer-to-adam", async (req, res) => {
  // Questo helper dipende dall'endpoint (ok tenerlo qui)
  const formatDateForMySQL = (dateValue?: string | null): string | null => {
    if (!dateValue) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return dateValue;
    if (dateValue.includes("T")) return dateValue.split("T")[0];
    try {
      const d = new Date(dateValue);
      if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
    } catch {
      // ignore
    }
    return null;
  };

  /** Formatta un orario per MySQL TIME (HH:MM:SS o HH:MM). Accetta stringa, Date o null. */
  const formatTimeForMySQL = (timeValue?: string | Date | null): string | null => {
    if (timeValue == null || timeValue === '') return null;
    if (typeof timeValue === 'string') {
      const trimmed = timeValue.trim();
      if (!trimmed) return null;
      // Già in formato HH:MM o HH:MM:SS
      if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(trimmed)) {
        const parts = trimmed.split(':');
        return parts.length === 2 ? `${parts[0].padStart(2, '0')}:${parts[1]}:00` : trimmed;
      }
      return null;
    }
    if (timeValue instanceof Date && !isNaN(timeValue.getTime())) {
      const h = timeValue.getHours();
      const m = timeValue.getMinutes();
      const s = timeValue.getSeconds();
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return null;
  };

  try {
    const { date, username: reqUsername, pendingTaskEdits = {} } = req.body;
    const workDate = date || format(new Date(), "yyyy-MM-dd");
    const username = reqUsername || "system";

    console.log(`🔄 Trasferimento assegnazioni a ADAM per ${workDate}...`);

    if (Object.keys(pendingTaskEdits).length > 0) {
      console.log(
        `💾 Ricevute ${Object.keys(pendingTaskEdits).length} task modificate (già salvate dal frontend)`
      );
    }

    // === Carica timeline da PostgreSQL ===
    const timelineData = await workspaceFiles.loadTimeline(workDate, resolveScopeFromReq(req));
    if (!timelineData?.cleaners_assignments?.length) {
      console.log("⚠️ Nessuna assegnazione trovata per il trasferimento");
      return res.json({
        success: false,
        message: "Nessuna assegnazione trovata nella timeline",
      });
    }

    // === Controllo "secondo invio o successivo" (prima di creare la nuova revisione) ===
    const { pgDailyAssignmentsService } = await import(
      "./services/pg-daily-assignments-service"
    );
    const transferCount = await pgDailyAssignmentsService.countTransferToAdamForDate(workDate, resolveScopeFromReq(req));
    const isSecondOrLaterTransfer = transferCount >= 1;

    // === Crea sempre una revision (timestamp transfer) ===
    console.log(`📝 Creazione revision per trasferimento ADAM da utente: ${username}`);
    await pgDailyAssignmentsService.saveToHistory(
      workDate,
      timelineData,
      username,
      "transfer_to_adam",
      [],
      [],
      [],
      resolveScopeFromReq(req)
    );

    // === Utente ADAM (updated_by) ===
    const { pgUsersService } = await import("./services/pg-users-service");
    const userRecord = await pgUsersService.getUserByUsername(username);
    const adamUpdatedBy = userRecord?.adam_id ? `E${userRecord.adam_id}` : username;
    console.log(
      `📝 updated_by per ADAM: ${adamUpdatedBy} (adam_id: ${userRecord?.adam_id || "N/A"})`
    );

    // === Collaborazioni (Fonte di Verità: Postgres) ===
    const { taskCollaborationService } = await import(
      "./services/pg-task-collaboration-service"
    );
    const collaborationsMap = await taskCollaborationService.getCollaborationsMap(workDate);

    // === Connessione MySQL ADAM ===
    let connection: any = null;
    try {
      connection = await mysql.createConnection({
        host: databaseConfig.mysql.host,
        port: databaseConfig.mysql.port,
        user: databaseConfig.mysql.user,
        password: databaseConfig.mysql.password,
        database: databaseConfig.mysql.database,
      });
      console.log("✅ Connessione MySQL ADAM stabilita");
    } catch (dbError: any) {
      console.error("❌ Errore connessione ADAM MySQL:", dbError.message);
      return res.json({
        success: false,
        message: `Errore connessione database ADAM: ${dbError.message}`,
      });
    }

    const processedTaskIds = new Set<number>();
    const assignedTaskIds = new Set<number>();
    for (const cleanerEntry of timelineData.cleaners_assignments) {
      for (const task of cleanerEntry.tasks || []) {
        const tid = Number(task.task_id);
        if (tid) assignedTaskIds.add(tid);
      }
    }

    const containerTaskIds = new Set<number>();
    const containersData = await workspaceFiles.loadContainers(workDate, resolveScopeFromReq(req));
    if (containersData?.containers) {
      for (const key of ['early_out', 'high_priority', 'low_priority']) {
        const bucket = containersData.containers[key];
        if (bucket?.tasks) {
          for (const t of bucket.tasks) {
            const tid = Number(t.task_id);
            if (tid) containerTaskIds.add(tid);
          }
        }
      }
    }

    let totalUpdated = 0;
    let totalCleared = 0;
    let clearErrors = 0;
    const clearErrorDetails: string[] = [];

    // Contatori separati (importante)
    let taskErrors = 0; // errori su UPDATE/cleanup (critici)
    let collaborationErrors = 0; // errori su insert collaboratori (non critici per notifica)
    let legacyCleanupErrors = 0; // errori su cleanup legacy (non critici per notifica)

    const errors: string[] = [];
    const collaborationErrorDetails: string[] = [];
    const legacyCleanupErrorDetails: string[] = [];

    try {
      const workDateFormatted = formatDateForMySQL(workDate);

      for (const cleanerEntry of timelineData.cleaners_assignments) {
        const cleanerId = Number(cleanerEntry.cleaner?.id);
        const tasks = cleanerEntry.tasks || [];

        for (const task of tasks) {
          const taskId = Number(task.task_id); // ✅ IMPORTANTISSIMO
          if (!taskId || processedTaskIds.has(taskId)) continue;
          processedTaskIds.add(taskId);

          const taskLabel = `${taskId}`;

          // ✅ Calcolo collab UNA SOLA VOLTA (fuori dal try interno)
          const collabData = collaborationsMap?.get(taskId);
          const isCollab = (collabData?.cleanerIds?.length ?? 0) > 1;

          const primaryCleanerId =
            (isCollab ? (collabData as any)?.primaryCleanerId : null) ?? cleanerId;

          const collaboratorIds = collabData?.cleanerIds ?? [];
          const secondaryCleanerIds = isCollab
            ? collaboratorIds
                .map((x: any) => Number(x))
                .filter((id: number) => !!id && id !== Number(primaryCleanerId))
            : [];

          // ADAM vuole 1 solo id nel campo collaboration_by
          const secondaryCleanerIdForAdam = secondaryCleanerIds[0] ?? 0;

          console.log("COLLAB CHECK", {
            taskId,
            rawTaskId: task.task_id,
            typeRaw: typeof task.task_id,
            found: !!collabData,
            cleanerIds: collabData?.cleanerIds,
            primary: (collabData as any)?.primaryCleanerId,
            secondaryForAdam: secondaryCleanerIdForAdam,
          });

          try {
            // =====================================================
            // 1️⃣ UPDATE PRINCIPALE app_housekeeping (COMPLETO)
            // =====================================================
            const nowRome = format(new Date(), "yyyy-MM-dd HH:mm:ss");
            const assignedAtUs = nowRome;
            const assignedAtMilliseconds = Date.now();

            const sequence = task.sequence ?? 1;

            const cleanedBy = primaryCleanerId ?? null;

            const collaborationFlag = isCollab ? 1 : null;
            const collaborationBy = isCollab ? (secondaryCleanerIdForAdam || null) : null;
            const collaborationAt = isCollab ? nowRome : null;  
            
            const updateQuery = `
              UPDATE app_housekeeping
              SET
                checkout = ?,
                checkout_time = ?,
                checkin = ?,
                checkin_time = ?,
                checkin_pax = ?,
                operation_id = ?,

                cleaned_by_us = ?,

                sequence = ?,
                updated_by = ?,
                updated_at = ?,
                assigned_at_us = ?,
                assigned_at_milliseconds = ?,

                travel_time = ?,
                start_time = ?,
                end_time = ?,

                collaboration = 0,
                collaboration_by = NULL,
                collaboration_at = NULL,
                collaboration_bypass = 0,

                helpwork = 0,
                helpwork_by = 0,
                helpwork_at = NULL,

                startwork = 0,
                startwork_at = NULL,
                startreport = 0,
                startreport_at = NULL,

                extratimes = ''
              WHERE id = ?
            `;

            const updateValues = [
              formatDateForMySQL(task.checkout_date),
              task.checkout_time ?? null,
              formatDateForMySQL(task.checkin_date),
              task.checkin_time ?? null,
              task.pax_in ?? null,
              task.operation_id ?? null,

              cleanedBy,

              sequence,
              adamUpdatedBy,
              nowRome,
              assignedAtUs,
              assignedAtMilliseconds,

              task.travel_time != null ? Number(task.travel_time) : (task as any).travelTime != null ? Number((task as any).travelTime) : null,
              formatTimeForMySQL(task.start_time ?? (task as any).startTime),
              formatTimeForMySQL(task.end_time ?? (task as any).endTime),

              taskId
            ];

            await connection.execute(updateQuery, updateValues);

            totalUpdated++;
            console.log(
              `✅ UPDATE ADAM OK - Task ${taskLabel}${isCollab ? " 🤝 (collab)" : ""}`
            );

            // =====================================================
            // ✅ LOCK: report
            // =====================================================
            const [reportLockRows] = await connection.execute(
              `
                SELECT 1
                FROM app_housekeeping_report r
                WHERE r.housekeeping_id = ?
                  AND (r.deleted = 0 OR r.deleted IS NULL)
                LIMIT 1
              `,
              [taskId]
            );

            const hasReportLock =
              Array.isArray(reportLockRows) && reportLockRows.length > 0;

            if (hasReportLock) {
              console.log(
                `🔒 REPORT LOCK - Task ${taskLabel}: salto pulizie legacy (extratimes/collab)`
              );
              continue;
            }

            // =====================================================
            // 2️⃣ CLEANUP legacy (extratimes/collab) quando NON collab
            // =====================================================
            if (!isCollab) {
              // 1) Soft-delete extratimes attive
              try {
                await connection.execute(
                  `
                    UPDATE app_housekeeping_extratimes
                    SET
                      deleted_at = NOW(),
                      deleted_by = ?,
                      updated_at = NOW(),
                      updated_by = ?
                    WHERE housekeeping_id = ?
                      AND deleted_at IS NULL
                  `,
                  [adamUpdatedBy, adamUpdatedBy, taskId]
                );
                console.log(
                  `🧹 EXTRATIMES SOFT-DELETE OK (non-collab) - Task ${taskLabel}`
                );
              } catch (e: any) {
                legacyCleanupErrors++;
                const msg = `Task ${taskId}: extratimes soft-delete (non-collab) -> ${e.message}`;
                legacyCleanupErrorDetails.push(msg);
                console.warn(`⚠️ EXTRATIMES SOFT-DELETE FAIL - ${msg}`);
              }

              // 2) hard-delete collaborations attive
              try {
                await connection.execute(
                  `
                    DELETE FROM app_housekeeping_collaborations
                    WHERE housekeeping_id = ?
                      AND deleted_at IS NULL
                  `,
                  [taskId]
                );
                console.log(
                  `🧹 COLLAB HARD-DELETE OK (non-collab) - Task ${taskLabel}`
                );
              } catch (e: any) {
                legacyCleanupErrors++;
                const msg = `Task ${taskId}: collab hard-delete (non-collab) -> ${e.message}`;
                legacyCleanupErrorDetails.push(msg);
                console.warn(`⚠️ COLLAB HARD-DELETE FAIL - ${msg}`);
              }
            }

            // =====================================================
            // 2️⃣+3️⃣ SYNC COLLAB (diff) + extratimes soft-delete (solo collab)
            // =====================================================
            if (isCollab) {
              // (ri-check lock; resta uguale)
              const [reportLockRows2] = await connection.execute(
                `
                  SELECT 1
                  FROM app_housekeeping_report r
                  WHERE r.housekeeping_id = ?
                    AND (r.deleted = 0 OR r.deleted IS NULL)
                  LIMIT 1
                `,
                [taskId]
              );

              const hasReportLock2 =
                Array.isArray(reportLockRows2) && reportLockRows2.length > 0;

              if (hasReportLock2) {
                console.log(
                  `🔒 REPORT LOCK - Task ${taskLabel}: salto sync collab legacy`
                );
              } else {
                // -----------------------------------------------------
                // 2A) SOFT-DELETE extratimes (solo collab)
                // -----------------------------------------------------
                try {
                  const [activeExtraRows] = await connection.execute(
                    `
                      SELECT id
                      FROM app_housekeeping_extratimes
                      WHERE housekeeping_id = ?
                        AND deleted_at IS NULL
                    `,
                    [taskId]
                  );

                  const hasActiveExtr =
                    Array.isArray(activeExtraRows) && activeExtraRows.length > 0;

                  if (hasActiveExtr) {
                    await connection.execute(
                      `
                        UPDATE app_housekeeping_extratimes
                        SET
                          deleted_at = NOW(),
                          deleted_by = ?,
                          updated_at = NOW(),
                          updated_by = ?
                        WHERE housekeeping_id = ?
                          AND deleted_at IS NULL
                      `,
                      [adamUpdatedBy, adamUpdatedBy, taskId]
                    );
                    console.log(`🧹 EXTRATIMES SOFT-DELETE OK - Task ${taskLabel}`);
                  } else {
                    console.log(
                      `🧹 EXTRATIMES CLEAN (none active) - Task ${taskLabel}`
                    );
                  }
                } catch (e: any) {
                  legacyCleanupErrors++;
                  const msg = `Task ${taskId}: extratimes soft-delete -> ${e.message}`;
                  legacyCleanupErrorDetails.push(msg);
                  console.warn(`⚠️ EXTRATIMES SOFT-DELETE FAIL - ${msg}`);
                }

                // -----------------------------------------------------
                // 2B) SYNC collaboratori con diff
                // -----------------------------------------------------
                const desiredSecondaries = new Set<number>(secondaryCleanerIds);

                const [rows] = await connection.execute(
                  `
                    SELECT id, user_id
                    FROM app_housekeeping_collaborations
                    WHERE housekeeping_id = ?
                      AND deleted_at IS NULL
                  `,
                  [taskId]
                );

                const existingActive = new Set<number>();
                if (Array.isArray(rows)) {
                  for (const r of rows as any[]) existingActive.add(Number(r.user_id));
                }

                const toSoftDelete: number[] = [];
                for (const userId of Array.from(existingActive)) {
                  if (!desiredSecondaries.has(userId)) toSoftDelete.push(userId);
                }

                const toInsert: number[] = [];
                for (const userId of Array.from(desiredSecondaries)) {
                  if (!existingActive.has(userId)) toInsert.push(userId);
                }

                let softDeleted = 0;
                let insertedOrReactivated = 0;
                let skippedDuplicate = 0;
                let failed = 0;

                if (toSoftDelete.length > 0) {
                  // ✅ MODIFICA: hard delete al posto della soft delete
                  try {
                    await connection.execute(
                      `
                        DELETE FROM app_housekeeping_collaborations
                        WHERE housekeeping_id = ?
                          AND user_id IN (${toSoftDelete.map(() => "?").join(",")})
                          AND deleted_at IS NULL
                      `,
                      [taskId, ...toSoftDelete]
                    );
                    softDeleted = toSoftDelete.length;
                    console.log(
                      `🧹 COLLAB HARD-DELETE OK - Task ${taskLabel} | deleted=${softDeleted}`
                    );
                  } catch (e: any) {
                    legacyCleanupErrors++;
                    const msg = `Task ${taskId}: collab hard-delete -> ${e.message}`;
                    legacyCleanupErrorDetails.push(msg);
                    console.warn(`⚠️ COLLAB HARD-DELETE FAIL - ${msg}`);
                  }
                }

                for (const collaboratorId of toInsert) {
                  const [existingActiveRows] = await connection.execute(
                    `
                      SELECT id
                      FROM app_housekeeping_collaborations
                      WHERE housekeeping_id = ?
                        AND user_id = ?
                        AND deleted_at IS NULL
                      LIMIT 1
                    `,
                    [taskId, collaboratorId]
                  );

                  const alreadyActive =
                    Array.isArray(existingActiveRows) && existingActiveRows.length > 0;

                  if (alreadyActive) {
                    skippedDuplicate++;
                    console.log(
                      `🤝 COLLAB DUPLICATE SKIP (active) - Task ${taskLabel} → collaborator=${collaboratorId}`
                    );
                    continue;
                  }

                  const [existingSoftRows] = await connection.execute(
                    `
                      SELECT id
                      FROM app_housekeeping_collaborations
                      WHERE housekeeping_id = ?
                        AND user_id = ?
                        AND deleted_at IS NOT NULL
                      ORDER BY deleted_at DESC
                      LIMIT 1
                    `,
                    [taskId, collaboratorId]
                  );

                  const hasSoft =
                    Array.isArray(existingSoftRows) && existingSoftRows.length > 0;

                  try {
                    if (hasSoft) {
                      await connection.execute(
                        `
                          UPDATE app_housekeeping_collaborations
                          SET
                            deleted_at = NULL,
                            deleted_by = '',
                            updated_at = NOW(),
                            updated_by = ?
                          WHERE housekeeping_id = ?
                            AND user_id = ?
                          LIMIT 1
                        `,
                        [adamUpdatedBy, taskId, collaboratorId]
                      );
                      insertedOrReactivated++;
                      console.log(
                        `🤝 COLLAB REACTIVATE OK - Task ${taskLabel} → collaborator=${collaboratorId}`
                      );
                    } else {
                      await connection.execute(
                        `
                        INSERT INTO app_housekeeping_collaborations (
                          id,
                          housekeeping_id,
                          housekeeping_report_id,
                          housekeeping_report_collaboration_id,
                          deleted_note_id,
                          user_id,
                          user_rq,
                          created_by,
                          updated_by,
                          deleted_by,
                          created_at,
                          updated_at,
                          deleted_at
                        )
                        VALUES (
                          NULL,
                          ?, 
                          NULL,
                          NULL,
                          NULL,
                          ?, 
                          0,    
                          ?, 
                          ?, 
                          '',
                          NOW(),
                          NOW(),
                          NULL
                        )
                        `,
                        [taskId, collaboratorId, adamUpdatedBy, adamUpdatedBy]
                      );
                      insertedOrReactivated++;
                      console.log(
                        `🤝 COLLAB INSERT OK - Task ${taskLabel} → collaborator=${collaboratorId}`
                      );
                    }
                  } catch (collabErr: any) {
                    failed++;
                    collaborationErrors++;
                    const msg = `Task ${taskId} → collaborator ${collaboratorId}: ${collabErr.message}`;
                    collaborationErrorDetails.push(msg);
                    console.error(`❌ COLLAB UPSERT FAIL - ${msg}`);
                  }
                }

                console.log(
                  `🤝 COLLAB SYNC END - Task ${taskLabel} | desiredSecondaries=${desiredSecondaries.size} | insertedOrReactivated=${insertedOrReactivated} | softDeleted=${softDeleted} | skippedDuplicate=${skippedDuplicate} | failed=${failed}`
                );
              }
            }
          } catch (taskError: any) {
            taskErrors++;
            const errorMsg = `Task ${taskLabel}: ${taskError.message}`;
            errors.push(errorMsg);
            console.error(`❌ TASK FAIL - ${errorMsg}`);
          }
        }
      }

      // ========== Cleanup ADAM: clear tasks not in timeline (solo dal secondo invio) ==========
      if (isSecondOrLaterTransfer && workDateFormatted) {
        const idsToClear: number[] = [];
        const [rowsToClear]: any[] = await connection.execute(
          `SELECT id FROM app_housekeeping
           WHERE checkout = ? AND deleted_at IS NULL AND deleted_at_client IS NULL
             AND cleaned_by_us IS NOT NULL
           ORDER BY id`,
          [workDateFormatted]
        );
        for (const row of Array.isArray(rowsToClear) ? rowsToClear : []) {
          const id = Number(row?.id);
          if (Number.isFinite(id) && !assignedTaskIds.has(id) && containerTaskIds.has(id)) idsToClear.push(id);
        }

        const nowRome = format(new Date(), "yyyy-MM-dd HH:mm:ss");
        for (const taskId of idsToClear) {
          const taskLabel = `${taskId}`;
          try {
            await connection.execute(
              `UPDATE app_housekeeping
               SET
                 cleaned_by_us = NULL,
                 sequence = NULL,
                 updated_by = ?,
                 updated_at = ?,
                 assigned_at_us = NULL,
                 assigned_at_milliseconds = NULL,
                 collaboration = 0,
                 collaboration_by = NULL,
                 collaboration_at = NULL,
                 collaboration_bypass = 0,
                 helpwork = 0,
                 helpwork_by = 0,
                 helpwork_at = NULL,
                 startwork = 0,
                 startwork_at = NULL,
                 startreport = 0,
                 startreport_at = NULL,
                 extratimes = ''
               WHERE id = ?`,
              [adamUpdatedBy, nowRome, taskId]
            );
            totalCleared++;

            const [reportLockRows] = await connection.execute(
              `SELECT 1 FROM app_housekeeping_report r
               WHERE r.housekeeping_id = ? AND (r.deleted = 0 OR r.deleted IS NULL)
               LIMIT 1`,
              [taskId]
            );
            const hasReportLock =
              Array.isArray(reportLockRows) && reportLockRows.length > 0;

            if (!hasReportLock) {
              try {
                await connection.execute(
                  `UPDATE app_housekeeping_extratimes
                   SET deleted_at = NOW(), deleted_by = ?, updated_at = NOW(), updated_by = ?
                   WHERE housekeeping_id = ? AND deleted_at IS NULL`,
                  [adamUpdatedBy, adamUpdatedBy, taskId]
                );
              } catch (e: any) {
                clearErrors++;
                clearErrorDetails.push(`Task ${taskId}: extratimes clear -> ${e.message}`);
              }
              try {
                await connection.execute(
                  `DELETE FROM app_housekeeping_collaborations
                   WHERE housekeeping_id = ? AND deleted_at IS NULL`,
                  [taskId]
                );
              } catch (e: any) {
                clearErrors++;
                clearErrorDetails.push(`Task ${taskId}: collaborations clear -> ${e.message}`);
              }
            }
          } catch (e: any) {
            clearErrors++;
            clearErrorDetails.push(`Task ${taskLabel}: ${e.message}`);
            console.error(`❌ CLEAR ADAM FAIL - Task ${taskLabel}:`, e?.message || e);
          }
        }
        if (idsToClear.length > 0) {
          console.log(`Cleanup ADAM: cleared ${totalCleared} tasks (second or later transfer)`);
        }
      }
    } finally {
      try {
        if (connection) await connection.end();
      } catch {}
    }

    return res.json({
      success: taskErrors === 0,
      workDate,
      totalUpdated,
      totalCleared,
      taskErrors,
      clearErrors,
      clearErrorDetails,
      collaborationErrors,
      legacyCleanupErrors,
      errors,
      collaborationErrorDetails,
      legacyCleanupErrorDetails,
    });
  } catch (e: any) {
    console.error("❌ transfer-to-adam FAIL:", e?.message || e);
    return res.status(500).json({
      success: false,
      message: e?.message || "Errore interno",
    });
  }
});

  // Endpoint DEBUG per visualizzare le revisioni ADAM
  app.get("/api/debug/revisions", async (req, res) => {
    try {
      const date = req.query.date as string;
      const { query } = await import("../shared/pg-db");
      
      let sql = `
        SELECT work_date, revision, modification_type, created_by, created_at 
        FROM daily_assignments_revisions 
        WHERE modification_type IN ('api_save_timeline', 'transfer_to_adam')
      `;
      const params: string[] = [];
      
      if (date) {
        sql += ` AND work_date = $1`;
        params.push(date);
      }
      
      sql += ` ORDER BY created_at DESC LIMIT 20`;
      
      const result = await query(sql, params);
      res.json({ success: true, revisions: result.rows });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per ottenere l'ultimo timestamp di trasferimento a ADAM
  app.get("/api/last-adam-transfer", async (req, res) => {
    try {
      const date = req.query.date as string;
      if (!date) {
        return res.status(400).json({ success: false, error: "date parameter required" });
      }

      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      const lastTransfer = await pgDailyAssignmentsService.getLastTransferToAdamTimestamp(date, resolveScopeFromReq(req));

      res.json({
        success: true,
        lastTransfer: lastTransfer ? lastTransfer.toISOString() : null
      });
    } catch (error: any) {
      console.error("❌ Errore recupero ultimo trasferimento ADAM:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint leggero: fingerprint ADAM su campi "di interesse" per containers
  // GET /api/adam/housekeeping/fingerprint?date=YYYY-MM-DD
  app.get("/api/adam/housekeeping/fingerprint", async (req, res) => {
    let connection: any = null;
    try {
      const officeScope = isOfficeScope(req.query.scope);
      const date = (req.query.date as string) || "";
      if (!date || !isValidWorkDate(date)) {
        return res.status(400).json({
          success: false,
          error: "date parameter required (YYYY-MM-DD)"
        });
      }

      connection = await mysql.createConnection({
        host: databaseConfig.mysql.host,
        port: databaseConfig.mysql.port,
        user: databaseConfig.mysql.user,
        password: databaseConfig.mysql.password,
        database: databaseConfig.mysql.database,
      });

      // In office scope usa le operation ufficio (15,38), altrimenti enable_wass.
      const activeOps = officeScope ? [15, 38] : await getCachedActiveAdamOperationIds(connection);
      const opPlaceholders = activeOps.length > 0 ? activeOps.map(() => "?").join(",") : "";

      // Firma basata SOLO sui campi che impattano containers (checkin/checkout/time/op/pax)
      // Normalizzazione: date -> YYYY-MM-DD, time -> TRIM(varchar5), numeri -> COALESCE
      const signatureExpr = `
        CRC32(CONCAT_WS('|',
          h.id,
          COALESCE(DATE_FORMAT(h.checkin, '%Y-%m-%d'), ''),
          COALESCE(TRIM(h.checkin_time), ''),
          COALESCE(DATE_FORMAT(h.checkout, '%Y-%m-%d'), ''),
          COALESCE(TRIM(h.checkout_time), ''),
          COALESCE(h.operation_id, 0),
          COALESCE(h.checkin_pax, 0),
          COALESCE(h.checkout_pax, 0)
        ))
      `;

      const sql = `
        SELECT
          COUNT(*) AS cnt,
          MAX(h.updated_at) AS max_upd,
          UNIX_TIMESTAMP(MAX(h.updated_at)) AS max_upd_unix,
          BIT_XOR(${signatureExpr}) AS sig_xor,
          SUM(${signatureExpr}) AS sig_sum
        FROM app_housekeeping h
        JOIN app_structures s ON h.structure_id = s.id
        WHERE h.checkout = ?
          AND h.deleted_at IS NULL
          AND h.deleted_at_client IS NULL
          AND s.lat IS NOT NULL AND s.lng IS NOT NULL
          AND s.lat != '' AND s.lng != ''
          AND s.lat != '0' AND s.lng != '0'
          ${
            activeOps.length > 0
              ? `AND (h.operation_id IN (${opPlaceholders}) OR h.operation_id IS NULL OR h.operation_id = 0)`
              : `AND (h.operation_id IS NULL OR h.operation_id = 0 OR 1=1)`
          }
      `;

      const params: any[] = [date, ...activeOps];
      const [rows]: any = await connection.execute(sql, params);
      const row = Array.isArray(rows) ? rows[0] : rows;

      res.json({
        success: true,
        date,
        count: Number(row?.cnt ?? 0),
        max_updated_at: row?.max_upd ?? null,
        max_updated_at_unix: row?.max_upd_unix !== null && row?.max_upd_unix !== undefined ? Number(row.max_upd_unix) : null,
        signature_xor: row?.sig_xor !== null && row?.sig_xor !== undefined ? Number(row.sig_xor) : null,
        // SUM può arrivare come string (bigint) a seconda del driver
        signature_sum: row?.sig_sum ?? null,
        active_operations_count: activeOps.length,
      });
    } catch (error: any) {
      console.error("❌ Errore fingerprint ADAM:", error?.message || error);
      res.status(500).json({ success: false, error: error.message || "Server error" });
    } finally {
      if (connection) {
        try {
          await connection.end();
        } catch {
          // ignore
        }
      }
    }
  });

  // Fingerprint ADAM per logistics (stessi campi housekeeping, filtro enable_route_drivers come create_containers.py)
  // GET /api/adam/logistics/fingerprint?date=YYYY-MM-DD
  app.get("/api/adam/logistics/fingerprint", async (req, res) => {
    let connection: any = null;
    try {
      const date = (req.query.date as string) || "";
      if (!date || !isValidWorkDate(date)) {
        return res.status(400).json({
          success: false,
          error: "date parameter required (YYYY-MM-DD)",
        });
      }

      connection = await mysql.createConnection({
        host: databaseConfig.mysql.host,
        port: databaseConfig.mysql.port,
        user: databaseConfig.mysql.user,
        password: databaseConfig.mysql.password,
        database: databaseConfig.mysql.database,
      });

      const activeOps = await getCachedActiveAdamRouteDriversOperationIds(connection);
      const nonNullOpIds = Array.from(new Set<number>([...activeOps, 0]));
      const opPlaceholders = nonNullOpIds.map(() => "?").join(",");

      const signatureExpr = `
        CRC32(CONCAT_WS('|',
          h.id,
          COALESCE(DATE_FORMAT(h.checkin, '%Y-%m-%d'), ''),
          COALESCE(TRIM(h.checkin_time), ''),
          COALESCE(DATE_FORMAT(h.checkout, '%Y-%m-%d'), ''),
          COALESCE(TRIM(h.checkout_time), ''),
          COALESCE(h.operation_id, 0),
          COALESCE(h.checkin_pax, 0),
          COALESCE(h.checkout_pax, 0)
        ))
      `;

      const sql = `
        SELECT
          COUNT(*) AS cnt,
          MAX(h.updated_at) AS max_upd,
          UNIX_TIMESTAMP(MAX(h.updated_at)) AS max_upd_unix,
          BIT_XOR(${signatureExpr}) AS sig_xor,
          SUM(${signatureExpr}) AS sig_sum
        FROM app_housekeeping h
        JOIN app_structures s ON h.structure_id = s.id
        WHERE h.checkout = ?
          AND h.deleted_at IS NULL
          AND h.deleted_at_client IS NULL
          AND s.lat IS NOT NULL AND s.lng IS NOT NULL
          AND s.lat != '' AND s.lng != ''
          AND s.lat != '0' AND s.lng != '0'
          AND (h.operation_id IN (${opPlaceholders}) OR h.operation_id IS NULL OR h.operation_id = 0)
      `;

      const params: any[] = [date, ...nonNullOpIds];
      const [rows]: any = await connection.execute(sql, params);
      const row = Array.isArray(rows) ? rows[0] : rows;

      res.json({
        success: true,
        date,
        count: Number(row?.cnt ?? 0),
        max_updated_at: row?.max_upd ?? null,
        max_updated_at_unix: row?.max_upd_unix !== null && row?.max_upd_unix !== undefined ? Number(row.max_upd_unix) : null,
        signature_xor: row?.sig_xor !== null && row?.sig_xor !== undefined ? Number(row.sig_xor) : null,
        signature_sum: row?.sig_sum ?? null,
        active_operations_count: activeOps.length,
      });
    } catch (error: any) {
      console.error("❌ Errore fingerprint ADAM logistics:", error?.message || error);
      res.status(500).json({ success: false, error: error.message || "Server error" });
    } finally {
      if (connection) {
        try {
          await connection.end();
        } catch {
          // ignore
        }
      }
    }
  });

  // Endpoint per aggiornare solo l'operation_id di una task su ADAM
  app.patch("/api/adam/task/:taskId/operation", async (req, res) => {
    try {
      const { taskId } = req.params;
      const { operation_id } = req.body;

      if (!taskId) {
        return res.status(400).json({
          success: false,
          message: "taskId è obbligatorio"
        });
      }

      if (operation_id === undefined) {
        return res.status(400).json({
          success: false,
          message: "operation_id è obbligatorio"
        });
      }

      // Connessione MySQL a ADAM
      let connection: any = null;

      try {
        connection = await mysql.createConnection({
          host: databaseConfig.mysql.host,
          port: databaseConfig.mysql.port,
          user: databaseConfig.mysql.user,
          password: databaseConfig.mysql.password,
          database: databaseConfig.mysql.database,
        });
        console.log("✅ Connessione MySQL ADAM stabilita per update operation_id");
      } catch (dbError: any) {
        console.error("❌ Errore connessione ADAM MySQL:", dbError.message);
        return res.status(500).json({
          success: false,
          message: `Errore connessione database ADAM: ${dbError.message}`
        });
      }

      try {
        const query = `
          UPDATE app_housekeeping
          SET 
            operation_id = ?,
            updated_at = ?
          WHERE id = ?
        `;

        const operationValue = operation_id === 0 ? null : operation_id;
        const values = [
          operationValue,
          getRomeTimestamp().replace('T', ' ').substring(0, 19),
          taskId
        ];

        const [result]: any = await connection.execute(query, values);
        
        if (result.affectedRows === 0) {
          return res.json({
            success: false,
            message: `Task con ID ${taskId} non trovata su ADAM`
          });
        }

        console.log(`✅ Task ${taskId} - operation_id aggiornato a ${operationValue} su ADAM`);

        res.json({
          success: true,
          message: `Operation ID aggiornato con successo`,
          taskId,
          operation_id: operationValue
        });

      } finally {
        if (connection) {
          await connection.end();
        }
      }

    } catch (error: any) {
      console.error("❌ Errore aggiornamento operation_id su ADAM:", error.message);
      res.status(500).json({
        success: false,
        message: `Errore aggiornamento: ${error.message}`
      });
    }
  });

  // Endpoint per estrarre i cleaners (versione ottimizzata)
  app.post("/api/extract-cleaners-optimized", async (req, res) => {
    try {
      const { date, scope } = req.body || {};
      const resolvedScope = isOfficeScope(scope) ? "office" : "housekeeping";
      const scriptPath = path.join(process.cwd(), 'client', 'public', 'scripts', 'extract_cleaners_optimized.py');

      // Se la data è fornita, passala come argomento allo script
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      const command = `python3 ${scriptPath} ${workDate} ${resolvedScope}`;

      console.log("Eseguendo extract_cleaners_optimized.py con comando:", command);

      const { stdout, stderr } = await execAsync(command, { maxBuffer: 1024 * 1024 * 10 });

      if (stderr && !stderr.includes('Browserslist')) {
        console.error("Errore extract_cleaners_optimized:", stderr);
      }

      console.log("extract_cleaners_optimized output:", stdout);

      res.json({
        success: true,
        message: 'Cleaner estratti con successo (ottimizzato)',
        output: stdout
      });
    } catch (error: any) {
      console.error("Errore durante l'estrazione dei cleaners (ottimizzato):", error.message);
      // Return 200 with success:false to avoid blocking UI
      res.status(200).json({
        success: false,
        message: "Impossibile estrarre cleaners dal database ADAM. Verifica la connessione o usa i cleaners da PostgreSQL.",
        error: error.message,
        stderr: error.stderr
      });
    }
  });

  app.post("/api/extract-logistics-drivers", async (req, res) => {
    try {
      const { date } = req.body;
      const scriptPath = path.join(process.cwd(), "client", "public", "scripts", "extract_logistics_drivers.py");
      const command = date ? `python3 ${scriptPath} ${date}` : `python3 ${scriptPath}`;
      console.log("Eseguendo extract_logistics_drivers.py:", command);
      const { stdout, stderr } = await execAsync(command, { maxBuffer: 1024 * 1024 * 10 });
      if (stderr && !stderr.includes("Browserslist")) {
        console.error("Errore extract_logistics_drivers:", stderr);
      }
      console.log("extract_logistics_drivers output:", stdout);
      res.json({
        success: true,
        message: "Driver estratti con successo",
        output: stdout,
      });
    } catch (error: any) {
      console.error("Errore durante extract_logistics_drivers:", error.message);
      res.status(200).json({
        success: false,
        message:
          "Impossibile estrarre driver da ADAM. Verifica connessione MySQL/API o usa i dati già in PostgreSQL.",
        error: error.message,
        stderr: error.stderr,
      });
    }
  });

  // Endpoint per eseguire assign_eo.py
  app.post("/api/assign-early-out", async (req, res) => {
    try {
      console.log("Eseguendo assign_eo.py...");
      const { stdout, stderr } = await execAsync(
        `python3 client/public/scripts/assign_eo.py`,
        { maxBuffer: 1024 * 1024 * 10 }
      );

      if (stderr && !stderr.includes('Browserslist')) {
        console.error("Errore assign_eo:", stderr);
      }
      console.log("assign_eo output:", stdout);

      res.json({
        success: true,
        message: "Early-out tasks assegnati con successo",
        output: stdout
      });
    } catch (error: any) {
      console.error("Errore durante l'assegnazione early-out:", error);
      res.status(500).json({
        success: false,
        error: error.message,
        stderr: error.stderr
      });
    }
  });

  // Endpoint per eseguire assign_followups_eo.py
  app.post("/api/assign-followups-eo", async (req, res) => {
    try {
      console.log("Eseguendo assign_followups_eo.py...");
      const { stdout, stderr } = await execAsync(
        `python3 client/public/scripts/assign_followups_eo.py`,
        { maxBuffer: 1024 * 1024 * 10 }
      );

      if (stderr && !stderr.includes('Browserslist')) {
        console.error("Errore assign_followups_eo:", stderr);
      }
      console.log("assign_followups_eo output:", stdout);

      res.json({
        success: true,
        message: "Follow-up tasks assegnati con successo",
        output: stdout
      });
    } catch (error: any) {
      console.error("Errore durante l'assegnazione follow-up:", error);
      res.status(500).json({
        success: false,
        error: error.message,
        stderr: error.stderr
      });
    }
  });

  // Endpoint per eseguire assign_hp.py
  app.post("/api/assign-hp", async (req, res) => {
    try {
      const { date } = req.body;
      const workDate = date || format(new Date(), 'yyyy-MM-dd');

      console.log(`Eseguendo assign_hp.py per data ${workDate}...`);

      const { spawn } = await import('child_process');
      const scriptPath = path.join(process.cwd(), 'client/public/scripts/assign_hp.py');

      const pythonProcess = spawn('python3', [scriptPath, workDate, '--use-api']);

      let stdoutData = '';
      pythonProcess.stdout.on('data', (data) => {
        stdoutData += data.toString();
      });

      let stderrData = '';
      pythonProcess.stderr.on('data', (data) => {
        stderrData += data.toString();
        console.error(`assign_hp.py stderr: ${data}`);
      });

      pythonProcess.on('close', (code) => {
        if (code !== 0) {
          console.error(`assign_hp.py exited with code ${code}`);
          res.status(500).json({
            success: false,
            message: "High Priority tasks assegnazione fallita",
            stderr: stderrData,
            stdout: stdoutData
          });
          return;
        }

        console.log("assign_hp output:", stdoutData);
        res.json({
          success: true,
          message: "High Priority tasks assegnati con successo",
          output: stdoutData
        });
      });

    } catch (error: any) {
      console.error("Errore durante l'assegnazione HP:", error);
      res.status(500).json({
        success: false,
        error: error.message,
        stderr: error.stderr || "N/A",
        stdout: error.stdout || "N/A"
      });
    }
  });

  // Endpoint per assegnare Low Priority tasks
  app.post("/api/assign-lp", async (req, res) => {
    try {
      const { date } = req.body;
      const workDate = date || format(new Date(), 'yyyy-MM-dd');

      console.log(`Eseguendo assign_lp.py per data ${workDate}...`);

      const { spawn } = await import('child_process');
      const scriptPath = path.join(process.cwd(), 'client/public/scripts/assign_lp.py');

      const pythonProcess = spawn('python3', [
        scriptPath,
        workDate,
        '--use-api'
      ]);

      let stdoutData = '';
      pythonProcess.stdout.on('data', (data) => {
        stdoutData += data.toString();
        console.log(`assign_lp.py: ${data}`);
      });

      let stderrData = '';
      pythonProcess.stderr.on('data', (data) => {
        stderrData += data.toString();
        console.error(`assign_lp.py stderr: ${data}`);
      });

      pythonProcess.on('close', (code) => {
        if (code !== 0) {
          console.error(`assign_lp.py exited with code ${code}`);
          res.status(500).json({
            success: false,
            message: "Low Priority tasks assegnazione fallita",
            stderr: stderrData,
            stdout: stdoutData
          });
          return;
        }

        console.log("assign_lp output:", stdoutData);
        res.json({
          success: true,
          message: "Low Priority tasks assegnati con successo",
          output: stdoutData
        });
      });

    } catch (error: any) {
      console.error("Errore durante l'assegnazione LP:", error);
      res.status(500).json({
        success: false,
        error: error.message,
        stderr: error.stderr || "N/A",
        stdout: error.stdout || "N/A"
      });
    }
  });

  // Endpoint per il nuovo script di assegnazione ottimizzato (opt.py)
  app.post("/api/assign-unified", async (req, res) => {
    try {
      console.log("Eseguendo opt.py...");
      const { stdout, stderr } = await execAsync(
        `python3 client/public/scripts/opt.py`,
        { maxBuffer: 1024 * 1024 * 10 }
      );

      if (stderr && !stderr.includes('Browserslist')) {
        console.error("Errore opt.py:", stderr);
      }
      console.log("opt.py output:", stdout);

      res.json({
        success: true,
        message: "Task assegnati con successo",
        output: stdout
      });
    } catch (error: any) {
      console.error("Errore durante l'assegnazione:", error);
      res.status(500).json({
        success: false,
        error: error.message,
        stderr: error.stderr
      });
    }
  });


  // Endpoint per estrarre i dati
  app.post("/api/extract-data", async (req, res) => {
    try {
      const { date, created_by, scope } = req.body;
      const createdBy = created_by || 'unknown';
      const officeScope = isOfficeScope(scope);
      const resolvedScope = officeScope ? "office" : "housekeeping";
      const assignedDir = path.join(process.cwd(), 'client/public/data/assigned');

      // CRITICAL: Esegui extract_cleaners_optimized.py ma non bloccare se fallisce
      console.log(`🔄 Estrazione cleaners dal database per ${date}...`);
      let extractCleanersResult = '';
      try {
        const extractResult = await new Promise<string>((resolve, reject) => {
          exec(
            `python3 client/public/scripts/extract_cleaners_optimized.py ${date} ${resolvedScope}`,
            { timeout: 30000 },
            (error, stdout, stderr) => {
              if (error) {
                console.warn("⚠️ extract_cleaners_optimized fallito, userò cleaners da PostgreSQL:", stderr?.substring(0, 200));
                resolve(''); // Non bloccare il flusso
              } else {
                resolve(stdout);
              }
            }
          );
        });
        extractCleanersResult = extractResult;
      } catch (err: any) {
        console.warn("⚠️ extract_cleaners_optimized timeout/errore, procedo con PostgreSQL");
      }
      console.log("extract_cleaners_optimized output (se disponibile):", extractCleanersResult.substring(0, 500));

      // CRITICAL: NON resettare timeline - preservala sempre
      // Anche se la data cambia, mantieni le assegnazioni esistenti
      // create_containers.py aggiornerà i dati delle task esistenti
      let timelineExists = false;
      try {
        const existingTimeline = await workspaceFiles.loadTimeline(date, resolvedScope);

        if (existingTimeline) {
          timelineExists = true;

          // Aggiorna SOLO la metadata.date se è cambiata
          if (existingTimeline.metadata?.date !== date) {
            console.log(`🔄 Timeline esiste per data ${existingTimeline.metadata?.date}, aggiorno metadata.date a ${date}`);
            existingTimeline.metadata.date = date;
            existingTimeline.metadata.last_updated = getRomeTimestamp();
            // Mantieni created_by se esiste
            if (!existingTimeline.metadata.created_by) {
              existingTimeline.metadata.created_by = createdBy;
            }
            await workspaceFiles.saveTimeline(date, existingTimeline, false, 'system', 'manual', undefined, resolvedScope);
          } else {
            console.log(`✅ Timeline già presente per ${date}, mantieni assegnazioni esistenti`);
          }
        } else {
          throw new Error('Timeline non trovata');
        }
      } catch (err) {
        // Timeline non esiste - creala vuota
        console.log(`📝 Timeline non esiste, creazione nuova per ${date}`);
        const emptyTimeline = {
          metadata: {
            last_updated: getRomeTimestamp(),
            date: date,
            created_by: createdBy
          },
          cleaners_assignments: [],
          meta: { total_cleaners: 0, used_cleaners: 0, assigned_tasks: 0 }
        };
        await workspaceFiles.saveTimeline(date, emptyTimeline, false, 'system', 'manual', undefined, resolvedScope);
        timelineExists = false;
      }

      // CRITICAL: Gestione selected_cleaners via PostgreSQL
      // Carica selected_cleaners correnti da PostgreSQL
      const currentSelectedData = await workspaceFiles.loadSelectedCleaners(date, resolvedScope);
      const currentSelectedDate = currentSelectedData?.metadata?.date || null;

      // Verifica se esistono dati salvati per la data target
      let hasExistingTimeline = false;
      let timelineDataForCheck: any = null;
      try {
        timelineDataForCheck = await workspaceFiles.loadTimeline(date, resolvedScope);
        hasExistingTimeline = timelineDataForCheck?.metadata?.date === date &&
                             timelineDataForCheck?.cleaners_assignments?.length > 0;
      } catch (err) {
        hasExistingTimeline = false;
      }

      // Resetta SOLO se:
      // 1. La data è diversa E
      // 2. NON esistono già assegnazioni salvate per la nuova data
      if (currentSelectedDate !== date && !hasExistingTimeline) {
        console.log(`📅 Data cambiata da ${currentSelectedDate} a ${date} - reset selected_cleaners (nessuna timeline esistente)`);
        const emptySelection = {
          cleaners: [],
          total_selected: 0,
          metadata: { date }
        };
        await workspaceFiles.saveSelectedCleaners(date, emptySelection, true, 'system', 'INIT', resolvedScope);
        console.log(`ℹ️ selected_cleaners resettato in PostgreSQL per ${date}`);
      } else if (currentSelectedDate !== date && hasExistingTimeline) {
        console.log(`✅ Data cambiata da ${currentSelectedDate} a ${date} - mantieni dati esistenti (timeline con ${timelineDataForCheck.cleaners_assignments.length} cleaners)`);
        // Ricostruisci selected_cleaners dalla timeline esistente
        const cleanersInTimeline = timelineDataForCheck.cleaners_assignments.map((ca: any) => ca.cleaner).filter(Boolean);
        const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
        const cleanerIds = cleanersInTimeline
          .map((c: any) => Number(c?.id))
          .filter((id: number) => Number.isFinite(id));
        const cleanersFromDb = cleanerIds.length > 0
          ? await pgDailyAssignmentsService.loadCleanersByIds(cleanerIds, date, resolvedScope)
          : [];
        const cleanersById = new Map<number, any>(
          (cleanersFromDb || []).map((c: any) => [Number(c.id), c])
        );
        const enrichedCleanersInTimeline = cleanersInTimeline.map((cleaner: any) => {
          const cleanerId = Number(cleaner?.id);
          const dbCleaner = cleanersById.get(cleanerId);
          const timelineRole = typeof cleaner?.role === "string" ? cleaner.role.trim() : "";
          const dbRole = typeof dbCleaner?.role === "string" ? dbCleaner.role.trim() : "";
          return {
            ...(dbCleaner || {}),
            ...cleaner,
            role: dbRole || timelineRole || cleaner?.role || null,
          };
        });

        const selectionFromTimeline = {
          cleaners: enrichedCleanersInTimeline,
          total_selected: enrichedCleanersInTimeline.length,
          metadata: { date }
        };
        await workspaceFiles.saveSelectedCleaners(date, selectionFromTimeline, true, 'system', 'INIT', resolvedScope);
        console.log(`✅ selected_cleaners ricostruito da timeline in PostgreSQL per ${date}`);
      } else {
        console.log(`✅ Stessa data (${date}) - mantieni selected_cleaners`);
      }

      // Esegui SEMPRE create_containers.py per avere dati freschi dal database
      console.log(`Eseguendo create_containers.py per data ${date}...`);
      const workflowArg = officeScope ? " --workflow office" : "";
      const containersResult = await new Promise<string>((resolve, reject) => {
        exec(
          `python3 client/public/scripts/create_containers.py --date ${date} --use-api${workflowArg}`,
          (error, stdout, stderr) => {
            if (error) {
              console.error("Errore create_containers:", stderr);
              reject(new Error(stderr || error.message));
            } else {
              resolve(stdout);
            }
          }
        );
      });
      console.log("create_containers output:", containersResult);

      // Python ha già salvato containers via API - nessuna azione necessaria
      console.log(`✅ Containers già salvati via API da Python per ${date}`);

      res.json({
        success: true,
        message: "Dati estratti con successo dal database",
        outputs: {
          create_containers: containersResult
        }
      });
    } catch (error: any) {
      console.error("Errore nell'estrazione dei dati:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Route legacy del database rimosse - il progetto usa solo file JSON

  // Endpoint per ottenere i clienti attivi dal database
  app.get("/api/get-active-clients", async (req, res) => {
    try {
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execPromise = promisify(exec);

      console.log("Eseguendo extract_active_clients.py...");
      const { stdout, stderr } = await execPromise(
        "python3 client/public/scripts/extract_active_clients.py"
      );

      if (stderr) {
        console.error("Stderr da extract_active_clients:", stderr);
      }

      const raw = stdout.trim();

      // prendi solo la parte che sembra JSON (dal primo { all'ultimo })
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");

      if (start === -1 || end === -1) {
        throw new Error(`Python output is not JSON:\n${raw}`);
      }

      const jsonText = raw.slice(start, end + 1);
      const parsed = JSON.parse(jsonText);


      if (!parsed.success) {
        console.error("Errore da extract_active_clients.py:", parsed.error);
        return res.status(500).json({
          success: false,
          error: parsed.error,
          clients: [],
        });
      }

      res.json({
        success: true,
        clients: parsed.clients,
      });
    } catch (error: any) {
      console.error("Errore extract_active_clients:", error);
      res.status(500).json({
        success: false,
        error: error.message || "Errore nell'estrazione dei clienti attivi",
        clients: [],
      });
    }
  });

  // GET /api/client-timewindows - Carica finestre temporali clienti da PostgreSQL
  app.get("/api/client-timewindows", async (req, res) => {
    try {
      const { pgSettingsService } = await import("./services/pg-settings-service");
      await pgSettingsService.ensureTables();
      const data = await pgSettingsService.getSettings('client_timewindows');
      
      if (data) {
        res.json(data);
      } else {
        res.json({ windows: [], metadata: { last_updated: getRomeTimestamp() } });
      }
    } catch (error: any) {
      console.error("Errore nel caricamento delle finestre temporali:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/save-client-timewindows - Salva finestre temporali clienti su PostgreSQL
  app.post("/api/save-client-timewindows", async (req, res) => {
    try {
      const clientTimeWindowsData = req.body;
      const { pgSettingsService } = await import("./services/pg-settings-service");
      await pgSettingsService.ensureTables();
      
      clientTimeWindowsData.metadata = clientTimeWindowsData.metadata || {};
      clientTimeWindowsData.metadata.last_updated = getRomeTimestamp();
      
      await pgSettingsService.saveSettings('client_timewindows', clientTimeWindowsData);

      res.json({
        success: true,
        message: "Finestre temporali salvate con successo in PostgreSQL"
      });
    } catch (error: any) {
      console.error("Errore nel salvataggio delle finestre temporali:", error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // GET /api/settings - Carica settings da PostgreSQL
  app.get("/api/settings", async (req, res) => {
    try {
      const { pgSettingsService } = await import("./services/pg-settings-service");
      await pgSettingsService.ensureTables();
      const data = await pgSettingsService.getSettings('app_settings');
      
      if (data) {
        res.json(data);
      } else {
        res.json({});
      }
    } catch (error: any) {
      console.error("Errore nel caricamento delle impostazioni:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/save-settings - Salva settings su PostgreSQL
  app.post("/api/save-settings", async (req, res) => {
    try {
      const settingsData = req.body;
      const { pgSettingsService } = await import("./services/pg-settings-service");
      await pgSettingsService.ensureTables();
      
      await pgSettingsService.saveSettings('app_settings', settingsData);

      res.json({
        success: true,
        message: "Impostazioni salvate con successo in PostgreSQL",
      });
    } catch (error: any) {
      console.error("Errore nel salvataggio delle impostazioni:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per caricare clienti attivi
  app.get("/api/get-active-clients", async (req, res) => {
    try {
      const result = await new Promise<string>((resolve, reject) => {
        exec(
          'python3 client/public/scripts/extract_active_clients.py',
          { cwd: process.cwd() },
          (error, stdout, stderr) => {
            if (error) {
              reject(new Error(stderr || error.message));
            } else {
              resolve(stdout);
            }
          }
        );
      });

      const clients = JSON.parse(result);
      res.json({ success: true, clients });
    } catch (error: any) {
      console.error("Errore nel caricamento dei clienti attivi:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per salvare client_windows.json
  app.post("/api/save-client-windows", async (req, res) => {
    try {
      const clientWindowsData = req.body;
      const clientWindowsPath = path.join(process.cwd(), "client/public/data/input/client_windows.json");

      await fs.writeFile(
        clientWindowsPath,
        JSON.stringify(clientWindowsData, null, 2),
        "utf-8"
      );

      res.json({
        success: true,
        message: "Client windows salvate con successo",
      });
    } catch (error: any) {
      console.error("Errore nel salvataggio delle client windows:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per rimuovere un task da early_out_assignments.json
  app.post("/api/remove-from-early-out-assignments", async (req, res) => {
    try {
      const { taskId, logisticCode } = req.body;
      const earlyOutAssignmentsPath = path.join(process.cwd(), 'client/public/data/output/early_out_assignments.json');

      console.log(`Rimozione da early_out_assignments.json - taskId: ${taskId}, logisticCode: ${logisticCode}`);

      let assignmentsData: any = { early_out_tasks_assigned: [], meta: {} };
      try {
        const existingData = await fs.readFile(earlyOutAssignmentsPath, 'utf8');
        assignmentsData = JSON.parse(existingData);
      } catch (error) {
        // File non esiste, usa struttura vuota
      }

      const initialLength = assignmentsData.early_out_tasks_assigned.length;
      assignmentsData.early_out_tasks_assigned = assignmentsData.early_out_tasks_assigned.filter(
        (t: any) => {
          const matchId = String(t.task_id) === String(taskId);
          const matchCode = String(t.logistic_code) === String(logisticCode);
          return !matchId && !matchCode;
        }
      );

      console.log(`Early out assignments prima: ${initialLength}, dopo: ${assignmentsData.early_out_tasks_assigned.length}`);

      await fs.writeFile(earlyOutAssignmentsPath, JSON.stringify(assignmentsData, null, 2));

      res.json({ success: true, message: "Task rimosso da early_out_assignments.json con successo" });
    } catch (error: any) {
      console.error("Errore nella rimozione da early_out_assignments.json:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per scaricare early_out_assignments.json
  app.get("/api/download-early-out-assignments", async (req, res) => {
    try {
      const filePath = path.join(process.cwd(), 'client/public/data/output/early_out_assignments.json');
      const data = await fs.readFile(filePath, 'utf8');

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename=early_out_assignments.json');
      res.send(data);
    } catch (error: any) {
      console.error("Errore nel download di early_out_assignments.json:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });




  // Endpoint per spostare/riordinare task nella timeline con indici precisi
  app.post("/api/timeline/move-task", async (req, res) => {
    try {
      const {
        taskId,
        logisticCode,
        fromCleanerId,
        toCleanerId,
        sourceIndex,
        destIndex,
        insertAt,
        fromContainer,
      } = req.body as {
        taskId?: string | number;
        logisticCode?: string | number;
        fromCleanerId?: number;
        toCleanerId: number;
        sourceIndex?: number;
        destIndex?: number;
        insertAt?: number;
        fromContainer?: 'early_out' | 'high_priority' | 'low_priority';
      };

      if (typeof toCleanerId !== 'number') {
        return res.status(400).json({ success: false, message: 'toCleanerId obbligatorio' });
      }
      if (typeof taskId === 'undefined' && typeof logisticCode === 'undefined') {
        return res.status(400).json({ success: false, message: 'taskId o logisticCode obbligatorio' });
      }

      const taskKey = String(typeof taskId !== 'undefined' ? taskId : logisticCode);
      const workDate = req.body.date || format(new Date(), 'yyyy-MM-dd');

      // Verifica se la task è bloccata (enforcement) - specialmente se viene da container
      if (fromContainer && taskId) {
        const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
        const isLocked = await pgDailyAssignmentsService.isTaskLocked(workDate, Number(taskId));
        if (isLocked) {
          const lockInfo = await pgDailyAssignmentsService.getTaskLock(workDate, Number(taskId));
          console.log(`🔒 BLOCKED: Task ${taskId} è bloccata, impossibile assegnare da container`);
          return res.status(423).json({
            success: false,
            error: "TASK_LOCKED",
            message: "Task bloccata: impossibile assegnare",
            locked_reason: lockInfo?.lockedReason
          });
        }
      }

      let timelineData: any = { metadata: {}, cleaners_assignments: [] };
      let containersData: any = null;

      try {
        timelineData = await workspaceFiles.loadTimeline(workDate, resolveScopeFromReq(req));
        if (!timelineData) {
          timelineData = { metadata: { date: workDate }, cleaners_assignments: [] };
        }
      } catch (err) {
        console.error('Errore caricamento timeline:', err);
      }

      try {
        containersData = await workspaceFiles.loadContainers(workDate, resolveScopeFromReq(req));
      } catch (err) {
        console.error('Errore caricamento containers:', err);
      }

      const cleaners = timelineData.cleaners_assignments || [];

      const getCleanerEntry = (cid: number) => cleaners.find((c: any) => c?.cleaner?.id === cid);

      const findTaskIndex = (arr: any[]) => {
        if (typeof taskId !== 'undefined') {
          const idStr = String(taskId);
          const idx = arr.findIndex((t) => String(t?.task_id) === idStr || String(t?.id) === idStr);
          if (idx !== -1) return idx;
        }
        if (typeof logisticCode !== 'undefined') {
          const codeStr = String(logisticCode);
          const idx = arr.findIndex((t) => String(t?.logistic_code) === codeStr);
          if (idx !== -1) return idx;
        }
        return -1;
      };


      let moved: any | null = null;
      let removedFromIndex: number | null = null;

      // === Caso A: provengo da TIMELINE ===
      if (typeof fromCleanerId === 'number') {
        const srcEntry = getCleanerEntry(fromCleanerId);
        if (!srcEntry || !Array.isArray(srcEntry.tasks)) {
          return res.status(400).json({ success: false, message: 'Cleaner sorgente non valido' });
        }

        let takeIdx: number | null = null;
        if (typeof sourceIndex === 'number' && sourceIndex >= 0 && sourceIndex < srcEntry.tasks.length) {
          takeIdx = sourceIndex;
        } else {
          const idx = findTaskIndex(srcEntry.tasks);
          takeIdx = idx >= 0 ? idx : null;
        }

        if (takeIdx === null) {
          // FIX: fallback globale prima di dare 404
          let foundCleaner: any = null, foundIdx = -1;
          for (const ca of cleaners) {
            const i = findTaskIndex(ca.tasks || []);
            if (i !== -1) { foundCleaner = ca; foundIdx = i; break; }
          }
          if (foundIdx !== -1 && foundCleaner) {
            if (fromCleanerId === toCleanerId) removedFromIndex = foundIdx;
            [moved] = foundCleaner.tasks.splice(foundIdx, 1);
            (foundCleaner.tasks || []).forEach((t: any, i: number) => { t.sequence = i + 1; });
          } else {
            return res.status(404).json({ success: false, message: 'Task non trovata nel cleaner sorgente (neanche globalmente)' });
          }
        } else {
          if (fromCleanerId === toCleanerId) removedFromIndex = takeIdx;
          [moved] = srcEntry.tasks.splice(takeIdx, 1);
          srcEntry.tasks.forEach((t: any, i: number) => { t.sequence = i + 1; });
        }
      }

      // === Caso B: provengo da CONTAINER ===
      if (!moved && fromContainer && containersData?.containers?.[fromContainer]?.tasks) {
        const srcArr = containersData.containers[fromContainer].tasks as any[];
        let idx = findTaskIndex(srcArr);
        if (idx === -1 && typeof sourceIndex === 'number' && srcArr[sourceIndex]) idx = sourceIndex;
        if (idx === -1) {
          return res.status(404).json({ success: false, message: 'Task non trovata nel container sorgente' });
        }
        [moved] = srcArr.splice(idx, 1);
        containersData.containers[fromContainer].count = srcArr.length; // Update count
      }

      // === Caso C: Riordino interno (se non spostato da altro) ===
      if (!moved) {
        const idx = findTaskIndex(cleaners.find((c: any) => c?.cleaner?.id === toCleanerId)?.tasks || []);
        if (idx === -1) {
          return res.status(404).json({ success: false, message: 'Task non trovata' });
        }
        removedFromIndex = idx; // Traccia l'indice di rimozione
        [moved] = cleaners.find((c: any) => c?.cleaner?.id === toCleanerId).tasks.splice(idx, 1);
      }

      if (!moved) {
        return res.status(404).json({ success: false, message: 'Task non trovata in nessuna fonte' });
      }

      // Trova o crea l'entry del cleaner di destinazione
      let dstEntry = getCleanerEntry(toCleanerId);
      if (!dstEntry) {
        // Carica i dati del cleaner da PostgreSQL
        try {
          const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
          
          // Cerca prima nei selected_cleaners da PostgreSQL
          const selectedData = await workspaceFiles.loadSelectedCleaners(workDate, resolveScopeFromReq(req));
          let cleanerInfo = selectedData?.cleaners?.find((c: any) => c.id === toCleanerId);

          // Se non trovato, cerca in cleaners per la data
          if (!cleanerInfo) {
            const allCleaners = await pgDailyAssignmentsService.loadCleanersForDate(workDate, resolveScopeFromReq(req));
            cleanerInfo = allCleaners?.find((c: any) => c.id === toCleanerId);
          }

          if (!cleanerInfo) {
            return res.status(400).json({ success: false, message: 'Cleaner di destinazione non trovato in PostgreSQL' });
          }

          // Crea la nuova entry per il cleaner
          dstEntry = {
            cleaner: {
              id: cleanerInfo.id,
              name: cleanerInfo.name,
              lastname: cleanerInfo.lastname,
              role: cleanerInfo.role,
              premium: cleanerInfo.role === "Premium"
            },
            tasks: []
          };
          cleaners.push(dstEntry);
          console.log(`✅ Creato cleaner entry per ${toCleanerId} (era nascosto)`);
        } catch (error: any) {
          console.error('Errore caricamento dati cleaner da PostgreSQL:', error);
          return res.status(400).json({ success: false, message: 'Errore nel caricamento dati cleaner' });
        }
      }

      if (!Array.isArray(dstEntry.tasks)) {
        dstEntry.tasks = [];
      }

      // Inserimento con clamp + fix stesso cleaner
      let finalInsertAt = typeof destIndex === 'number' ? destIndex : dstEntry.tasks.length;
      if (removedFromIndex !== null && removedFromIndex < finalInsertAt) {
        finalInsertAt = finalInsertAt - 1;
      }
      if (finalInsertAt < 0) finalInsertAt = 0;
      if (finalInsertAt > dstEntry.tasks.length) finalInsertAt = dstEntry.tasks.length;

      dstEntry.tasks.splice(finalInsertAt, 0, moved);

      // Aggiorna sequence nel cleaner destinazione
      dstEntry.tasks.forEach((t: any, i: number) => { t.sequence = i + 1; });

      // Ricalcola tempi usando lo script Python per avere start_time/end_time coerenti con la sequenza
      try {
        await hydrateTasksFromContainers(dstEntry, workDate);
        const updatedDst = await recalculateCleanerTimes(dstEntry, workDate);
        dstEntry.tasks = updatedDst.tasks;
        console.log(`✅ Tempi ricalcolati per cleaner ${toCleanerId} dopo inserimento`);

        // Se c'è un cleaner sorgente diverso, ricalcola anche quello
        if (typeof fromCleanerId === 'number' && fromCleanerId !== toCleanerId) {
          const srcEntry = getCleanerEntry(fromCleanerId);
          if (srcEntry && srcEntry.tasks.length > 0) {
            await hydrateTasksFromContainers(srcEntry, workDate);
            const updatedSrc = await recalculateCleanerTimes(srcEntry, workDate);
            srcEntry.tasks = updatedSrc.tasks;
            console.log(`✅ Tempi ricalcolati per cleaner ${fromCleanerId} dopo rimozione`);
          }
        }
      } catch (pythonError: any) {
        console.error(`⚠️ Errore nel ricalcolo dei tempi:`, pythonError.message);
        // Fallback: mantieni sequence manualmente (già fatto sopra)
      }

      // Aggiorna metadata
      timelineData.metadata = timelineData.metadata || {};
      timelineData.metadata.last_updated = getRomeTimestamp();
      timelineData.metadata.date = workDate;

      // Determina modification_type in base alla sorgente e destinazione
      let modificationType = 'task_moved';
      if (fromContainer && typeof fromCleanerId !== 'number') {
        modificationType = `dnd_from_${fromContainer}`;
        moved.manually_moved = true;
      } else if (fromCleanerId === toCleanerId) {
        modificationType = 'task_reordered_same_cleaner';
        for (const t of dstEntry.tasks) t.manually_moved = true;
      } else if (typeof fromCleanerId === 'number') {
        modificationType = 'dnd_between_cleaners';
        moved.manually_moved = true;
      }

      // Save the updated timeline
      const saved = await workspaceFiles.saveTimeline(workDate, timelineData, false, req.body.currentUser?.username || 'unknown', modificationType, undefined, resolveScopeFromReq(req));

      if (containersData) {
        await workspaceFiles.saveContainers(workDate, containersData, 'system', 'manual', resolveScopeFromReq(req));
      }

      const message = typeof fromCleanerId === 'number'
        ? (fromCleanerId === toCleanerId ? 'Riordino nel cleaner eseguito' : `Task spostata da cleaner ${fromCleanerId} a cleaner ${toCleanerId}`)
        : 'Task inserita dal container alla posizione richiesta';

      console.log(`✅ ${message} - Task ${taskKey} inserita in posizione ${insertAt} per cleaner ${toCleanerId}`);

      return res.json({ success: true, message });
    } catch (err: any) {
      console.error('timeline/move-task error:', err);
      return res.status(500).json({ success: false, message: 'Errore interno', error: String(err?.message ?? err) });
    }
  });

  // Endpoint per riordinare le task nella timeline di un cleaner
  app.post("/api/reorder-timeline", async (req, res) => {
    try {
      const { date, cleanerId, taskId, logisticCode, fromIndex, toIndex } = req.body;
      const workDate = date || format(new Date(), 'yyyy-MM-dd');

      // Carica timeline da PostgreSQL
      let timelineData: any = await workspaceFiles.loadTimeline(workDate, resolveScopeFromReq(req));
      if (!timelineData) {
        return res.status(404).json({ success: false, message: "Timeline non trovata per questa data" });
      }

      // Trova il cleaner
      const cleanerEntry = timelineData.cleaners_assignments.find((c: any) => c.cleaner.id === cleanerId);

      if (!cleanerEntry) {
        return res.status(404).json({ success: false, message: "Cleaner non trovato" });
      }

      // CRITICAL: Cerca la task per taskId invece di fidarsi di fromIndex
      const actualFromIndex = cleanerEntry.tasks.findIndex((t: any) =>
        String(t.task_id) === String(taskId) || String(t.logistic_code) === String(logisticCode)
      );

      if (actualFromIndex === -1) {
        console.error(`Task ${taskId}/${logisticCode} non trovata nel cleaner ${cleanerId}`);
        return res.status(404).json({
          success: false,
          message: "Task non trovata nel cleaner specificato"
        });
      }

      // Verifica che toIndex sia valido
      if (toIndex < 0 || toIndex > cleanerEntry.tasks.length) {
        return res.status(400).json({ success: false, message: "Indice toIndex non valido" });
      }

      // Rimuovi la task dalla posizione effettiva (actualFromIndex)
      const [task] = cleanerEntry.tasks.splice(actualFromIndex, 1);

      // Inserisci nella nuova posizione toIndex
      cleanerEntry.tasks.splice(toIndex, 0, task);

      // Ricalcola travel_time, start_time, end_time usando lo script Python
      try {
        await hydrateTasksFromContainers(cleanerEntry, workDate);
        const updatedCleanerData = await recalculateCleanerTimes(cleanerEntry, workDate);
        // Sostituisci le task con quelle ricalcolate
        cleanerEntry.tasks = updatedCleanerData.tasks;
        console.log(`✅ Tempi ricalcolati per cleaner ${cleanerId}`);
      } catch (pythonError: any) {
        console.error(`⚠️ Errore nel ricalcolo dei tempi, continuo senza ricalcolare:`, pythonError.message);
        // Fallback: ricalcola solo sequence manualmente
        cleanerEntry.tasks.forEach((t: any, i: number) => {
          t.sequence = i + 1;
          t.followup = i > 0;
        });
      }

      // Aggiorna metadata e meta, preservando created_by e aggiornando modified_by
      const modifyingUser = req.body.modified_by || req.body.created_by || getCurrentUsername(req);

      timelineData.metadata = timelineData.metadata || {};
      timelineData.metadata.last_updated = getRomeTimestamp();
      timelineData.metadata.date = workDate;

      // Preserva created_by se già esiste
      if (!timelineData.metadata.created_by) {
        timelineData.metadata.created_by = modifyingUser;
      }

      // Aggiorna modified_by array solo se l'utente non è 'system' o 'unknown'
      timelineData.metadata.modified_by = timelineData.metadata.modified_by || [];
      // Rimuovi 'system' e 'unknown' dall'array se presenti
      timelineData.metadata.modified_by = timelineData.metadata.modified_by.filter((user: string) =>
        user !== 'system' && user !== 'unknown'
      );
      if (modifyingUser && modifyingUser !== 'system' && modifyingUser !== 'unknown' && !timelineData.metadata.modified_by.includes(modifyingUser)) {
        timelineData.metadata.modified_by.push(modifyingUser);
      }

      timelineData.meta = timelineData.meta || {};
      timelineData.meta.total_tasks = timelineData.cleaners_assignments.reduce(
        (sum: number, c: any) => sum + (c.tasks?.length || 0),
        0
      );
      timelineData.meta.total_cleaners = timelineData.cleaners_assignments.length;

      for (const t of cleanerEntry.tasks) t.manually_moved = true;

      // Salva timeline (dual-write: filesystem + Object Storage)
      await workspaceFiles.saveTimeline(workDate, timelineData, false, modifyingUser, 'task_reordered_same_cleaner', undefined, resolveScopeFromReq(req));

      console.log(`✅ Task ${logisticCode} riordinata da posizione ${fromIndex} a ${toIndex} per cleaner ${cleanerId}`);
      console.log(`   Nuova sequenza delle task: ${cleanerEntry.tasks.map((t: any) => `${t.logistic_code}(${t.sequence})`).join(', ')}`);

      res.json({ success: true, message: "Task riordinata con successo" });
    } catch (error: any) {
      console.error("Errore nel reorder della timeline:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per salvare alias cleaner (PostgreSQL)
  app.post("/api/save-cleaner-alias", async (req, res) => {
    try {
      const { cleanerId, alias, date } = req.body;

      if (!cleanerId) {
        return res.status(400).json({
          success: false,
          message: "cleanerId è obbligatorio"
        });
      }

      const workDate = date || format(new Date(), "yyyy-MM-dd");
      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");

      // Salva alias direttamente in PostgreSQL
      const success = await pgDailyAssignmentsService.updateCleanerField(
        cleanerId, 
        workDate, 
        'alias', 
        alias || null
      );

      if (!success) {
        return res.status(500).json({
          success: false,
          message: "Errore nel salvataggio dell'alias in PostgreSQL"
        });
      }

      console.log(`✅ Alias salvato in PostgreSQL per cleaner ${cleanerId}: "${alias}"`);

      res.json({
        success: true,
        message: "Alias salvato con successo"
      });
    } catch (error: any) {
      console.error("Errore nel salvataggio dell'alias:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per migrare gli alias da JSON a aliases (tabella permanente)
  app.post("/api/migrate-aliases", async (req, res) => {
    try {
      const aliasesPath = path.join(process.cwd(), "client/public/data/cleaners/cleaners_aliases.json");
      let aliasesData: any;

      try {
        const content = await fs.readFile(aliasesPath, 'utf8');
        aliasesData = JSON.parse(content);
      } catch (error) {
        return res.json({ success: true, message: "Nessun file aliases da migrare", migrated: 0 });
      }

      const aliases = aliasesData.aliases || {};
      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      
      // Use new bulk import function to aliases table
      const migrated = await pgDailyAssignmentsService.importAliasesFromJson(aliases);

      console.log(`✅ Migrati ${migrated} alias da JSON a aliases`);
      res.json({ success: true, message: `Migrati ${migrated} alias a aliases`, migrated });
    } catch (error: any) {
      console.error("Errore nella migrazione degli alias:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per migrare settings e client_timewindows da JSON a PostgreSQL
  app.post("/api/migrate-settings", async (req, res) => {
    try {
      const { pgSettingsService } = await import("./services/pg-settings-service");
      await pgSettingsService.ensureTables();
      
      let migratedSettings = false;
      let migratedTimewindows = false;

      // Migra settings.json
      try {
        const settingsPath = path.join(process.cwd(), "client/public/data/input/settings.json");
        const settingsContent = await fs.readFile(settingsPath, 'utf8');
        const settingsData = JSON.parse(settingsContent);
        await pgSettingsService.saveSettings('app_settings', settingsData);
        console.log('✅ settings.json migrato a PostgreSQL');
        migratedSettings = true;
      } catch (err) {
        console.log('⚠️ settings.json non trovato o già migrato');
      }

      // Migra client_timewindows.json
      try {
        const timewindowsPath = path.join(process.cwd(), "client/public/data/input/client_timewindows.json");
        const timewindowsContent = await fs.readFile(timewindowsPath, 'utf8');
        const timewindowsData = JSON.parse(timewindowsContent);
        await pgSettingsService.saveSettings('client_timewindows', timewindowsData);
        console.log('✅ client_timewindows.json migrato a PostgreSQL');
        migratedTimewindows = true;
      } catch (err) {
        console.log('⚠️ client_timewindows.json non trovato o già migrato');
      }

      res.json({
        success: true,
        message: 'Migrazione completata',
        migratedSettings,
        migratedTimewindows
      });
    } catch (error: any) {
      console.error("Errore nella migrazione settings:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // API per la gestione degli account utente (PostgreSQL)
  app.get("/api/accounts", async (req, res) => {
    try {
      const { pgUsersService } = await import("./services/pg-users-service");
      const users = await pgUsersService.getAllUsers();
      res.json({ users });
    } catch (error) {
      console.error("Errore nel caricamento degli account:", error);
      res.status(500).json({ success: false, message: "Errore del server" });
    }
  });

  app.post("/api/accounts/add", async (req, res) => {
    try {
      const { username, password, role } = req.body;
      if (!username || !password) {
        return res.status(400).json({ success: false, message: "Username e password sono obbligatori." });
      }

      const { pgUsersService } = await import("./services/pg-users-service");
      const newUser = await pgUsersService.createUser(username, password, role || 'user');

      if (!newUser) {
        return res.status(400).json({ success: false, message: "Errore nella creazione dell'account (username già esistente?)." });
      }

      res.json({ success: true, message: "Account aggiunto con successo." });
    } catch (error) {
      console.error("Errore nell'aggiunta dell'account:", error);
      res.status(500).json({ success: false, message: "Errore del server" });
    }
  });

  app.post("/api/accounts/update", async (req, res) => {
    try {
      const { id, username, password, role } = req.body;
      if (typeof id === 'undefined') {
        return res.status(400).json({ success: false, message: "ID account mancante." });
      }

      const { pgUsersService } = await import("./services/pg-users-service");
      const currentUser = await pgUsersService.getUserById(id);

      if (!currentUser) {
        return res.status(404).json({ success: false, message: "Account non trovato" });
      }

      // Impedisci modifica ruolo se è l'account admin principale (id=1)
      if (currentUser.id === 1 && role && role !== 'admin') {
        return res.status(403).json({
          success: false,
          message: "Non puoi modificare il ruolo dell'account admin principale."
        });
      }

      const updates: any = {};
      if (username !== undefined) updates.username = username;
      if (password !== undefined) updates.password = password;
      if (role !== undefined) updates.role = role;

      await pgUsersService.updateUser(id, updates);
      res.json({ success: true, message: "Account aggiornato con successo." });
    } catch (error) {
      console.error("Errore nell'aggiornamento dell'account:", error);
      res.status(500).json({ success: false, message: "Errore del server" });
    }
  });

  app.post("/api/accounts/delete", async (req, res) => {
    try {
      const { id } = req.body;
      if (typeof id === 'undefined') {
        return res.status(400).json({ success: false, message: "ID account mancante." });
      }

      // Impedisci eliminazione dell'account admin principale (id=1)
      if (id === 1) {
        return res.status(403).json({
          success: false,
          message: "Non puoi eliminare l'account admin principale."
        });
      }

      const { pgUsersService } = await import("./services/pg-users-service");
      const deleted = await pgUsersService.deleteUser(id);

      if (!deleted) {
        return res.status(404).json({ success: false, message: "Account non trovato." });
      }

      res.json({ success: true, message: "Account eliminato con successo." });
    } catch (error) {
      console.error("Errore nell'eliminazione dell'account:", error);
      res.status(500).json({ success: false, message: "Errore del server" });
    }
  });

  app.post("/api/accounts/change-password", async (req, res) => {
    try {
      const { userId, newPassword } = req.body;

      if (typeof userId === 'undefined' || !newPassword) {
        return res.status(400).json({ success: false, message: "ID utente e nuova password sono obbligatori." });
      }

      const { pgUsersService } = await import("./services/pg-users-service");
      const user = await pgUsersService.getUserById(userId);

      if (!user) {
        return res.status(404).json({ success: false, message: "Utente non trovato." });
      }

      await pgUsersService.updateUser(userId, { password: newPassword });

      res.json({ success: true, message: "Password cambiata con successo." });

    } catch (error) {
      console.error("Errore nel cambio password:", error);
      res.status(500).json({ success: false, message: "Errore del server" });
    }
  });

  // API per gestione workspace - Cancella file workspace non salvati
  app.get("/api/workspace/list", async (req, res) => {
    try {
      const dates = await storageService.listWorkspaceDates();
      res.json({ success: true, dates });
    } catch (error: any) {
      console.error("Errore nel listing workspace:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.delete("/api/workspace/:workDate", async (req, res) => {
    try {
      const { workDate } = req.params;

      if (!workDate || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
        return res.status(400).json({
          success: false,
          error: "Data non valida. Formato richiesto: YYYY-MM-DD"
        });
      }

      const result = await storageService.deleteWorkspaceFiles(workDate);

      res.json({
        success: result.success,
        deletedFiles: result.deletedFiles,
        errors: result.errors,
        message: result.success
          ? `File workspace cancellati per ${workDate}`
          : `Errori durante la cancellazione: ${result.errors.join(', ')}`
      });
    } catch (error: any) {
      console.error("Errore nella cancellazione workspace:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });



  // Endpoint per sincronizzare checkin_time/checkout_time dal database ADAM alle task nella timeline
  app.post("/api/sync-timeline-from-adam", async (req, res) => {
    try {
      const { date } = req.body;
      const workDate = date || format(new Date(), 'yyyy-MM-dd');

      console.log(`🔄 Sincronizzazione dati ADAM per timeline ${workDate}...`);

      // 1. Carica la timeline corrente
      let timelineData = await workspaceFiles.loadTimeline(workDate, resolveScopeFromReq(req));
      if (!timelineData || !timelineData.cleaners_assignments || timelineData.cleaners_assignments.length === 0) {
        return res.json({
          success: true,
          message: "Nessuna timeline da sincronizzare",
          updated_tasks: 0
        });
      }

      // 2. Raccogli tutti i task_id dalla timeline
      const taskIds: number[] = [];
      for (const cleanerEntry of timelineData.cleaners_assignments) {
        for (const task of cleanerEntry.tasks || []) {
          if (task.task_id) {
            taskIds.push(task.task_id);
          }
        }
      }

      if (taskIds.length === 0) {
        return res.json({
          success: true,
          message: "Nessuna task nella timeline",
          updated_tasks: 0
        });
      }

      // 3. Query database ADAM per ottenere i dati aggiornati
      const mysql = await import('mysql2/promise');
      const adamConnection = await mysql.createConnection({
        host: databaseConfig.mysql.host,
        port: databaseConfig.mysql.port,
        user: databaseConfig.mysql.user,
        password: databaseConfig.mysql.password,
        database: databaseConfig.mysql.database,
      });

      const [rows]: any = await adamConnection.execute(`
        SELECT 
          h.id AS task_id,
          h.checkin_time,
          h.checkout_time
        FROM app_housekeeping h
        WHERE h.id IN (${taskIds.join(',')})
      `);
      await adamConnection.end();

      // 4. Crea mappa task_id -> dati ADAM
      const adamDataMap = new Map<number, { checkin_time: string | null, checkout_time: string | null }>();
      for (const row of rows) {
        adamDataMap.set(row.task_id, {
          checkin_time: row.checkin_time && row.checkin_time.trim() ? row.checkin_time.trim() : null,
          checkout_time: row.checkout_time && row.checkout_time.trim() ? row.checkout_time.trim() : null
        });
      }

      // 5. Aggiorna le task nella timeline
      let updatedCount = 0;
      for (const cleanerEntry of timelineData.cleaners_assignments) {
        for (const task of cleanerEntry.tasks || []) {
          const adamData = adamDataMap.get(task.task_id);
          if (adamData) {
            if (adamData.checkin_time !== task.checkin_time || adamData.checkout_time !== task.checkout_time) {
              task.checkin_time = adamData.checkin_time;
              task.checkout_time = adamData.checkout_time;
              updatedCount++;
            }
          }
        }
      }

      // 6. Salva la timeline aggiornata
      if (updatedCount > 0) {
        await workspaceFiles.saveTimeline(workDate, timelineData, false, 'system', 'sync_from_adam', undefined, resolveScopeFromReq(req));
        console.log(`✅ Sincronizzate ${updatedCount} task con dati ADAM per ${workDate}`);
      }

      res.json({
        success: true,
        message: `Sincronizzate ${updatedCount} task con dati ADAM`,
        updated_tasks: updatedCount,
        total_tasks_checked: taskIds.length
      });
    } catch (error: any) {
      console.error("Errore nella sincronizzazione ADAM:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per caricare i containers da PostgreSQL
  app.get("/api/containers-enriched", async (req, res) => {
    try {
      const dateParam = (req.query.date as string) || format(new Date(), "yyyy-MM-dd");
      const workDate = dateParam;

      console.log(`📖 GET /api/containers-enriched - Caricamento containers per ${workDate}`);

      const containers = await workspaceFiles.loadContainers(workDate, resolveScopeFromReq(req));

      if (!containers || !containers.containers) {
        return res.json({
          containers: {
            early_out: { tasks: [], count: 0 },
            high_priority: { tasks: [], count: 0 },
            low_priority: { tasks: [], count: 0 }
          },
          summary: { early_out: 0, high_priority: 0, low_priority: 0, total_tasks: 0 },
          metadata: { date: workDate }
        });
      }

      res.json(containers);
    } catch (error: any) {
      console.error("Errore nel caricamento containers arricchiti:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  // Endpoint per verificare se ci sono task non confermate (per routing condizionale homepage)
  app.get("/api/unconfirmed-tasks-summary", async (req, res) => {
    try {
      const dateParam = (req.query.date as string) || format(new Date(), "yyyy-MM-dd");
      const workDate = dateParam;

      console.log(`📖 GET /api/unconfirmed-tasks-summary - Conteggio task non confermate per ${workDate}`);

      // 1. Carica containers da PostgreSQL (contengono già confirmed_operation)
      const containers = await workspaceFiles.loadContainers(workDate, resolveScopeFromReq(req));

      if (!containers || !containers.containers) {
        return res.json({ unconfirmedCount: 0, date: workDate });
      }

      // 2. Conta le task non confermate direttamente dai containers
      let unconfirmedCount = 0;
      let totalTasks = 0;
      
      for (const containerKey of Object.keys(containers.containers)) {
        const container = containers.containers[containerKey];
        if (container?.tasks) {
          for (const task of container.tasks) {
            totalTasks++;
            // Task non confermata se confirmed_operation è false, 0, null o undefined
            if (task.confirmed_operation === false || 
                task.confirmed_operation === 0 || 
                task.confirmed_operation === null || 
                task.confirmed_operation === undefined) {
              unconfirmedCount++;
            }
          }
        }
      }

      console.log(`✅ Task non confermate per ${workDate}: ${unconfirmedCount}/${totalTasks}`);
      res.json({ unconfirmedCount, date: workDate, total: totalTasks });
    } catch (error: any) {
      console.error("Errore nel conteggio task non confermate:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ========== OPTIMIZER RUN-ALL ENDPOINT ==========
  
  app.post("/api/optimizer/run-all", async (req, res) => {
    try {
      const { date, skipPhase4 = false, applyToProduction = false } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      
      console.log(`🚀 POST /api/optimizer/run-all - Avvio OPTIMIZER COMPLETO per ${workDate}`);
      console.log(`   skipPhase4=${skipPhase4}, applyToProduction=${applyToProduction}`);
      
      const { runAllPhases } = await import('./services/optimizer/runAllPhases');
      const result = await runAllPhases(workDate, { skipPhase4, applyToProduction });
      
      console.log(`✅ OPTIMIZER completato in ${result.totalDurationMs}ms`);
      console.log(`   Status: ${result.status}, Assigned: ${result.summary.tasksAssigned}, Unassigned: ${result.summary.tasksUnassigned}`);
      
      res.json({
        success: result.status === 'success',
        ...result
      });
    } catch (error: any) {
      console.error("❌ Errore optimizer run-all:", error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // ========== OPTIMIZER WAVE ENDPOINT ==========

  app.post("/api/optimizer/run-wave", async (req, res) => {
    try {
      const { date, priority } = req.body;

      const validPriorities = ['early_out', 'high_priority', 'low_priority'];
      if (!priority || !validPriorities.includes(priority)) {
        return res.status(400).json({
          success: false,
          error: `Invalid priority. Must be one of: ${validPriorities.join(', ')}`,
        });
      }

      const workDate = date || format(new Date(), "yyyy-MM-dd");
      console.log(`POST /api/optimizer/run-wave - Wave ${priority} for ${workDate}`);

      const { query } = await import("../shared/pg-db");
      const timelinePriorityRows = await query(
        `
          SELECT priority
          FROM daily_assignments_current
          WHERE work_date = $1
        `,
        [workDate]
      );

      const normalizePriority = (value: string | null | undefined) => {
        if (!value) return null;
        const normalized = String(value).toLowerCase();
        if (normalized === 'early_out' || normalized === 'early-out') return 'early_out';
        if (normalized === 'high_priority' || normalized === 'high') return 'high_priority';
        if (normalized === 'low_priority' || normalized === 'low') return 'low_priority';
        return null;
      };

      const hasEoOnTimeline = timelinePriorityRows.rows.some((row: any) => normalizePriority(row.priority) === 'early_out');
      const hasHpOnTimeline = timelinePriorityRows.rows.some((row: any) => normalizePriority(row.priority) === 'high_priority');

      if (priority === 'high_priority' && !hasEoOnTimeline) {
        return res.status(400).json({
          success: false,
          error: "Esegui prima la wave Early Out",
        });
      }

      if (priority === 'low_priority' && (!hasEoOnTimeline || !hasHpOnTimeline)) {
        return res.status(400).json({
          success: false,
          error: "Esegui prima le wave Early Out e High Priority",
        });
      }

      const { runSingleWave } = await import('./services/optimizer/runAllPhases');

      const waveResult = await runSingleWave(workDate, priority);

      if (waveResult.skipped) {
        console.log(`Wave ${priority} skipped: no tasks`);
        return res.json({ success: true, ...waveResult, message: `No ${priority} tasks to assign` });
      }

      if (waveResult.status !== 'success') {
        console.error(`Wave ${priority} failed: ${waveResult.error}`);
        return res.status(500).json({ success: false, ...waveResult });
      }

      console.log(`Wave ${priority} complete: ${waveResult.assignedTasks} assigned`);

      res.json({
        success: true,
        ...waveResult,
        message: `${waveResult.assignedTasks} ${priority} tasks assigned`,
      });
    } catch (error: any) {
      console.error("Error in optimizer run-wave:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/optimizer/apply-to-production", async (req, res) => {
    try {
      const { runId, date } = req.body;
      
      if (!runId || !date) {
        return res.status(400).json({ 
          success: false, 
          error: "runId and date are required" 
        });
      }
      
      console.log(`🚀 POST /api/optimizer/apply-to-production - Applying run ${runId} to production`);
      
      const { applyOptimizerToProduction } = await import('./services/optimizer/runAllPhases');
      const result = await applyOptimizerToProduction(runId, date);
      
      console.log(`✅ Apply to production: inserted=${result.insertedCount}, deleted=${result.deletedCount}`);
      
      res.json(result);
    } catch (error: any) {
      console.error("❌ Errore apply-to-production:", error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // ========== OPTIMIZER PHASE 0 ENDPOINTS (Locked Filter) ==========
  
  app.post("/api/optimizer/run-phase0", async (req, res) => {
    try {
      const { date, runId } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      
      if (!runId) {
        return res.status(400).json({ success: false, error: "runId is required" });
      }
      
      console.log(`🚀 POST /api/optimizer/run-phase0 - Avvio FASE 0 (Locked Filter) per ${workDate}`);
      
      const { runPhase0, getPhase0Summary } = await import('./services/optimizer/runPhase0');
      const result = await runPhase0(workDate, runId);
      
      console.log(`✅ FASE 0 completata: ${result.lockedTasks} task bloccate, ${result.unlockedTasks} task sbloccate in ${result.durationMs}ms`);
      
      res.json({
        success: result.status === 'success',
        ...result,
        summary: getPhase0Summary(result)
      });
    } catch (error: any) {
      console.error("❌ Errore FASE 0 optimizer:", error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // ========== OPTIMIZER PHASE 1 ENDPOINTS ==========
  
  app.post("/api/optimizer/run-phase1", async (req, res) => {
    try {
      const { date, params, runId: existingRunId } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      
      console.log(`🚀 POST /api/optimizer/run-phase1 - Avvio FASE 1 per ${workDate}`);
      
      const { runPhase1 } = await import('./services/optimizer/runPhase1');
      const result = await runPhase1(workDate, { 
        params: params || {},
        existingRunId 
      });
      
      console.log(`✅ FASE 1 completata: ${result.groupsGenerated} gruppi generati, ${result.lockedTasksExcluded} task bloccate escluse in ${result.durationMs}ms`);
      
      res.json({
        success: result.status === 'success',
        ...result
      });
    } catch (error: any) {
      console.error("❌ Errore FASE 1 optimizer:", error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  app.get("/api/optimizer/phase1-stats", async (req, res) => {
    try {
      const dateParam = (req.query.date as string) || format(new Date(), "yyyy-MM-dd");
      
      const { getPhase1Stats } = await import('./services/optimizer/runPhase1');
      const stats = await getPhase1Stats(dateParam);
      
      res.json(stats);
    } catch (error: any) {
      console.error("❌ Errore stats FASE 1:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/optimizer/decisions", async (req, res) => {
    try {
      const runId = req.query.runId as string;
      const phase = req.query.phase ? parseInt(req.query.phase as string) : undefined;
      
      if (!runId) {
        return res.status(400).json({ success: false, error: "runId required" });
      }
      
      const { getDecisionsForRun } = await import('./services/optimizer/db');
      const decisions = await getDecisionsForRun(runId, phase);
      
      res.json({ decisions, count: decisions.length });
    } catch (error: any) {
      console.error("❌ Errore lettura decisions:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ========== OPTIMIZER PHASE 2 ENDPOINTS ==========

  app.post("/api/optimizer/run-phase2", async (req, res) => {
    try {
      const { date, runId, params } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      
      console.log(`🚀 POST /api/optimizer/run-phase2 - Avvio FASE 2 per ${workDate}`);
      
      const { runPhase2 } = await import('./services/optimizer/runPhase2');
      const result = await runPhase2(workDate, runId, params || {});
      
      console.log(`✅ FASE 2 completata: ${result.groupsAssigned}/${result.groupsProcessed} gruppi assegnati in ${result.durationMs}ms`);
      
      res.json({
        success: result.status === 'success',
        ...result
      });
    } catch (error: any) {
      console.error("❌ Errore FASE 2 optimizer:", error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  app.get("/api/optimizer/phase2-stats", async (req, res) => {
    try {
      const runId = req.query.runId as string;
      
      if (!runId) {
        return res.status(400).json({ success: false, error: "runId required" });
      }
      
      const { getPhase2Stats } = await import('./services/optimizer/runPhase2');
      const stats = await getPhase2Stats(runId);
      
      res.json(stats);
    } catch (error: any) {
      console.error("❌ Errore stats FASE 2:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/optimizer/run-phase3", async (req, res) => {
    try {
      const { date, runId } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      
      console.log(`🚀 POST /api/optimizer/run-phase3 - Avvio FASE 3 per ${workDate}`);
      
      const { runPhase3 } = await import('./services/optimizer/runPhase3');
      const result = await runPhase3(workDate, runId);
      
      console.log(`✅ FASE 3 completata: ${result.tasksScheduled} task schedulati, ${result.tasksUnassigned} non assegnabili in ${result.durationMs}ms`);
      
      res.json({
        success: result.status === 'success',
        ...result
      });
    } catch (error: any) {
      console.error("❌ Errore FASE 3 optimizer:", error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // ========== OPTIMIZER PHASE 4 ENDPOINTS ==========
  
  app.post("/api/optimizer/run-phase4", async (req, res) => {
    try {
      const { date, runId, params } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      
      console.log(`🚀 POST /api/optimizer/run-phase4 - Avvio FASE 4 Recovery per ${workDate}`);
      
      const { runPhase4 } = await import('./services/optimizer/runPhase4');
      const result = await runPhase4(workDate, runId, params || {});
      
      console.log(`✅ FASE 4 completata: ${result.insertedCount} inseriti, ${result.singleAssignedCount} single, ${result.remainUnassignedCount} rimasti non assegnati in ${result.durationMs}ms`);
      
      res.json({
        success: result.status === 'success',
        ...result
      });
    } catch (error: any) {
      console.error("❌ Errore FASE 4 optimizer:", error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}