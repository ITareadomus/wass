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

// Utility per timestamp in fuso orario di Roma
const ROME_TIMEZONE = "Europe/Rome";
function getRomeTimestamp(): string {
  return formatInTimeZone(new Date(), ROME_TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss");
}
import { storageService } from "./services/storage-service";
import * as workspaceFiles from "./services/workspace-files";
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

/**
 * Helper: Load cleaner start_time from PostgreSQL (selected cleaners)
 * Falls back to filesystem if PostgreSQL fails
 */
async function getCleanerStartTime(cleanerId: number, workDate: string): Promise<string | null> {
  try {
    // Try PostgreSQL first
    const selectedCleaners = await workspaceFiles.loadSelectedCleaners(workDate);
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
async function getCleanerData(cleanerId: number, workDate: string): Promise<any | null> {
  try {
    const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
    return await pgDailyAssignmentsService.loadCleanerById(cleanerId, workDate);
  } catch (err) {
    console.warn(`⚠️ Could not load cleaner ${cleanerId} from PostgreSQL`);
    return null;
  }
}

/**
 * Helper: Load all cleaners for a date from PostgreSQL
 */
async function getAllCleanersForDate(workDate: string): Promise<any[]> {
  try {
    const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
    const cleaners = await pgDailyAssignmentsService.loadCleanersForDate(workDate);
    return cleaners || [];
  } catch (err) {
    console.warn(`⚠️ Could not load cleaners from PostgreSQL for ${workDate}`);
    return [];
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
    await pgDailyAssignmentsService.ensureAliasColumn();
    
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

      // 1. PRIMA caricare la timeline esistente per estrarre le task assegnate
      const existingTimeline = await workspaceFiles.loadTimeline(workDate);
      const assignedTasks: any[] = [];

      if (existingTimeline && existingTimeline.cleaners_assignments) {
        // Estrai tutte le task assegnate da tutti i cleaners
        for (const cleanerEntry of existingTimeline.cleaners_assignments) {
          if (cleanerEntry.tasks && Array.isArray(cleanerEntry.tasks)) {
            for (const task of cleanerEntry.tasks) {
              assignedTasks.push(task);
            }
          }
        }
        console.log(`📦 Trovate ${assignedTasks.length} task assegnate da riportare nei containers`);
      }

      // 2. Caricare i containers esistenti (struttura: { containers: { early_out: {...}, ... }, metadata: {...} })
      let containersResponse = await workspaceFiles.loadContainers(workDate);
      
      // Inizializza struttura corretta
      let containersData: any = {
        containers: {
          early_out: { tasks: [] },
          high_priority: { tasks: [] },
          low_priority: { tasks: [] }
        },
        metadata: { date: workDate }
      };

      // Se abbiamo dati esistenti, usa quelli
      if (containersResponse) {
        // loadContainers può restituire struttura annidata o diretta
        if (containersResponse.containers) {
          containersData = containersResponse;
        } else if (containersResponse.early_out || containersResponse.high_priority || containersResponse.low_priority) {
          // Struttura diretta - wrappa in containers
          containersData.containers = {
            early_out: containersResponse.early_out || { tasks: [] },
            high_priority: containersResponse.high_priority || { tasks: [] },
            low_priority: containersResponse.low_priority || { tasks: [] }
          };
          containersData.metadata = containersResponse.metadata || { date: workDate };
        }
      }

      // Assicura che i container abbiano tasks array
      for (const priority of ['early_out', 'high_priority', 'low_priority']) {
        if (!containersData.containers[priority]) {
          containersData.containers[priority] = { tasks: [] };
        }
        if (!containersData.containers[priority].tasks) {
          containersData.containers[priority].tasks = [];
        }
      }

      // 3. Aggiungere le task estratte ai containers in base alla priorità
      for (const task of assignedTasks) {
        const priority = task.priority || 'low_priority';
        const targetContainer = priority === 'early_out' ? 'early_out' :
                               priority === 'high_priority' ? 'high_priority' : 'low_priority';

        // Evita duplicati: controlla se la task è già nel container
        const alreadyExists = containersData.containers[targetContainer].tasks.some(
          (t: any) => String(t.task_id) === String(task.task_id)
        );

        if (!alreadyExists) {
          containersData.containers[targetContainer].tasks.push(task);
          console.log(`  ➕ Task ${task.task_id} (${task.logistic_code}) → ${targetContainer}`);
        }
      }

      // 4. Salvare i containers aggiornati su PostgreSQL
      await workspaceFiles.saveContainers(workDate, containersData, currentUsername, 'containers_reset');
      console.log(`✅ Containers aggiornati con ${assignedTasks.length} task ripristinate`);

      // 5. DOPO svuotare la timeline
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

      await workspaceFiles.saveTimeline(workDate, emptyTimeline, false, currentUsername, 'timeline_reset');
      console.log(`✅ Timeline svuotata su PostgreSQL`);

      // === RESET: NON modificare selected_cleaners ===
      console.log(`✅ Reset completato - selected_cleaners NON modificato`);

      res.json({ 
        success: true, 
        message: "Timeline resettata con successo",
        tasksRestored: assignedTasks.length
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

      // Carica timeline da PostgreSQL
      let timelineData: any = await workspaceFiles.loadTimeline(workDate);
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
        const cleanersData = await workspaceFiles.loadSelectedCleaners(workDate);
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

      destEntry.tasks.splice(targetIndex, 0, taskToMove);

      // 4. Ricalcola tempi per il cleaner di origine e destinazione
      try {
        // Ricalcola cleaner di origine (se ha ancora task)
        if (sourceEntry && sourceEntry.tasks.length > 0) {
          await hydrateTasksFromContainers(sourceEntry, workDate);
          const updatedSourceData = await recalculateCleanerTimes(sourceEntry);
          sourceEntry.tasks = updatedSourceData.tasks;
          console.log(`✅ Tempi ricalcolati per cleaner sorgente ${sourceCleanerId}`);
        }

        // Ricalcola cleaner di destinazione
        await hydrateTasksFromContainers(destEntry, workDate);
        const updatedDestData = await recalculateCleanerTimes(destEntry);
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
      await workspaceFiles.saveTimeline(workDate, timelineData, false, modifyingUser, 'dnd_between_cleaners');

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

      // Carica timeline da PostgreSQL
      let timelineData: any = await workspaceFiles.loadTimeline(workDate);
      if (!timelineData) {
        timelineData = { cleaners_assignments: [], metadata: { date: workDate }, meta: { total_cleaners: 0, used_cleaners: 0, assigned_tasks: 0 } };
      }
      // Assicurati che meta esista sempre
      timelineData.meta = timelineData.meta || { total_cleaners: 0, used_cleaners: 0, assigned_tasks: 0 };

      // Trova entrambi i cleaners (creali se non esistono)
      let sourceEntry = timelineData.cleaners_assignments.find((c: any) => c.cleaner.id === sourceCleanerId);
      let destEntry = timelineData.cleaners_assignments.find((c: any) => c.cleaner.id === destCleanerId);

      // Se non esistono, creali con array vuoto (usa PostgreSQL)
      const selectedData = await workspaceFiles.loadSelectedCleaners(workDate);
      
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

      // CRITICAL: Non modificare timelineData.cleaners_assignments
      // Gli entry sourceEntry e destEntry sono riferimenti diretti agli oggetti nell'array
      // quindi lo scambio è già applicato senza dover riassegnare l'array

      // Ricalcola tempi per entrambi i cleaners
      try {
        if (sourceEntry.tasks.length > 0) {
          await hydrateTasksFromContainers(sourceEntry, workDate);
          const updatedSourceData = await recalculateCleanerTimes(sourceEntry);
          sourceEntry.tasks = updatedSourceData.tasks;
          console.log(`✅ Tempi ricalcolati per cleaner ${sourceCleanerId} (dopo swap)`);
        }

        if (destEntry.tasks.length > 0) {
          await hydrateTasksFromContainers(destEntry, workDate);
          const updatedDestData = await recalculateCleanerTimes(destEntry);
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
      await workspaceFiles.saveTimeline(workDate, timelineData, false, modifyingUser, 'swap_cleaners_tasks');

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

      console.log(`📖 GET /api/timeline - Caricamento timeline per ${workDate}`);

      // Carica la timeline da PostgreSQL
      const timeline = await workspaceFiles.loadTimeline(workDate);

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

      console.log(`📖 GET /api/containers - Caricamento containers per ${workDate}`);

      const containers = await workspaceFiles.loadContainers(workDate);

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

      console.log(`✅ Containers caricati per ${workDate}: ${containers.summary?.total_tasks || 0} task totali`);
      res.json(containers);
    } catch (error: any) {
      console.error("Errore nel load dei containers:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  // Endpoint per leggere i cleaners selezionati da PostgreSQL
  // Il frontend dovrebbe usare questo endpoint invece di leggere direttamente selected_cleaners.json
  app.get("/api/selected-cleaners", async (req, res) => {
    try {
      const dateParam = (req.query.date as string) || format(new Date(), "yyyy-MM-dd");
      const workDate = dateParam;

      console.log(`📖 GET /api/selected-cleaners - Caricamento cleaners selezionati per ${workDate}`);

      const selectedCleaners = await workspaceFiles.loadSelectedCleaners(workDate);

      if (!selectedCleaners) {
        return res.json({
          cleaners: [],
          total_selected: 0,
          metadata: { date: workDate }
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
  // Sostituisce la lettura di cleaners.json per il frontend
  app.get("/api/cleaners", async (req, res) => {
    try {
      const dateParam = (req.query.date as string) || format(new Date(), "yyyy-MM-dd");
      const workDate = dateParam;

      console.log(`📖 GET /api/cleaners - Caricamento cleaners per ${workDate}`);

      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      const cleaners = await pgDailyAssignmentsService.loadCleanersForDate(workDate);

      if (!cleaners || cleaners.length === 0) {
        // PostgreSQL is the only source of truth - no filesystem fallback
        console.log(`ℹ️ Nessun cleaner trovato in PostgreSQL per ${workDate}`);
        return res.json({
          cleaners: [],
          total: 0,
          metadata: { date: workDate, source: 'postgresql' }
        });
      }

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

  // GET /api/cleaners-aliases - Carica alias cleaners da cleaner_aliases (permanente)
  app.get("/api/cleaners-aliases", async (req, res) => {
    try {
      const dateParam = req.query.date as string;
      const workDate = dateParam || format(new Date(), "yyyy-MM-dd");

      console.log(`📖 GET /api/cleaners-aliases - Caricamento alias permanenti`);

      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      
      // Load from permanent cleaner_aliases table (date-independent)
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

      console.log(`✅ Alias caricati da cleaner_aliases: ${Object.keys(aliases).length}`);
      res.json({
        aliases,
        metadata: { date: workDate, source: 'cleaner_aliases', last_updated: getRomeTimestamp() }
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
      const { date, timeline } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");

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
      await workspaceFiles.saveTimeline(workDate, timelineData, false, 'python_script', 'api_save_timeline');

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
      const { date, containers } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");

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
      await workspaceFiles.saveContainers(workDate, containersData);

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

  // POST /api/selected-cleaners - Salva selected cleaners (per script Python)
  app.post("/api/selected-cleaners", async (req, res) => {
    try {
      const { date, cleaner_ids, cleaners } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");

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
      await pgDailyAssignmentsService.saveSelectedCleaners(workDate, ids, actionType, null, performedBy);

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
      const { date, cleaners, snapshotReason } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");

      if (!cleaners || !Array.isArray(cleaners)) {
        return res.status(400).json({ success: false, error: "cleaners array required" });
      }

      console.log(`📝 POST /api/cleaners - Salvando ${cleaners.length} cleaners per ${workDate}`);

      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      
      // CRITICAL: Carica gli start_time esistenti da PostgreSQL PRIMA di sovrascrivere
      // Questo preserva gli start_time custom impostati dall'utente
      const existingCleaners = await pgDailyAssignmentsService.loadCleanersForDate(workDate);
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
      
      const success = await pgDailyAssignmentsService.saveCleanersForDate(workDate, mergedCleaners, snapshotReason || 'api_update');

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
      
      const assignments = await pgDailyAssignmentsService.getAssignments(dateParam);
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
        const assignments = await pgDailyAssignmentsService.getHistoryByRevision(dateParam, revisionParam);
        res.json({
          success: true,
          date: dateParam,
          revision: revisionParam,
          count: assignments.length,
          assignments
        });
      } else {
        // Get list of revisions
        const revisions = await pgDailyAssignmentsService.getHistoryRevisions(dateParam);
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

      // Carica containers per ottenere i dati completi del task
      let fullTaskData: any = null;
      let sourceContainerType: string | null = null; // To track where the task came from

      // SEMPRE carica i containers da PostgreSQL - necessario per salvare la history e rimuovere la task
      let containersData = null;
      try {
        containersData = await workspaceFiles.loadContainers(workDate);
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
      let timelineData = await workspaceFiles.loadTimeline(workDate);

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
        const cleanersData = await workspaceFiles.loadSelectedCleaners(workDate) || { cleaners: [] };
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
        straordinaria: Boolean(fullTaskData.straordinaria),

        // Tipo appartamento e alias
        type_apt: fullTaskData.type_apt || null,
        alias: fullTaskData.alias || null,
        customer_name: fullTaskData.customer_name || fullTaskData.type || null,

        // Reasons (combina quelle da containers con quella timeline)
        reasons: [
          ...(fullTaskData.reasons || []),
          'manually_moved_to_timeline'
        ],

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
        const selectedCleanersData = await workspaceFiles.loadSelectedCleaners(workDate);
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
        const updatedCleanerData = await recalculateCleanerTimes(cleanerEntry);
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
      await workspaceFiles.saveTimeline(workDate, timelineData, false, modifyingUserFromRequest, modificationType);

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
            await workspaceFiles.saveContainers(workDate, containersData);
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
      let assignmentsData = await workspaceFiles.loadTimeline(workDate);
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
        removedCount += (initialTaskCountForCleaner - (cleanerEntry.tasks?.length || 0));
        return cleanerEntry;
      }).filter((c: any) => c.tasks.length > 0); // Rimuovi cleaner vuoti

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
      await workspaceFiles.saveTimeline(workDate, assignmentsData, false, modifyingUser, 'task_removed_from_timeline');

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
          
          const containersData = await workspaceFiles.loadContainers(workDate) || { containers: { early_out: { tasks: [] }, high_priority: { tasks: [] }, low_priority: { tasks: [] } }, summary: {} };

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
          await workspaceFiles.saveContainers(workDate, containersData);
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
      const revisions = await pgDailyAssignmentsService.getHistoryRevisions(workDate);

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

      console.log(`📥 Caricamento assegnazioni dal database per ${workDate}...`);

      // Carica timeline, selected_cleaners E CONTAINERS da PostgreSQL via workspace-files
      const timelineData = await workspaceFiles.loadTimeline(workDate);
      const selectedCleanersData = await workspaceFiles.loadSelectedCleaners(workDate);
      let containersData = await workspaceFiles.loadContainers(workDate);

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
      try {
        await new Promise<string>((resolve, reject) => {
          exec(`python3 "${createContainersPath}" --date "${workDate}" --skip-extract --use-api`, (error, stdout, stderr) => {
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
        containersData = await workspaceFiles.loadContainers(workDate);
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
        await workspaceFiles.saveContainers(workDate, containersData, 'system', 'containers_synced_from_adam');
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
        await workspaceFiles.saveTimeline(workDate, timelineData, true, 'system', 'timeline_loaded_from_db');
        const taskCount = timelineData.cleaners_assignments?.reduce((sum: number, c: any) => sum + (c.tasks?.length || 0), 0) || 0;
        console.log(`✅ Timeline sincronizzata da database per ${workDate} (${taskCount} task)`);
      } else {
        // Nessun dato timeline in database - crea struttura vuota
        const emptyTimeline = {
          metadata: { date: workDate, saved_at: getRomeTimestamp() },
          cleaners_assignments: []
        };
        await workspaceFiles.saveTimeline(workDate, emptyTimeline, true, 'system', 'timeline_initialized_empty');
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
      let selectedData: any = await workspaceFiles.loadSelectedCleaners(workDate);
      if (!selectedData) {
        selectedData = { cleaners: [], total_selected: 0 };
      }

      // Carica timeline da PostgreSQL per verificare se il cleaner ha task
      let timelineData: any;
      let hasTasks = false;
      try {
        timelineData = await workspaceFiles.loadTimeline(workDate);

        const cleanerEntry = timelineData?.cleaners_assignments?.find(
          (c: any) => c.cleaner?.id === cleanerId
        );
        hasTasks = cleanerEntry && cleanerEntry.tasks && cleanerEntry.tasks.length > 0;
      } catch (error) {
        // Timeline non esiste, nessuna task
        hasTasks = false;
      }

      // Rimuovi il cleaner da selected_cleaners.json
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
      await pgService.saveSelectedCleaners(workDate, remainingIds, 'removal', { removed_cleaner_id: cleanerId }, currentUsername);

      // Salva selected_cleaners usando workspace helper (filesystem come cache)
      await workspaceFiles.saveSelectedCleaners(workDate, selectedData, false, currentUsername);

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
        await workspaceFiles.saveTimeline(workDate, timelineData, false, currentUsername, 'cleaner_removed_from_selection');

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
      const { cleaners: selectedCleaners, total_selected, date, action_type = 'replace' } = req.body;

      if (!selectedCleaners || !Array.isArray(selectedCleaners)) {
        return res.status(400).json({
          success: false,
          message: "Dati cleaners non validi"
        });
      }

      // Usa la data fornita o la data corrente
      const workDate = date || format(new Date(), 'yyyy-MM-dd');

      // Carica dati completi dei cleaners da PostgreSQL
      const { pgDailyAssignmentsService } = await import('./services/pg-daily-assignments-service');
      const cleanerIds = selectedCleaners.map((c: any) => typeof c === 'number' ? c : c.id);
      const fullCleanersData = await pgDailyAssignmentsService.loadCleanersByIds(cleanerIds, workDate);

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
      await pgService.saveSelectedCleaners(workDate, cleanerIds, action_type, null, currentUsername);
      
      // Salva anche su filesystem per backward compat
      await workspaceFiles.saveSelectedCleaners(workDate, dataToSave, false, currentUsername);

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
      const cleanersFromPg = await pgDailyAssignmentsService.loadCleanersByIds([cleanerId], workDate);
      
      let cleanerData = cleanersFromPg.length > 0 ? cleanersFromPg[0] : null;

      if (!cleanerData) {
        console.error(`Cleaner ${cleanerId} non trovato in PostgreSQL`);
        return res.status(404).json({ success: false, error: "Cleaner non trovato" });
      }

      // Verifica se esiste già uno start_time impostato dall'utente in selected_cleaners
      const selectedCleanersData = await workspaceFiles.loadSelectedCleaners(workDate) || { cleaners: [], total_selected: 0, metadata: { date: workDate } };
      const existingCleaner = selectedCleanersData.cleaners?.find((c: any) => c.id === cleanerId);
      if (existingCleaner?.start_time) {
        cleanerData.start_time = existingCleaner.start_time;
        console.log(`✅ Usando start_time ${existingCleaner.start_time} esistente da PostgreSQL per cleaner ${cleanerId}`);
      } else {
        console.log(`ℹ️ Nessun start_time pre-esistente, usando default ${cleanerData.start_time || '10:00'}`);
      }

      const selectedCleanerIds = new Set(selectedCleanersData.cleaners.map((c: any) => c.id));

      // Carica timeline da PostgreSQL
      let timelineData: any = await workspaceFiles.loadTimeline(workDate);
      
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
            const updatedData = await recalculateCleanerTimes(cleanerToReplace);
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
      await workspaceFiles.saveTimeline(workDate, timelineData, false, currentUsername, replacedCleanerId ? 'cleaner_replaced' : 'cleaner_added_to_timeline');

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
      await workspaceFiles.saveSelectedCleaners(workDate, selectedCleanersData, false, currentUsername);

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
      const cleanersData = await workspaceFiles.loadSelectedCleaners(workDate) || { cleaners: [] };

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
        straordinaria: task.straordinaria,
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
      const containersData: any = await workspaceFiles.loadContainers(workDate);

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
          await workspaceFiles.saveContainers(workDate, containersData);

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
        await workspaceFiles.saveContainers(workDate, containersData);

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
      await workspaceFiles.saveContainers(workDate, containersData);

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

      if (!cleanerId || !startTime || !date) {
        return res.status(400).json({
          success: false,
          message: "cleanerId, startTime e date sono richiesti"
        });
      }

      const workDate = date;
      const currentUsername = modified_by || getCurrentUsername(req);

      // Carica selected_cleaners da PostgreSQL
      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      const selectedCleanersResult = await workspaceFiles.loadSelectedCleaners(workDate);
      let selectedCleanersData = selectedCleanersResult || {
        cleaners: [],
        total_selected: 0,
        metadata: { date: workDate }
      };

      // Trova e aggiorna il cleaner se esiste
      const cleanerIndex = selectedCleanersData.cleaners.findIndex((c: any) => c.id === cleanerId);
      if (cleanerIndex !== -1) {
        selectedCleanersData.cleaners[cleanerIndex].start_time = startTime;
      } else {
        // CRITICAL: Se il cleaner non esiste ancora in selected_cleaners,
        // caricalo da PostgreSQL e aggiungilo con lo start_time
        const cleaners = await pgDailyAssignmentsService.loadCleanersForDate(workDate);
        let cleanerData = cleaners?.find((c: any) => c.id === cleanerId);

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
      await pgDailyAssignmentsService.updateCleanerField(cleanerId, workDate, 'start_time', startTime);

      // Salva selected_cleaners su PostgreSQL (skipRevision=true)
      await workspaceFiles.saveSelectedCleaners(workDate, selectedCleanersData, true);

      // Aggiorna anche la timeline se il cleaner è presente
      try {
        const timelineData = await workspaceFiles.loadTimeline(workDate);
        if (timelineData) {
          const cleanerAssignment = timelineData.cleaners_assignments?.find((ca: any) => ca.cleaner?.id === cleanerId);
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
            await workspaceFiles.saveTimeline(workDate, timelineData, true);
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

  // Endpoint per aggiornare i dettagli di una task (checkout, checkin, durata)
  // skipAdam: se true, aggiorna SOLO PostgreSQL e non propaga su ADAM
  app.post("/api/update-task-details", async (req, res) => {
    try {
      const { taskId, logisticCode, checkoutDate, checkoutTime, checkinDate, checkinTime, cleaningTime, paxIn, paxOut, operationId, date, modified_by, skipAdam } = req.body;

      if (!taskId && !logisticCode) {
        return res.status(400).json({ success: false, error: "taskId o logisticCode richiesto" });
      }

      const workDate = date || format(new Date(), 'yyyy-MM-dd');
      const currentUsername = modified_by || getCurrentUsername(req);

      // Carica entrambi da PostgreSQL
      const [containersData, timelineData] = await Promise.all([
        workspaceFiles.loadContainers(workDate).then(d => d || { containers: {} }),
        workspaceFiles.loadTimeline(workDate).then(d => d || { cleaners_assignments: [] })
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
      await workspaceFiles.saveContainers(workDate, containersData);
      
      // Salva timeline con tracking delle modifiche (skipRevision=false per creare revision in PostgreSQL)
      await workspaceFiles.saveTimeline(workDate, timelineData, false, currentUsername, 'task_edit', editOptions);

      // CRITICAL: Propaga le modifiche al database ADAM (app_housekeeping)
      // SOLO se skipAdam non è true
      if (taskId && !skipAdam) {
        try {
          const mysql = await import('mysql2/promise');
          const connection = await mysql.createConnection({
            host: "139.59.132.41",
            user: "admin",
            password: "ed329a875c6c4ebdf4e87e2bbe53a15771b5844ef6606dde",
            database: "adamdb",
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

  // Endpoint per estrarre statistiche task per convocazioni
  app.post("/api/extract-convocazioni-tasks", async (req, res) => {
    try {
      const { date } = req.body;
      const scriptPath = path.join(process.cwd(), 'client', 'public', 'scripts', 'extract_tasks_for_convocazioni.py');

      // Se la data è fornita, passala come argomento allo script
      const command = date
        ? `python3 ${scriptPath} ${date}`
        : `python3 ${scriptPath}`;

      console.log("Eseguendo extract_tasks_for_convocazioni.py con comando:", command);

      const { stdout, stderr } = await execAsync(command, { maxBuffer: 1024 * 1024 * 10 });

      if (stderr && !stderr.includes('Browserslist')) {
        console.error("Errore extract_tasks_for_convocazioni:", stderr);
      }

      console.log("extract_tasks_for_convocazioni output:", stdout);

      res.json({
        success: true,
        message: 'Statistiche task per convocazioni estratte con successo',
        output: stdout
      });
    } catch (error: any) {
      console.error("Errore durante l'estrazione delle statistiche task per convocazioni:", error);
      res.status(500).json({
        success: false,
        message: "Errore durante l'estrazione delle statistiche task per convocazioni",
        error: error.message,
        stderr: error.stderr
      });
    }
  });

  // Endpoint rimosso: get-operation-names non più necessario

  // Endpoint per trasferire le assegnazioni a ADAM MySQL (Node.js, non Python)
  app.post("/api/transfer-to-adam", async (req, res) => {
    // Helper per convertire date ISO in formato MySQL YYYY-MM-DD
    const formatDateForMySQL = (dateValue: string | null | undefined): string | null => {
      if (!dateValue) return null;
      // Se è già in formato YYYY-MM-DD, restituiscilo
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
        return dateValue;
      }
      // Se è in formato ISO (2025-12-13T00:00:00.000Z), estrai solo la data
      if (dateValue.includes('T')) {
        return dateValue.split('T')[0];
      }
      // Prova a parsare come Date
      try {
        const d = new Date(dateValue);
        if (!isNaN(d.getTime())) {
          return d.toISOString().split('T')[0];
        }
      } catch {
        // ignore
      }
      return null;
    };

    try {
      const { date, username: reqUsername, pendingTaskEdits = {} } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      const username = reqUsername || "system";

      console.log(`🔄 Trasferimento assegnazioni a ADAM per ${workDate}...`);

      // CRITICAL: Le modifiche pendenti vengono salvate dal frontend quando viene cliccato il bottone
      // Il frontend passa le pendingTaskEdits per informazione, ma il salvataggio avviene già sul frontend
      if (Object.keys(pendingTaskEdits).length > 0) {
        console.log(`💾 Ricevute ${Object.keys(pendingTaskEdits).length} task modificate da salvare al prossimo trasferimento`);
      }

      // Carica timeline da PostgreSQL
      const timelineData = await workspaceFiles.loadTimeline(workDate);
      if (!timelineData || !timelineData.cleaners_assignments || timelineData.cleaners_assignments.length === 0) {
        console.log("⚠️ Nessuna assegnazione trovata per il trasferimento");
        return res.json({
          success: false,
          message: "Nessuna assegnazione trovata nella timeline"
        });
      }

      // Verifica se creare una nuova revision: solo se l'utente è diverso dall'ultimo
      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      const lastRevisionUser = await pgDailyAssignmentsService.getLastRevisionUser(workDate);
      let revisionCreated = false;
      
      if (lastRevisionUser && lastRevisionUser !== username) {
        // Utente diverso: crea nuova revision
        console.log(`📝 Utente diverso (ultimo: ${lastRevisionUser}, corrente: ${username}) - creazione nuova revision`);
        await pgDailyAssignmentsService.saveToHistory(
          workDate, 
          timelineData, 
          username, 
          'transfer_to_adam',
          [],
          [],
          []
        );
        revisionCreated = true;
      } else {
        console.log(`📝 Stesso utente (${username}) - nessuna nuova revision creata`);
      }

      // Recupera adam_id dell'utente per usarlo come updated_by
      const { pgUsersService } = await import("./services/pg-users-service");
      const userRecord = await pgUsersService.getUserByUsername(username);
      const adamUpdatedBy = userRecord?.adam_id ? `E${userRecord.adam_id}` : username;
      console.log(`📝 updated_by per ADAM: ${adamUpdatedBy} (adam_id: ${userRecord?.adam_id || 'N/A'})`);

      // Connessione MySQL a ADAM
      let connection: any = null;
      let totalUpdated = 0;
      let totalErrors = 0;
      const errors: string[] = [];

      try {
        connection = await mysql.createConnection({
          host: "139.59.132.41",
          user: "admin",
          password: "ed329a875c6c4ebdf4e87e2bbe53a15771b5844ef6606dde",
          database: "adamdb",
          waitForConnections: true,
          connectionLimit: 1,
          queueLimit: 0
        });
        console.log("✅ Connessione MySQL ADAM stabilita");
      } catch (dbError: any) {
        console.error("❌ Errore connessione ADAM MySQL:", dbError.message);
        return res.json({
          success: false,
          message: `Errore connessione database ADAM: ${dbError.message}`
        });
      }

      try {
        // Itera su cleaners e tasks
        for (const cleanerEntry of timelineData.cleaners_assignments) {
          const cleanerId = cleanerEntry.cleaner?.id;
          const tasks = cleanerEntry.tasks || [];

          for (const task of tasks) {
            try {
              const taskId = task.task_id;
              if (!taskId) continue;

              const query = `
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
                  updated_at = ?
                WHERE id = ?
              `;

              const values = [
                formatDateForMySQL(task.checkout_date),
                task.checkout_time ?? null,
                formatDateForMySQL(task.checkin_date),
                task.checkin_time ?? null,
                task.pax_in ?? null,
                task.operation_id ?? null,
                cleanerId ?? null,
                task.sequence ?? null,
                adamUpdatedBy,
                getRomeTimestamp().replace('T', ' ').substring(0, 19)
              ];

              await connection.execute(query, [...values, taskId]);
              totalUpdated++;
              console.log(`✅ Task ${task.logistic_code} (ID: ${taskId}) trasferita su ADAM`);

            } catch (taskError: any) {
              totalErrors++;
              const errorMsg = `Task ${task.logistic_code}: ${taskError.message}`;
              errors.push(errorMsg);
              console.error(`❌ ${errorMsg}`);
            }
          }
        }

        console.log(`\n✅ Trasferimento completato! (${totalUpdated} task aggiornate, ${totalErrors} errori${revisionCreated ? ', nuova revision creata' : ''})`);

        res.json({
          success: true,
          message: `Trasferimento completato: ${totalUpdated} task aggiornate${totalErrors > 0 ? `, ${totalErrors} errori` : ''}${revisionCreated ? ' (nuova revision creata)' : ''}`,
          stats: {
            updated: totalUpdated,
            errors: totalErrors,
            errorDetails: errors,
            revisionCreated
          }
        });

      } finally {
        if (connection) {
          await connection.end();
        }
      }

    } catch (error: any) {
      console.error("❌ Errore trasferimento a ADAM:", error.message);
      res.status(500).json({
        success: false,
        message: `Errore trasferimento: ${error.message}`
      });
    }
  });

  // Endpoint per estrarre i cleaners (versione ottimizzata)
  app.post("/api/extract-cleaners-optimized", async (req, res) => {
    try {
      const { date } = req.body;
      const scriptPath = path.join(process.cwd(), 'client', 'public', 'scripts', 'extract_cleaners_optimized.py');

      // Se la data è fornita, passala come argomento allo script
      const command = date
        ? `python3 ${scriptPath} ${date}`
        : `python3 ${scriptPath}`;

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

  // Nuovi endpoint per assegnazione diretta a timeline.json
  app.post("/api/assign-early-out-to-timeline", async (req, res) => {
    try {
      const { date } = req.body;
      const workDate = date || format(new Date(), 'yyyy-MM-dd');

      console.log(`📅 EO Assignment - Ricevuta data dal frontend: ${workDate}`);
      console.log(`▶ Eseguendo assign_eo.py per data: ${workDate}`);

      // CRITICO: Prima di eseguire lo script, assicurati che la timeline abbia la data corretta
      try {
        const timelineData = await workspaceFiles.loadTimeline(workDate);
        if (timelineData && timelineData.metadata?.date !== workDate) {
          console.log(`⚠️ ATTENZIONE: timeline ha data ${timelineData.metadata?.date}, dovrebbe essere ${workDate}`);
          console.log(`🔄 Aggiornamento data in timeline...`);
          timelineData.metadata = timelineData.metadata || {};
          timelineData.metadata.date = workDate;
          await workspaceFiles.saveTimeline(workDate, timelineData);
        }
      } catch (err) {
        console.warn("Impossibile verificare/aggiornare timeline:", err);
      }

      const { spawn } = await import('child_process');
      const scriptPath = path.join(process.cwd(), 'client/public/scripts/assign_eo.py');

      const pythonProcess = spawn('python3', [scriptPath, workDate, '--use-api'], {
        cwd: process.cwd()
      });

      let stdoutData = '';
      pythonProcess.stdout.on('data', (data) => {
        stdoutData += data.toString();
      });

      let stderrData = '';
      pythonProcess.stderr.on('data', (data) => {
        stderrData += data.toString();
        console.error(`assign_eo.py stderr: ${data}`);
      });

      pythonProcess.on('close', async (code) => {
        if (code !== 0) {
          console.error(`assign_eo.py exited with code ${code}`);
          res.status(500).json({
            success: false,
            message: "Early Out assegnazione fallita",
            stderr: stderrData,
            stdout: stdoutData
          });
          return;
        }

        console.log("assign_eo output:", stdoutData);

        // Python script salva direttamente via API - nessun filesystem da leggere
        console.log(`✅ assign_eo.py ha salvato direttamente su PostgreSQL via API`);

        res.json({
          success: true,
          message: "Early Out tasks assegnati con successo",
          output: stdoutData
        });
      });

    } catch (error: any) {
      console.error("Errore durante l'assegnazione EO a timeline:", error);
      res.status(500).json({
        success: false,
        error: error.message,
        stderr: error.stderr || "N/A"
      });
    }
  });

  app.post("/api/assign-high-priority-to-timeline", async (req, res) => {
    try {
      const { date } = req.body;
      const workDate = date || format(new Date(), 'yyyy-MM-dd');

      console.log(`📅 HP Assignment - Ricevuta data dal frontend: ${workDate}`);
      console.log(`▶ Eseguendo assign_hp.py per data: ${workDate}`);

      // Verifica che la timeline abbia la data corretta
      try {
        const timelineData = await workspaceFiles.loadTimeline(workDate);
        if (timelineData && timelineData.metadata?.date !== workDate) {
          console.log(`⚠️ ATTENZIONE: timeline ha data ${timelineData.metadata?.date}, dovrebbe essere ${workDate}`);
          timelineData.metadata = timelineData.metadata || {};
          timelineData.metadata.date = workDate;
          await workspaceFiles.saveTimeline(workDate, timelineData);
        }
      } catch (err) {
        console.warn("Impossibile verificare timeline:", err);
      }

      const { spawn } = await import('child_process');
      const scriptPath = path.join(process.cwd(), 'client/public/scripts/assign_hp.py');

      const pythonProcess = spawn('python3', [scriptPath, workDate, '--use-api'], {
        cwd: process.cwd()
      });

      let stdoutData = '';
      pythonProcess.stdout.on('data', (data) => {
        stdoutData += data.toString();
      });

      let stderrData = '';
      pythonProcess.stderr.on('data', (data) => {
        stderrData += data.toString();
        console.error(`assign_hp.py stderr: ${data}`);
      });

      pythonProcess.on('close', async (code) => {
        if (code !== 0) {
          console.error(`assign_hp.py exited with code ${code}`);
          res.status(500).json({
            success: false,
            message: "High Priority assegnazione fallita",
            stderr: stderrData,
            stdout: stdoutData
          });
          return;
        }

        console.log("assign_hp output:", stdoutData);

        // Python script salva direttamente via API - nessun filesystem da leggere
        console.log(`✅ assign_hp.py ha salvato direttamente su PostgreSQL via API`);

        res.json({
          success: true,
          message: "High Priority tasks assegnati con successo",
          output: stdoutData
        });
      });

    } catch (error: any) {
      console.error("Errore durante l'assegnazione HP a timeline:", error);
      res.status(500).json({
        success: false,
        error: error.message,
        stderr: error.stderr || "N/A"
      });
    }
  });

  app.post("/api/assign-low-priority-to-timeline", async (req, res) => {
    try {
      const { date } = req.body;
      const workDate = date || format(new Date(), 'yyyy-MM-dd');

      console.log(`📅 LP Assignment - Ricevuta data dal frontend: ${workDate}`);
      console.log(`▶ Eseguendo assign_lp.py per data: ${workDate}`);

      // Verifica che la timeline esista e abbia la data corretta prima di procedere
      try {
        const timelineData = await workspaceFiles.loadTimeline(workDate);
        if (timelineData && timelineData.metadata?.date !== workDate) {
          console.log(`⚠️ ATTENZIONE: timeline ha data ${timelineData.metadata?.date}, dovrebbe essere ${workDate}`);
          timelineData.metadata = timelineData.metadata || {};
          timelineData.metadata.date = workDate;
          await workspaceFiles.saveTimeline(workDate, timelineData);
        }
      } catch (err) {
        console.warn("Impossibile verificare timeline:", err);
      }

      const { spawn } = await import('child_process');
      const scriptPath = path.join(process.cwd(), 'client/public/scripts/assign_lp.py');

      const pythonProcess = spawn('python3', [scriptPath, workDate, '--use-api'], {
        cwd: process.cwd()
      });

      let stdoutData = '';
      pythonProcess.stdout.on('data', (data) => {
        stdoutData += data.toString();
      });

      let stderrData = '';
      pythonProcess.stderr.on('data', (data) => {
        stderrData += data.toString();
        console.error(`assign_lp.py stderr: ${data}`);
      });

      pythonProcess.on('close', async (code) => {
        if (code !== 0) {
          console.error(`assign_lp.py exited with code ${code}`);
          res.status(500).json({
            success: false,
            message: "Low Priority assegnazione fallita",
            stderr: stderrData,
            stdout: stdoutData
          });
          return;
        }

        console.log("assign_lp output:", stdoutData);

        // Python script salva direttamente via API - nessun filesystem da leggere
        console.log(`✅ assign_lp.py ha salvato direttamente su PostgreSQL via API`);

        res.json({
          success: true,
          message: "Low Priority tasks assegnati con successo",
          output: stdoutData
        });
      });

    } catch (error: any) {
      console.error("Errore durante l'assegnazione LP a timeline:", error);
      res.status(500).json({
        success: false,
        error: error.message,
        stderr: error.stderr || "N/A"
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
      const { date, created_by } = req.body;
      const createdBy = created_by || 'unknown';
      const assignedDir = path.join(process.cwd(), 'client/public/data/assigned');

      // CRITICAL: Esegui extract_cleaners_optimized.py ma non bloccare se fallisce
      console.log(`🔄 Estrazione cleaners dal database per ${date}...`);
      let extractCleanersResult = '';
      try {
        const extractResult = await new Promise<string>((resolve, reject) => {
          exec(
            `python3 client/public/scripts/extract_cleaners_optimized.py ${date}`,
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
        const existingTimeline = await workspaceFiles.loadTimeline(date);

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
            await workspaceFiles.saveTimeline(date, existingTimeline);
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
        await workspaceFiles.saveTimeline(date, emptyTimeline);
        timelineExists = false;
      }

      // CRITICAL: Gestione selected_cleaners via PostgreSQL
      // Carica selected_cleaners correnti da PostgreSQL
      const currentSelectedData = await workspaceFiles.loadSelectedCleaners(date);
      const currentSelectedDate = currentSelectedData?.metadata?.date || null;

      // Verifica se esistono dati salvati per la data target
      let hasExistingTimeline = false;
      let timelineDataForCheck: any = null;
      try {
        timelineDataForCheck = await workspaceFiles.loadTimeline(date);
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
        await workspaceFiles.saveSelectedCleaners(date, emptySelection, true);
        console.log(`ℹ️ selected_cleaners resettato in PostgreSQL per ${date}`);
      } else if (currentSelectedDate !== date && hasExistingTimeline) {
        console.log(`✅ Data cambiata da ${currentSelectedDate} a ${date} - mantieni dati esistenti (timeline con ${timelineDataForCheck.cleaners_assignments.length} cleaners)`);
        // Ricostruisci selected_cleaners dalla timeline esistente
        const cleanersInTimeline = timelineDataForCheck.cleaners_assignments.map((ca: any) => ca.cleaner).filter(Boolean);

        const selectionFromTimeline = {
          cleaners: cleanersInTimeline,
          total_selected: cleanersInTimeline.length,
          metadata: { date }
        };
        await workspaceFiles.saveSelectedCleaners(date, selectionFromTimeline, true);
        console.log(`✅ selected_cleaners ricostruito da timeline in PostgreSQL per ${date}`);
      } else {
        console.log(`✅ Stessa data (${date}) - mantieni selected_cleaners`);
      }

      // Esegui SEMPRE create_containers.py per avere dati freschi dal database
      console.log(`Eseguendo create_containers.py per data ${date}...`);
      const containersResult = await new Promise<string>((resolve, reject) => {
        exec(
          `python3 client/public/scripts/create_containers.py --date ${date} --use-api`,
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

      const parsed = JSON.parse(stdout);

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

  // Endpoint for running the optimizer script
  app.post("/api/run-optimizer", async (req, res) => {
    try {
      const { date } = req.body;
      if (!date) {
        return res.status(400).json({
          success: false,
          message: "Data mancante nella richiesta"
        });
      }
      const workDate = date;

      const { spawn } = await import('child_process');
      const scriptPath = path.join(process.cwd(), 'client/public/scripts/assign_eo.py');

      console.log(`Eseguendo assign_eo.py per data ${workDate}...`);

      const pythonProcess = spawn('python3', [scriptPath, workDate]);

      let stdoutData = '';
      pythonProcess.stdout.on('data', (data) => {
        stdoutData += data.toString();
      });

      let stderrData = '';
      pythonProcess.stderr.on('data', (data) => {
        stderrData += data.toString();
        console.error(`assign_eo.py stderr: ${data}`);
      });

      pythonProcess.on('close', (code) => {
        if (code !== 0) {
          console.error(`assign_eo.py exited with code ${code}`);
          res.status(500).json({
            success: false,
            message: "Optimizer execution failed",
            stderr: stderrData,
            stdout: stdoutData
          });
          return;
        }

        console.log("assign_eo output:", stdoutData);
        res.json({
          success: true,
          message: "Optimizer executed successfully",
          output: stdoutData,
        });
      });

    } catch (error: any) {
      console.error("Errore nell'esecuzione di assign_eo.py:", error);
      res.status(500).json({
        success: false,
        message: "Optimizer execution failed",
        error: error.message,
        stderr: error.stderr || "N/A",
        stdout: error.stdout || "N/A"
      });
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

      let timelineData: any = { metadata: {}, cleaners_assignments: [] };
      let containersData: any = null;

      try {
        timelineData = await workspaceFiles.loadTimeline(workDate);
        if (!timelineData) {
          timelineData = { metadata: { date: workDate }, cleaners_assignments: [] };
        }
      } catch (err) {
        console.error('Errore caricamento timeline:', err);
      }

      try {
        containersData = await workspaceFiles.loadContainers(workDate);
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
          const selectedData = await workspaceFiles.loadSelectedCleaners(workDate);
          let cleanerInfo = selectedData?.cleaners?.find((c: any) => c.id === toCleanerId);

          // Se non trovato, cerca in cleaners per la data
          if (!cleanerInfo) {
            const allCleaners = await pgDailyAssignmentsService.loadCleanersForDate(workDate);
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
        const updatedDst = await recalculateCleanerTimes(dstEntry);
        dstEntry.tasks = updatedDst.tasks;
        console.log(`✅ Tempi ricalcolati per cleaner ${toCleanerId} dopo inserimento`);

        // Se c'è un cleaner sorgente diverso, ricalcola anche quello
        if (typeof fromCleanerId === 'number' && fromCleanerId !== toCleanerId) {
          const srcEntry = getCleanerEntry(fromCleanerId);
          if (srcEntry && srcEntry.tasks.length > 0) {
            await hydrateTasksFromContainers(srcEntry, workDate);
            const updatedSrc = await recalculateCleanerTimes(srcEntry);
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
      } else if (fromCleanerId === toCleanerId) {
        modificationType = 'task_reordered_same_cleaner';
      } else if (typeof fromCleanerId === 'number') {
        modificationType = 'dnd_between_cleaners';
      }

      // Save the updated timeline
      const saved = await workspaceFiles.saveTimeline(workDate, timelineData, false, req.body.currentUser?.username || 'unknown', modificationType);

      if (containersData) {
        await workspaceFiles.saveContainers(workDate, containersData);
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
      let timelineData: any = await workspaceFiles.loadTimeline(workDate);
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
        const updatedCleanerData = await recalculateCleanerTimes(cleanerEntry);
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

      // Salva timeline (dual-write: filesystem + Object Storage)
      await workspaceFiles.saveTimeline(workDate, timelineData, false, modifyingUser, 'task_reordered_same_cleaner');

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

  // Endpoint per migrare gli alias da JSON a cleaner_aliases (tabella permanente)
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
      
      // Use new bulk import function to cleaner_aliases table
      const migrated = await pgDailyAssignmentsService.importAliasesFromJson(aliases);

      console.log(`✅ Migrati ${migrated} alias da JSON a cleaner_aliases`);
      res.json({ success: true, message: `Migrati ${migrated} alias a cleaner_aliases`, migrated });
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
      let timelineData = await workspaceFiles.loadTimeline(workDate);
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
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        port: parseInt(process.env.DB_PORT || '3306')
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
        await workspaceFiles.saveTimeline(workDate, timelineData, false, 'system', 'sync_from_adam');
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

  const httpServer = createServer(app);
  return httpServer;
}