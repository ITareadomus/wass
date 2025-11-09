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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const execAsync = promisify(exec);

// Costante bucket per Object Storage
const BUCKET = "wass_assignments";

// Utility: costruzione chiave file consistente
function buildKey(isoDate: string) {
  const d = new Date(isoDate);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const fullYear = String(d.getFullYear());
  const year = fullYear.slice(-2);
  const folder = `${day}-${month}-${fullYear}`;
  const filename = `assignments_${day}${month}${year}.json`;
  return { key: `${folder}/${filename}`, d };
}

/**
 * Helper function to recalculate travel_time, start_time, end_time for a cleaner's tasks
 */
async function recalculateCleanerTimes(cleanerData: any): Promise<any> {
  try {
    const { spawn } = await import('child_process');

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
      const { date } = req.body;
      const workDate = date || format(new Date(), 'yyyy-MM-dd');
      const timelinePath = path.join(process.cwd(), 'client/public/data/output/timeline.json');

      // Svuota il file timeline.json con struttura corretta
      const emptyTimeline = {
        metadata: {
          last_updated: new Date().toISOString(),
          date: workDate
        },
        cleaners_assignments: [],
        meta: {
          total_cleaners: 0,
          used_cleaners: 0,
          assigned_tasks: 0
        }
      };

      // Scrittura atomica
      const tmpPath = `${timelinePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(emptyTimeline, null, 2));
      await fs.rename(tmpPath, timelinePath);
      console.log(`Timeline resettata: timeline.json (struttura corretta)`);

      // FORZA la ricreazione di containers.json rieseguendo create_containers.py
      console.log(`Rieseguendo create_containers.py per ripristinare i containers...`);
      const containersResult = await new Promise<string>((resolve, reject) => {
        exec(
          `python3 client/public/scripts/create_containers.py ${workDate}`,
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

      // CRITICAL: Forza nuovamente il reset di timeline.json dopo create_containers
      // perché lo script Python potrebbe aver sovrascritto il file
      console.log(`🔄 Forzatura reset timeline.json dopo create_containers...`);
      const tmpPath2 = `${timelinePath}.tmp`;
      await fs.writeFile(tmpPath2, JSON.stringify(emptyTimeline, null, 2));
      await fs.rename(tmpPath2, timelinePath);
      console.log(`✅ Timeline resettata nuovamente dopo create_containers`);

      // CRITICAL: Elimina il flag di ultimo salvataggio per evitare ricaricamenti automatici
      console.log(`🗑️ Reset flag ultimo salvataggio per data ${workDate}`);
      // Il frontend gestirà la rimozione del localStorage

      // === MODIFICATO: Non svuotare più selected_cleaners.json automaticamente ===
      // I cleaners selezionati rimangono persistenti tra le pagine
      // Verranno svuotati SOLO quando l'utente cambia effettivamente data
      try {
        const selectedCleanersPath = path.join(
          process.cwd(),
          'client/public/data/cleaners/selected_cleaners.json'
        );

        // Leggi il file attuale
        let currentData;
        try {
          const content = await fs.readFile(selectedCleanersPath, 'utf8');
          currentData = JSON.parse(content);
        } catch (e) {
          // Se il file non esiste, crea uno vuoto
          currentData = {
            cleaners: [],
            total_selected: 0,
            metadata: { 
              date: workDate,
              reset_at: new Date().toISOString()
            }
          };
        }

        // Svuota SOLO se la data è diversa da quella salvata
        const savedDate = currentData.metadata?.date;
        if (savedDate !== workDate) {
          console.log(`🔄 Cambio data da ${savedDate} a ${workDate} - reset selected_cleaners.json`);
          const emptySelectedCleaners = {
            cleaners: [],
            total_selected: 0,
            metadata: { 
              date: workDate,
              reset_at: new Date().toISOString()
            }
          };

          const tmpScPath = `${selectedCleanersPath}.tmp`;
          await fs.writeFile(tmpScPath, JSON.stringify(emptySelectedCleaners, null, 2));
          await fs.rename(tmpScPath, selectedCleanersPath);
          console.log(`🗑️ selected_cleaners.json svuotato per nuova data ${workDate}`);
        } else {
          console.log(`✅ Stessa data (${workDate}) - selected_cleaners.json NON modificato`);
        }
      } catch (e) {
        console.warn('⚠️ Errore gestione selected_cleaners.json:', e);
      }
      // === END ===

      res.json({ success: true, message: "Timeline resettata con successo" });
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
      const timelinePath = path.join(process.cwd(), 'client/public/data/output/timeline.json');

      // Carica timeline.json
      let timelineData: any = JSON.parse(await fs.readFile(timelinePath, 'utf8'));

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
        // Carica i dati del cleaner da selected_cleaners.json
        const cleanersPath = path.join(process.cwd(), 'client/public/data/cleaners/selected_cleaners.json');
        const cleanersData = JSON.parse(await fs.readFile(cleanersPath, 'utf8'));
        const cleanerInfo = cleanersData.cleaners.find((c: any) => c.id === destCleanerId);

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
          const updatedSourceData = await recalculateCleanerTimes(sourceEntry);
          sourceEntry.tasks = updatedSourceData.tasks;
          console.log(`✅ Tempi ricalcolati per cleaner sorgente ${sourceCleanerId}`);
        }

        // Ricalcola cleaner di destinazione
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

      // 5. Aggiorna metadata (mantieni cleaner anche se vuoti)
      timelineData.metadata = timelineData.metadata || {};
      timelineData.metadata.last_updated = new Date().toISOString();
      timelineData.metadata.date = workDate;
      timelineData.meta.total_cleaners = timelineData.cleaners_assignments.length;
      timelineData.meta.total_tasks = timelineData.cleaners_assignments.reduce(
        (sum: number, c: any) => sum + c.tasks.length,
        0
      );

      // Scrittura atomica
      const tmpPath = `${timelinePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(timelineData, null, 2));
      await fs.rename(tmpPath, timelinePath);

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
      const { sourceCleanerId, destCleanerId, date } = req.body;

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
      const timelinePath = path.join(process.cwd(), 'client/public/data/output/timeline.json');

      // Carica timeline.json
      let timelineData: any = JSON.parse(await fs.readFile(timelinePath, 'utf8'));

      // Trova entrambi i cleaners (creali se non esistono)
      let sourceEntry = timelineData.cleaners_assignments.find((c: any) => c.cleaner.id === sourceCleanerId);
      let destEntry = timelineData.cleaners_assignments.find((c: any) => c.cleaner.id === destCleanerId);

      // Se non esistono, creali con array vuoto
      if (!sourceEntry) {
        const selectedCleanersPath = path.join(process.cwd(), 'client/public/data/cleaners/selected_cleaners.json');
        const selectedData = JSON.parse(await fs.readFile(selectedCleanersPath, 'utf8'));
        const cleanerData = selectedData.cleaners.find((c: any) => c.id === sourceCleanerId);

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
        const selectedCleanersPath = path.join(process.cwd(), 'client/public/data/cleaners/selected_cleaners.json');
        const selectedData = JSON.parse(await fs.readFile(selectedCleanersPath, 'utf8'));
        const cleanerData = selectedData.cleaners.find((c: any) => c.id === destCleanerId);

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
          const updatedSourceData = await recalculateCleanerTimes(sourceEntry);
          sourceEntry.tasks = updatedSourceData.tasks;
          console.log(`✅ Tempi ricalcolati per cleaner ${sourceCleanerId} (dopo swap)`);
        }

        if (destEntry.tasks.length > 0) {
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

      // Aggiorna metadata (mantieni cleaner anche se vuoti)
      timelineData.metadata = timelineData.metadata || {};
      timelineData.metadata.last_updated = new Date().toISOString();
      timelineData.metadata.date = workDate;
      timelineData.meta.total_cleaners = timelineData.cleaners_assignments.length;
      timelineData.meta.total_tasks = timelineData.cleaners_assignments.reduce(
        (sum: number, c: any) => sum + c.tasks.length,
        0
      );

      // Scrittura atomica
      const tmpPath = `${timelinePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(timelineData, null, 2));
      await fs.rename(tmpPath, timelinePath);

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

  // Endpoint per salvare un'assegnazione nella timeline
  app.post("/api/save-timeline-assignment", async (req, res) => {
    try {
      const { taskId, cleanerId, logisticCode, date, dropIndex, taskData, priority } = req.body;
      const workDate = date || format(new Date(), 'yyyy-MM-dd');
      const timelinePath = path.join(process.cwd(), 'client/public/data/output/timeline.json');
      const containersPath = path.join(process.cwd(), 'client/public/data/output/containers.json');

      // Carica containers per ottenere i dati completi del task
      let fullTaskData: any = null;
      let sourceContainerType: string | null = null; // To track where the task came from

      // Load containers data only if taskData is not provided or incomplete
      let containersData = null;
      if (!taskData) {
        try {
          containersData = JSON.parse(await fs.readFile(containersPath, 'utf8'));
        } catch (error) {
          console.error(`Failed to read ${containersPath}:`, error);
          // Continue without containers data, will rely on taskData
        }
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


      // Carica o crea il file timeline con nuova struttura
      let timelineData: any = {
        cleaners_assignments: [],
        current_date: workDate,
        meta: {
          total_cleaners: 0,
          total_tasks: 0,
          last_updated: new Date().toISOString()
        }
      };

      try {
        const existingData = await fs.readFile(timelinePath, 'utf8');
        timelineData = JSON.parse(existingData);

        // Migrazione da vecchia struttura a nuova se necessario
        if (timelineData.assignments && !timelineData.cleaners_assignments) {
          timelineData.cleaners_assignments = [];
          timelineData.meta = {
            total_cleaners: 0,
            total_tasks: 0,
            last_updated: new Date().toISOString()
          };
        }
      } catch (error) {
        console.log(`Creazione nuovo file timeline per ${workDate}`);
      }

      const normalizedLogisticCode = String(logisticCode);
      const normalizedTaskId = String(taskId);
      const normalizedCleanerId = Number(cleanerId);

      // Trova o crea l'entry per questo cleaner
      let cleanerEntry = timelineData.cleaners_assignments.find(
        (c: any) => c.cleaner.id === normalizedCleanerId
      );

      if (!cleanerEntry) {
        // Carica dati del cleaner da selected_cleaners.json
        const cleanersPath = path.join(process.cwd(), 'client/public/data/cleaners/selected_cleaners.json');
        let cleanersData;
        try {
          const cleanersRawData = await fs.readFile(cleanersPath, 'utf8');
          cleanersData = JSON.parse(cleanersRawData);
        } catch (error) {
          console.error(`Failed to read ${cleanersPath}:`, error);
          // Fallback to default cleaner info if file is missing
          cleanersData = { cleaners: [] };
        }

        const cleanerInfo = cleanersData.cleaners.find((c: any) => c.id === normalizedCleanerId);

        cleanerEntry = {
          cleaner: {
            id: normalizedCleanerId,
            name: cleanerInfo?.name || 'Unknown',
            lastname: cleanerInfo?.lastname || '',
            role: cleanerInfo?.role || 'Standard',
            premium: cleanerInfo?.premium || false
          },
          assignment_type: 'manual_drag',
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
      };

      console.log('📝 Task salvato in timeline:', {
        task_id: taskForTimeline.task_id,
        logistic_code: taskForTimeline.logistic_code,
        cleaning_time: taskForTimeline.cleaning_time,
        priority: taskForTimeline.priority
      });

      // Inserisci in posizione dropIndex
      const targetIndex = dropIndex !== undefined
        ? Math.max(0, Math.min(dropIndex, cleanerEntry.tasks.length))
        : cleanerEntry.tasks.length;

      cleanerEntry.tasks.splice(targetIndex, 0, taskForTimeline);

      // Ricalcola travel_time, start_time, end_time usando lo script Python
      try {
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

      // Aggiorna metadata e meta
      timelineData.metadata = timelineData.metadata || {};
      timelineData.metadata.last_updated = new Date().toISOString();
      timelineData.metadata.date = workDate;
      timelineData.meta.total_cleaners = timelineData.cleaners_assignments.length;
      timelineData.meta.total_tasks = timelineData.cleaners_assignments.reduce(
        (sum: number, c: any) => sum + c.tasks.length,
        0
      );

      // Scrittura atomica
      const tmpPath = `${timelinePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(timelineData, null, 2));
      await fs.rename(tmpPath, timelinePath);

      // RIMUOVI SEMPRE la task da containers.json quando salvata in timeline
      if (containersData && containersData.containers) {
        try {
          let taskRemoved = false;

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

            // Salva containers.json aggiornato in modo atomico
            const tmpContainersPath = `${containersPath}.tmp`;
            await fs.writeFile(tmpContainersPath, JSON.stringify(containersData, null, 2));
            await fs.rename(tmpContainersPath, containersPath);
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
      const { taskId, logisticCode, date } = req.body;
      const workDate = date || format(new Date(), 'yyyy-MM-dd');
      const timelinePath = path.join(process.cwd(), 'client/public/data/output/timeline.json');
      const containersPath = path.join(process.cwd(), 'client/public/data/output/containers.json');

      console.log(`Rimozione assegnazione timeline - taskId: ${taskId}, logisticCode: ${logisticCode}, date: ${workDate}`);

      // Carica timeline
      let assignmentsData: any = { cleaners_assignments: [], current_date: workDate, meta: { total_cleaners: 0, total_tasks: 0, last_updated: new Date().toISOString() } };
      try {
        const existingData = await fs.readFile(timelinePath, 'utf8');
        assignmentsData = JSON.parse(existingData);
      } catch (error) {
        // File non esiste, usa struttura vuota
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

      // Aggiorna metadata e meta
      assignmentsData.metadata = assignmentsData.metadata || {};
      assignmentsData.metadata.last_updated = new Date().toISOString();
      assignmentsData.metadata.date = workDate;
      assignmentsData.meta.total_cleaners = assignmentsData.cleaners_assignments.length;
      assignmentsData.meta.total_tasks = assignmentsData.cleaners_assignments.reduce(
        (sum: number, c: any) => sum + c.tasks.length,
        0
      );

      // Salva timeline
      await fs.writeFile(timelinePath, JSON.stringify(assignmentsData, null, 2));

      // RIPORTA la task nel container corretto
      if (removedTask) {
        try {
          const containersData = JSON.parse(await fs.readFile(containersPath, 'utf8'));

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

          // CRITICAL FIX: Rimuovi eventuali duplicati esistenti prima di aggiungere
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

          // Salva containers.json
          await fs.writeFile(containersPath, JSON.stringify(containersData, null, 2));
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

  // Endpoint per verificare SE esistono assegnazioni salvate (senza caricarle)
  app.post("/api/check-saved-assignments", async (req, res) => {
    try {
      const { Client } = await import("@replit/object-storage");
      const client = new Client();

      const workDate = req.body?.date || format(new Date(), "yyyy-MM-dd");
      const { key, d } = buildKey(workDate);

      const result = await client.downloadAsText(key, { bucket: BUCKET });

      if (result.ok) {
        // File trovato - ritorna sempre come valido
        // La data nel filename è quella che conta (costruita da buildKey)
        return res.json({
          success: true,
          found: true,
          filename: key,
          formattedDateTime: format(d, "dd/MM/yyyy", { locale: it })
        });
      }

      // File non trovato
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

  // Endpoint per confermare le assegnazioni e salvare una copia immutabile
  app.post("/api/confirm-assignments", async (req, res) => {
    try {
      const { Client } = await import("@replit/object-storage");
      const client = new Client();

      const workDate = req.body?.date || format(new Date(), "yyyy-MM-dd");

      // Leggi timeline.json corrente
      const timelinePath = path.join(process.cwd(), 'client/public/data/output/timeline.json');
      const timelineData = JSON.parse(await fs.readFile(timelinePath, 'utf8'));

      const { key, d } = buildKey(workDate);
      const jsonContent = JSON.stringify(timelineData, null, 2);

      // Upload con uploadFromText
      const result = await client.uploadFromText(key, jsonContent, {
        bucket: BUCKET
      });

      if (!result.ok) {
        throw new Error(result.error || 'Errore sconosciuto nel salvataggio');
      }

      console.log(`✅ Assegnazioni salvate in Object Storage: ${key}`);

      // === Salva anche i selected_cleaners per la stessa data ===
      const selectedCleanersPath = path.join(
        process.cwd(),
        'client/public/data/cleaners/selected_cleaners.json'
      );

      let selectedCleanersData: any;
      try {
        const scRaw = await fs.readFile(selectedCleanersPath, 'utf8');
        selectedCleanersData = JSON.parse(scRaw);
      } catch {
        selectedCleanersData = { cleaners: [], total_selected: 0 };
      }

      selectedCleanersData.metadata = selectedCleanersData.metadata || {};
      selectedCleanersData.metadata.date = workDate;
      selectedCleanersData.metadata.saved_at = new Date().toISOString();

      // Costruisci chiave per selected_cleaners
      const dateObj = new Date(workDate);
      const day = String(dateObj.getDate()).padStart(2, '0');
      const month = String(dateObj.getMonth() + 1).padStart(2, '0');
      const fullYear = String(dateObj.getFullYear());
      const year = fullYear.slice(-2);
      const folderPath = `${day}-${month}-${fullYear}`;
      const scKey = `${folderPath}/selected_cleaners_${day}${month}${year}.json`;

      const scJson = JSON.stringify(selectedCleanersData, null, 2);
      const scResult = await client.uploadFromText(scKey, scJson, {
        bucket: BUCKET
      });
      if (!scResult.ok) {
        throw new Error(scResult.error || 'Errore nel salvataggio dei selected_cleaners');
      }
      console.log(`✅ Selected cleaners salvati in Object Storage: ${scKey}`);

      // Formatta data e ora
      const now = new Date();
      const hours = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      const formattedDateTime = `${day}/${month}/${fullYear} alle ${hours}:${minutes}`;

      res.json({
        success: true,
        filename: key,
        formattedDateTime,
        message: `Assegnazioni salvate in Object Storage: ${key}`
      });
    } catch (error: any) {
      console.error("Errore nel salvataggio delle assegnazioni:", error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Endpoint per caricare assegnazioni salvate da Object Storage
  app.post("/api/load-saved-assignments", async (req, res) => {
    try {
      const { Client } = await import("@replit/object-storage");
      const client = new Client();

      const workDate = req.body?.date || format(new Date(), "yyyy-MM-dd");
      const { key } = buildKey(workDate);

      console.log(`Tentativo di caricamento file: ${key}`);

      const result = await client.downloadAsText(key, { bucket: BUCKET });

      if (!result.ok) {
        console.log(`Nessuna assegnazione salvata trovata per ${workDate} (${key})`);
        return res.json({
          success: true,
          found: false,
          message: "Nessuna assegnazione salvata per questa data"
        });
      }

      const savedData = JSON.parse(result.value);
      
      // CRITICAL: Aggiorna SEMPRE la data nei metadata con la data richiesta
      // Questo permette di caricare file salvati anche se la data interna non corrisponde
      savedData.metadata = savedData.metadata || {};
      savedData.metadata.date = workDate;
      savedData.metadata.last_updated = new Date().toISOString();

      // Salva i dati caricati in timeline.json
      const timelinePath = path.join(process.cwd(), 'client/public/data/output/timeline.json');
      const tmpPath = `${timelinePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(savedData, null, 2));
      await fs.rename(tmpPath, timelinePath);

      // === Scarica e ripristina selected_cleaners per la stessa data ===
      const dateObj = new Date(workDate);
      const day = String(dateObj.getDate()).padStart(2, '0');
      const month = String(dateObj.getMonth() + 1).padStart(2, '0');
      const fullYear = String(dateObj.getFullYear());
      const year = fullYear.slice(-2);
      const folderPath = `${day}-${month}-${fullYear}`;
      const scKey = `${folderPath}/selected_cleaners_${day}${month}${year}.json`;
      
      try {
        const scResult = await client.downloadAsText(scKey, { bucket: BUCKET });
        const selectedCleanersPath = path.join(
          process.cwd(),
          'client/public/data/cleaners/selected_cleaners.json'
        );

        if (scResult.ok) {
          const scData = JSON.parse(scResult.value);

          scData.metadata = scData.metadata || {};
          scData.metadata.date = workDate;
          scData.metadata.loaded_at = new Date().toISOString();

          const tmpScPath = `${selectedCleanersPath}.tmp`;
          await fs.writeFile(tmpScPath, JSON.stringify(scData, null, 2));
          await fs.rename(tmpScPath, selectedCleanersPath);

          console.log(`✅ Selected cleaners ripristinati da Object Storage: ${scKey}`);
        } else {
          const emptySelected = {
            cleaners: [],
            total_selected: 0,
            metadata: { date: workDate, reset_at: new Date().toISOString() }
          };

          const tmpScPath = `${selectedCleanersPath}.tmp`;
          await fs.writeFile(tmpScPath, JSON.stringify(emptySelected, null, 2));
          await fs.rename(tmpScPath, selectedCleanersPath);

          console.log(`ℹ️ Nessun selected_cleaners salvato per ${workDate} - creato vuoto`);
        }
      } catch (e) {
        console.warn(`⚠️ Impossibile caricare ${scKey}:`, e);
      }
      // === END ===

      // Rigenera containers.json per la data caricata
      // CRITICAL: Aggiorna timeline.json con la data corretta DOPO create_containers
      console.log(`🔄 Rigenerazione containers.json per data ${workDate}...`);
      const containersResult = await new Promise<string>((resolve, reject) => {
        exec(
          `python3 client/public/scripts/create_containers.py ${workDate}`,
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

      // CRITICAL: NON rieseguire create_containers dopo aver caricato da Object Storage
      // Invece, rimuovi dai containers.json le task già assegnate in timeline.json
      const containersPath = path.join(process.cwd(), 'client/public/data/output/containers.json');
      
      try {
        // Carica containers esistenti (generati da extract-data precedente)
        const containersData = JSON.parse(await fs.readFile(containersPath, 'utf8'));
        
        // Estrai tutti i task_id assegnati dalla timeline
        const assignedTaskIds = new Set<number>();
        if (savedData.cleaners_assignments) {
          for (const cleanerEntry of savedData.cleaners_assignments) {
            for (const task of cleanerEntry.tasks || []) {
              assignedTaskIds.add(task.task_id);
            }
          }
        }
        
        console.log(`🔍 Task assegnate trovate in timeline: ${assignedTaskIds.size}`);
        
        // Rimuovi dai containers le task già assegnate
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
        
        // Salva containers.json sincronizzato
        const tmpContainersPath = `${containersPath}.tmp`;
        await fs.writeFile(tmpContainersPath, JSON.stringify(containersData, null, 2));
        await fs.rename(tmpContainersPath, containersPath);
        
        console.log(`✅ Containers sincronizzati: rimosse ${removedCount} task già assegnate`);
      } catch (err) {
        console.warn('⚠️ Impossibile sincronizzare containers:', err);
      }

      // Estrai il timestamp dal filename (formato: assignments_DDMMYY.json)
      const dateMatch = key.match(/assignments_(\d{6})\.json/);
      const lastSavedTimestamp = dateMatch ? dateMatch[1] : null;

      // Usa la data corrente con la data dal filename
      let formattedDateTime = null;
      if (lastSavedTimestamp) {
        const now = new Date();
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const day = lastSavedTimestamp.slice(0, 2);
        const month = lastSavedTimestamp.slice(2, 4);
        const year = lastSavedTimestamp.slice(4, 6);
        formattedDateTime = `${day}/${month}/${year} alle ${hours}:${minutes}`;
      }

      res.json({
        success: true,
        found: true,
        filename: key,
        lastSavedTimestamp,
        formattedDateTime,
        data: savedData,
        message: `Assegnazioni caricate da: ${key}`
      });
    } catch (error: any) {
      console.error("Errore nel caricamento delle assegnazioni:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per rimuovere un cleaner da selected_cleaners.json
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
      const selectedCleanersPath = path.join(
        process.cwd(),
        'client/public/data/cleaners/selected_cleaners.json'
      );
      const timelinePath = path.join(
        process.cwd(),
        'client/public/data/output/timeline.json'
      );

      // Carica i cleaners selezionati
      let selectedData: any;
      try {
        const content = await fs.readFile(selectedCleanersPath, 'utf8');
        selectedData = JSON.parse(content);
      } catch (error) {
        selectedData = { cleaners: [], total_selected: 0 };
      }

      // Carica timeline per verificare se il cleaner ha task
      let timelineData: any;
      let hasTasks = false;
      try {
        const timelineContent = await fs.readFile(timelinePath, 'utf8');
        timelineData = JSON.parse(timelineContent);

        const cleanerEntry = timelineData.cleaners_assignments?.find(
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

      // Salva selected_cleaners.json
      const tmpPath = `${selectedCleanersPath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(selectedData, null, 2));
      await fs.rename(tmpPath, selectedCleanersPath);

      let message = "";

      // Se il cleaner NON ha task, rimuovilo anche da timeline.json
      if (!hasTasks && timelineData) {
        timelineData.cleaners_assignments = timelineData.cleaners_assignments.filter(
          (c: any) => c.cleaner?.id !== cleanerId
        );

        // Aggiorna metadata
        timelineData.metadata = timelineData.metadata || {};
        timelineData.metadata.last_updated = new Date().toISOString();
        timelineData.metadata.date = workDate;
        timelineData.meta = timelineData.meta || {};
        timelineData.meta.total_cleaners = timelineData.cleaners_assignments.length;
        timelineData.meta.total_tasks = timelineData.cleaners_assignments.reduce(
          (sum: number, c: any) => sum + (c.tasks?.length || 0),
          0
        );

        // Salva timeline.json
        const tmpTimelinePath = `${timelinePath}.tmp`;
        await fs.writeFile(tmpTimelinePath, JSON.stringify(timelineData, null, 2));
        await fs.rename(tmpTimelinePath, timelinePath);

        console.log(`✅ Cleaner ${cleanerId} rimosso completamente (nessuna task)`);
        console.log(`   - Rimosso da selected_cleaners.json (${cleanersBefore} -> ${selectedData.cleaners.length})`);
        console.log(`   - Rimosso da timeline.json`);
        message = "Cleaner rimosso completamente (nessuna task)";
      } else {
        console.log(`✅ Cleaner ${cleanerId} rimosso da selected_cleaners.json (${cleanersBefore} -> ${selectedData.cleaners.length})`);
        console.log(`   Il cleaner rimane in timeline.json con le sue task fino a sostituzione`);
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

  // Endpoint per salvare i cleaners selezionati
  app.post("/api/save-selected-cleaners", async (req, res) => {
    try {
      const { cleaners: selectedCleaners, total_selected, date } = req.body;

      if (!selectedCleaners || !Array.isArray(selectedCleaners)) {
        return res.status(400).json({
          success: false,
          message: "Dati cleaners non validi"
        });
      }

      // Usa la data fornita o la data corrente
      const workDate = date || format(new Date(), 'yyyy-MM-dd');

      // Carica cleaners.json per ottenere can_do_straordinaria
      const cleanersPath = path.join(process.cwd(), 'client/public/data/cleaners/cleaners.json');
      const cleanersContent = await fs.readFile(cleanersPath, 'utf8');
      const cleanersData = JSON.parse(cleanersContent);

      // Usa la data specifica o la più recente
      const dates = Object.keys(cleanersData.dates);
      const targetDate = dates.includes(workDate) ? workDate : dates.sort().reverse()[0];
      const allCleaners = cleanersData.dates[targetDate]?.cleaners || [];

      // Crea mappa can_do_straordinaria per ID
      const straordinariaMap = new Map();
      allCleaners.forEach((c: any) => {
        straordinariaMap.set(c.id, c.can_do_straordinaria || false);
      });

      // Aggiungi can_do_straordinaria ai cleaner selezionati
      const enrichedCleaners = selectedCleaners.map((c: any) => ({
        ...c,
        can_do_straordinaria: straordinariaMap.get(c.id) || false
      }));

      const selectedCleanersPath = path.join(
        process.cwd(),
        'client/public/data/cleaners/selected_cleaners.json'
      );

      const dataToSave = {
        cleaners: enrichedCleaners,
        total_selected: total_selected || enrichedCleaners.length,
        metadata: {
          date: workDate,
          saved_at: new Date().toISOString()
        }
      };

      // Scrittura atomica
      const tmpPath = `${selectedCleanersPath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(dataToSave, null, 2));
      await fs.rename(tmpPath, selectedCleanersPath);

      console.log(`✅ Salvati ${enrichedCleaners.length} cleaners in selected_cleaners.json per ${workDate} (con can_do_straordinaria e metadata)`);

      res.json({
        success: true,
        message: `${selectedCleaners.length} cleaners salvati con successo`,
        count: selectedCleaners.length
      });
    } catch (error: any) {
      console.error("Errore nel salvataggio di selected_cleaners.json:", error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Endpoint per aggiungere un cleaner alla timeline (sostituisce cleaner rimossi da selected_cleaners)
  app.post("/api/add-cleaner-to-timeline", async (req, res) => {
    try {
      const { cleanerId, date } = req.body;
      const workDate = date || format(new Date(), 'yyyy-MM-dd');
      const timelinePath = path.join(process.cwd(), 'client/public/data/output/timeline.json');
      const cleanersPath = path.join(process.cwd(), 'client/public/data/cleaners/cleaners.json');
      const selectedCleanersPath = path.join(process.cwd(), 'client/public/data/cleaners/selected_cleaners.json');

      console.log(`Aggiunta cleaner ${cleanerId} alla timeline per data ${workDate}`);

      // Carica cleaners.json per ottenere i dati del cleaner da aggiungere
      let cleanersData: any;
      try {
        const cleanersContent = await fs.readFile(cleanersPath, 'utf8');
        cleanersData = JSON.parse(cleanersContent);
      } catch (error) {
        console.error("Errore nel caricamento di cleaners.json:", error);
        return res.status(500).json({ success: false, error: "Cleaners file non trovato" });
      }

      // Trova il cleaner per la data specificata
      const dateCleaners = cleanersData.dates?.[workDate]?.cleaners || [];
      let cleanerData = dateCleaners.find((c: any) => c.id === cleanerId);

      // Se non trovato nella data corrente, cerca in tutte le date
      if (!cleanerData) {
        for (const date of Object.keys(cleanersData.dates || {})) {
          const dateCl = cleanersData.dates[date]?.cleaners || [];
          cleanerData = dateCl.find((c: any) => c.id === cleanerId);
          if (cleanerData) {
            console.log(`✅ Cleaner ${cleanerId} trovato nella data ${date}`);
            break;
          }
        }
      }

      if (!cleanerData) {
        return res.status(404).json({ success: false, error: "Cleaner non trovato in cleaners.json" });
      }

      // Carica selected_cleaners.json
      let selectedCleanersData: any;
      try {
        const selectedContent = await fs.readFile(selectedCleanersPath, 'utf8');
        selectedCleanersData = JSON.parse(selectedContent);
      } catch (error) {
        selectedCleanersData = { cleaners: [], total_selected: 0, metadata: { date: workDate } };
      }

      const selectedCleanerIds = new Set(selectedCleanersData.cleaners.map((c: any) => c.id));

      // Carica timeline
      let timelineData: any = {
        cleaners_assignments: [],
        current_date: workDate,
        meta: { total_cleaners: 0, total_tasks: 0, last_updated: new Date().toISOString() },
        metadata: { last_updated: new Date().toISOString(), date: workDate }
      };

      try {
        const existingData = await fs.readFile(timelinePath, 'utf8');
        timelineData = JSON.parse(existingData);
      } catch (error) {
        console.log("Timeline file non trovato, creazione nuovo file");
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
        
        // Cerca la posizione corretta basandoti su selected_cleaners.json
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
      timelineData.metadata.last_updated = new Date().toISOString();
      timelineData.metadata.date = workDate;
      timelineData.meta.total_cleaners = timelineData.cleaners_assignments.length;
      timelineData.meta.total_tasks = timelineData.cleaners_assignments.reduce(
        (sum: number, c: any) => sum + (c.tasks?.length || 0),
        0
      );

      // Scrittura atomica timeline
      const tmpPath = `${timelinePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(timelineData, null, 2));
      await fs.rename(tmpPath, timelinePath);

      // Aggiungi il cleaner a selected_cleaners.json (se non già presente)
      const isAlreadySelected = selectedCleanersData.cleaners.some((c: any) => c.id === cleanerId);

      if (!isAlreadySelected) {
        selectedCleanersData.cleaners.push(cleanerData);
        selectedCleanersData.total_selected = selectedCleanersData.cleaners.length;
        selectedCleanersData.metadata = selectedCleanersData.metadata || {};
        selectedCleanersData.metadata.date = workDate;

        // Salva selected_cleaners.json
        const tmpSelectedPath = `${selectedCleanersPath}.tmp`;
        await fs.writeFile(tmpSelectedPath, JSON.stringify(selectedCleanersData, null, 2));
        await fs.rename(tmpSelectedPath, selectedCleanersPath);
        console.log(`✅ Cleaner ${cleanerId} aggiunto a selected_cleaners.json`);
      }

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
      const { cleanerId, tasks } = req.body;

      // Use await import('fs/promises') within the route handler
      // const fs = await import('fs/promises');

      const assignmentsPath = path.join(process.cwd(), 'client/public/data/output/assignments.json');
      const cleanersPath = path.join(process.cwd(), 'client/public/data/cleaners/selected_cleaners.json');

      // Carica i dati dei cleaners
      const cleanersData = await fs.readFile(cleanersPath, 'utf8').then(JSON.parse);

      // Trova il cleaner corrispondente (per ora usa un mapping, poi sarà dinamico)
      const cleanerMapping: { [key: string]: number } = {
        'lopez': 24,  // ID del primo cleaner
        'garcia': 249, // ID del secondo cleaner
        'rossi': 287   // ID del terzo cleaner
      };

      const cleanerRealId = cleanerMapping[cleanerId];
      const cleaner = cleanersData.cleaners.find((c: any) => c.id === cleanerRealId);

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
      } = req.body as {
        taskId?: string | number;
        logisticCode?: string | number;
        fromContainer?: 'early_out' | 'high_priority' | 'low_priority';
        toContainer?: 'early_out' | 'high_priority' | 'low_priority';
        sourceIndex?: number;
        destIndex?: number;
      };

      if (!fromContainer || !toContainer) {
        return res.status(400).json({ success: false, message: 'fromContainer e toContainer sono obbligatori' });
      }

      // Carica containers.json
      const containersPath = path.join(process.cwd(), 'client/public/data/output/containers.json');
      const raw = await fs.readFile(containersPath, 'utf8');
      const containersData: any = JSON.parse(raw);

      const containers = containersData?.containers;
      if (!containers) {
        return res.status(500).json({ success: false, message: 'Struttura containers mancante in containers.json' });
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
          // Scrittura atomica
          const tmp = containersPath + '.tmp';
          await fs.writeFile(tmp, JSON.stringify(containersData, null, 2));
          await fs.rename(tmp, containersPath);

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
        const tmp = containersPath + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(containersData, null, 2));
        await fs.rename(tmp, containersPath);

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

      // Scrittura atomica del JSON
      const tmp = containersPath + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(containersData, null, 2));
      await fs.rename(tmp, containersPath);

      return res.json({ success: true, message: 'Task spostata tra containers' });
    } catch (err: any) {
      console.error('update-task-json error:', err);
      return res.status(500).json({ success: false, message: 'Errore interno', error: String(err?.message ?? err) });
    }
  });

  // Endpoint per aggiornare i dettagli di una task (checkout, checkin, durata)
  app.post("/api/update-task-details", async (req, res) => {
    try {
      const { taskId, logisticCode, checkoutDate, checkoutTime, checkinDate, checkinTime, cleaningTime } = req.body;

      if (!taskId && !logisticCode) {
        return res.status(400).json({ success: false, error: "taskId o logisticCode richiesto" });
      }

      const containersPath = path.join(process.cwd(), 'client/public/data/output/containers.json');
      const timelinePath = path.join(process.cwd(), 'client/public/data/output/timeline.json');

      // Carica entrambi i file
      const [containersData, timelineData] = await Promise.all([
        fs.readFile(containersPath, 'utf8').then(JSON.parse).catch(() => ({ containers: {} })),
        fs.readFile(timelinePath, 'utf8').then(JSON.parse).catch(() => ({ cleaners_assignments: [] }))
      ]);

      let taskUpdated = false;

      // Funzione helper per aggiornare una task
      const updateTask = (task: any) => {
        if (String(task.task_id) === String(taskId) || String(task.logistic_code) === String(logisticCode)) {
          task.checkout_date = checkoutDate;
          task.checkout_time = checkoutTime;
          task.checkin_date = checkinDate;
          task.checkin_time = checkinTime;
          task.cleaning_time = cleaningTime;
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

      // Salva entrambi i file in modo atomico
      const tmpContainersPath = `${containersPath}.tmp`;
      await fs.writeFile(tmpContainersPath, JSON.stringify(containersData, null, 2));
      await fs.rename(tmpContainersPath, containersPath);

      const tmpTimelinePath = `${timelinePath}.tmp`;
      await fs.writeFile(tmpTimelinePath, JSON.stringify(timelineData, null, 2));
      await fs.rename(tmpTimelinePath, timelinePath);

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
      console.error("Errore durante l'estrazione dei cleaners (ottimizzato):", error);
      res.status(500).json({
        success: false,
        message: "Errore durante l'estrazione dei cleaners (ottimizzato)",
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

      const pythonProcess = spawn('python3', [scriptPath, workDate]);

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
        workDate
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
      if (!date) {
        return res.status(400).json({
          success: false,
          message: "Data mancante nella richiesta"
        });
      }
      const workDate = date;

      console.log(`📅 EO Assignment - Ricevuta data dal frontend: ${workDate}`);
      console.log(`▶ Eseguendo assign_eo.py per data: ${workDate}`);

      // CRITICO: Prima di eseguire lo script, assicurati che timeline.json abbia la data corretta
      const timelinePath = path.join(process.cwd(), 'client/public/data/output/timeline.json');
      try {
        const timelineData = JSON.parse(await fs.readFile(timelinePath, 'utf8'));
        if (timelineData.metadata?.date !== workDate) {
          console.log(`⚠️ ATTENZIONE: timeline.json ha data ${timelineData.metadata?.date}, dovrebbe essere ${workDate}`);
          console.log(`🔄 Aggiornamento data in timeline.json...`);
          timelineData.metadata = timelineData.metadata || {};
          timelineData.metadata.date = workDate;
          await fs.writeFile(timelinePath, JSON.stringify(timelineData, null, 2));
        }
      } catch (err) {
        console.warn("Impossibile verificare/aggiornare timeline.json:", err);
      }

      const { spawn } = await import('child_process');
      const scriptPath = path.join(process.cwd(), 'client/public/scripts/assign_eo.py');

      const pythonProcess = spawn('python3', [scriptPath, workDate], {
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
        res.json({
          success: true,
          message: "Early Out tasks assegnati con successo in timeline.json",
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
      if (!date) {
        return res.status(400).json({
          success: false,
          message: "Data mancante nella richiesta"
        });
      }
      const workDate = date;

      console.log(`📅 HP Assignment - Ricevuta data dal frontend: ${workDate}`);
      console.log(`▶ Eseguendo assign_hp.py per data: ${workDate}`);

      // Verifica che timeline.json abbia la data corretta
      const timelinePath = path.join(process.cwd(), 'client/public/data/output/timeline.json');
      try {
        const timelineData = JSON.parse(await fs.readFile(timelinePath, 'utf8'));
        if (timelineData.metadata?.date !== workDate) {
          console.log(`⚠️ ATTENZIONE: timeline.json ha data ${timelineData.metadata?.date}, dovrebbe essere ${workDate}`);
          timelineData.metadata = timelineData.metadata || {};
          timelineData.metadata.date = workDate;
          await fs.writeFile(timelinePath, JSON.stringify(timelineData, null, 2));
        }
      } catch (err) {
        console.warn("Impossibile verificare timeline.json:", err);
      }

      const { spawn } = await import('child_process');
      const scriptPath = path.join(process.cwd(), 'client/public/scripts/assign_hp.py');

      const pythonProcess = spawn('python3', [scriptPath, workDate], {
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
        res.json({
          success: true,
          message: "High Priority tasks assegnati con successo in timeline.json",
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
      if (!date) {
        return res.status(400).json({
          success: false,
          message: "Data mancante nella richiesta"
        });
      }
      const workDate = date;

      console.log(`📅 LP Assignment - Ricevuta data dal frontend: ${workDate}`);
      console.log(`▶ Eseguendo assign_lp.py per data: ${workDate}`);

      // Verifica che timeline.json abbia la data corretta
      const timelinePath = path.join(process.cwd(), 'client/public/data/output/timeline.json');
      try {
        const timelineData = JSON.parse(await fs.readFile(timelinePath, 'utf8'));
        if (timelineData.metadata?.date !== workDate) {
          console.log(`⚠️ ATTENZIONE: timeline.json ha data ${timelineData.metadata?.date}, dovrebbe essere ${workDate}`);
          timelineData.metadata = timelineData.metadata || {};
          timelineData.metadata.date = workDate;
          await fs.writeFile(timelinePath, JSON.stringify(timelineData, null, 2));
        }
      } catch (err) {
        console.warn("Impossibile verificare timeline.json:", err);
      }

      const { spawn } = await import('child_process');
      const scriptPath = path.join(process.cwd(), 'client/public/scripts/assign_lp.py');

      const pythonProcess = spawn('python3', [scriptPath, workDate], {
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
        res.json({
          success: true,
          message: "Low Priority tasks assegnati con successo in timeline.json",
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
      const { date } = req.body;
      const timelinePath = path.join(process.cwd(), 'client/public/data/output/timeline.json');
      const assignedDir = path.join(process.cwd(), 'client/public/data/assigned');

      // CRITICAL: NON resettare timeline.json - preservalo sempre
      // Anche se la data cambia, mantieni le assegnazioni esistenti
      // create_containers.py aggiornerà i dati delle task esistenti
      let timelineExists = false;
      try {
        await fs.access(timelinePath);
        const fileContent = await fs.readFile(timelinePath, 'utf8');
        
        // Verifica che il contenuto sia JSON valido
        if (!fileContent.trim().startsWith('{')) {
          throw new Error('timeline.json non contiene JSON valido');
        }
        
        const existingTimeline = JSON.parse(fileContent);
        timelineExists = true;
        
        // Aggiorna SOLO la metadata.date se è cambiata
        if (existingTimeline.metadata?.date !== date) {
          console.log(`🔄 Timeline esiste per data ${existingTimeline.metadata?.date}, aggiorno metadata.date a ${date}`);
          existingTimeline.metadata.date = date;
          existingTimeline.metadata.last_updated = new Date().toISOString();
          const tmpPath = `${timelinePath}.tmp`;
          await fs.writeFile(tmpPath, JSON.stringify(existingTimeline, null, 2));
          await fs.rename(tmpPath, timelinePath);
        } else {
          console.log(`✅ Timeline.json già presente per ${date}, mantieni assegnazioni esistenti`);
        }
      } catch (err) {
        // File non esiste o è corrotto - crealo vuoto
        console.log(`📝 Timeline.json non esiste o corrotto, creazione nuova per ${date}`);
        const emptyTimeline = {
          metadata: { last_updated: new Date().toISOString(), date },
          cleaners_assignments: [],
          meta: { total_cleaners: 0, used_cleaners: 0, assigned_tasks: 0 }
        };
        const tmpPath = `${timelinePath}.tmp`;
        await fs.writeFile(tmpPath, JSON.stringify(emptyTimeline, null, 2));
        await fs.rename(tmpPath, timelinePath);
        timelineExists = false;
      }

      // CRITICAL: Svuota selected_cleaners.json SOLO se la data è cambiata
      const selectedCleanersPath = path.join(
        process.cwd(),
        'client/public/data/cleaners/selected_cleaners.json'
      );

      let shouldResetSelectedCleaners = false;
      try {
        const existingSelectedData = JSON.parse(await fs.readFile(selectedCleanersPath, 'utf8'));
        const existingDate = existingSelectedData.metadata?.date;
        
        if (existingDate !== date) {
          shouldResetSelectedCleaners = true;
          console.log(`📅 Data cambiata da ${existingDate} a ${date} - reset selected_cleaners.json`);
        } else {
          console.log(`✅ Stessa data (${date}) - mantieni selected_cleaners.json`);
        }
      } catch (err) {
        // File non esiste o è corrotto - crealo vuoto
        shouldResetSelectedCleaners = true;
        console.log(`📝 selected_cleaners.json non esiste - creazione nuovo`);
      }

      if (shouldResetSelectedCleaners) {
        const emptySelected = {
          cleaners: [],
          total_selected: 0,
          metadata: { 
            date,
            reset_at: new Date().toISOString()
          }
        };

        const tmpScPath = `${selectedCleanersPath}.tmp`;
        await fs.writeFile(tmpScPath, JSON.stringify(emptySelected, null, 2));
        await fs.rename(tmpScPath, selectedCleanersPath);

        console.log(`ℹ️ selected_cleaners.json resettato per ${date}`);
      }

      // Esegui SEMPRE create_containers.py per avere dati freschi dal database
      console.log(`Eseguendo create_containers.py per data ${date}...`);
      const containersResult = await new Promise<string>((resolve, reject) => {
        exec(
          `python3 client/public/scripts/create_containers.py ${date}`,
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
        fromContainer,
      } = req.body as {
        taskId?: string | number;
        logisticCode?: string | number;
        fromCleanerId?: number;
        toCleanerId: number;
        sourceIndex?: number;
        destIndex?: number;
        fromContainer?: 'early_out' | 'high_priority' | 'low_priority';
      };

      if (typeof toCleanerId !== 'number') {
        return res.status(400).json({ success: false, message: 'toCleanerId obbligatorio' });
      }
      if (typeof taskId === 'undefined' && typeof logisticCode === 'undefined') {
        return res.status(400).json({ success: false, message: 'taskId o logisticCode obbligatorio' });
      }

      const workDate = req.body.date || format(new Date(), 'yyyy-MM-dd');
      const timelinePath = path.join(process.cwd(), 'client/public/data/output/timeline.json');
      const containersPath = path.join(process.cwd(), 'client/public/data/output/containers.json');

      const [timelineRaw, containersRaw] = await Promise.all([
        fs.readFile(timelinePath, 'utf8'),
        fs.readFile(containersPath, 'utf8').catch(() => 'null'),
      ]);

      const timelineData: any = JSON.parse(timelineRaw);
      const containersData: any = containersRaw !== 'null' ? JSON.parse(containersRaw) : null;

      const cleaners = timelineData?.cleaners_assignments;
      if (!cleaners || !Array.isArray(cleaners)) {
        return res.status(500).json({ success: false, message: 'Struttura timeline non valida' });
      }

      const getCleanerEntry = (id: number) => cleaners.find((c: any) => c.cleaner?.id === id);

      const idMatches = (t: any, key: string) =>
        String(t?.task_id) === key || String(t?.logistic_code) === key || String(t?.id) === key;

      const findTaskIndex = (arr: any[], key: string) => arr.findIndex(t => idMatches(t, key));

      const taskKey = String(typeof taskId !== 'undefined' ? taskId : logisticCode);

      let dstEntry = getCleanerEntry(toCleanerId);

      // Se il cleaner di destinazione non esiste, crealo (caso cleaner nascosto)
      if (!dstEntry) {
        // Carica i dati del cleaner da cleaners.json
        const cleanersPath = path.join(process.cwd(), 'client/public/data/cleaners/cleaners.json');
        const selectedCleanersPath = path.join(process.cwd(), 'client/public/data/cleaners/selected_cleaners.json');

        try {
          const cleanersData = JSON.parse(await fs.readFile(cleanersPath, 'utf8'));
          const selectedData = JSON.parse(await fs.readFile(selectedCleanersPath, 'utf8'));

          // Cerca prima nei selected_cleaners
          let cleanerInfo = selectedData.cleaners.find((c: any) => c.id === toCleanerId);

          // Se non trovato, cerca in cleaners.json per la data
          if (!cleanerInfo) {
            for (const date of Object.keys(cleanersData.dates || {})) {
              const dateCleaners = cleanersData.dates[date]?.cleaners || [];
              cleanerInfo = dateCleaners.find((c: any) => c.id === toCleanerId);
              if (cleanerInfo) break;
            }
          }

          if (!cleanerInfo) {
            return res.status(400).json({ success: false, message: 'Cleaner di destinazione non trovato' });
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
          console.error('Errore caricamento dati cleaner:', error);
          return res.status(400).json({ success: false, message: 'Errore nel caricamento dati cleaner' });
        }
      }

      if (!Array.isArray(dstEntry.tasks)) {
        dstEntry.tasks = [];
      }

      let moved: any | null = null;

      // Traccia la posizione di rimozione per aggiustare destIndex se necessario
      let removedFromIndex: number | null = null;

      // Caso A: provengo da TIMELINE
      if (typeof fromCleanerId === 'number') {
        const srcEntry = getCleanerEntry(fromCleanerId);
        if (!srcEntry || !Array.isArray(srcEntry.tasks)) {
          return res.status(400).json({ success: false, message: 'Cleaner sorgente non valido' });
        }

        let takeIdx: number | null = null;
        if (typeof sourceIndex === 'number' && sourceIndex >= 0 && sourceIndex < srcEntry.tasks.length) {
          takeIdx = sourceIndex;
        } else {
          const idx = findTaskIndex(srcEntry.tasks, taskKey);
          takeIdx = idx >= 0 ? idx : null;
        }
        if (takeIdx === null) {
          return res.status(404).json({ success: false, message: 'Task non trovata nel cleaner sorgente' });
        }

        // Se stesso cleaner, traccia l'indice di rimozione
        if (fromCleanerId === toCleanerId) {
          removedFromIndex = takeIdx;
        }

        [moved] = srcEntry.tasks.splice(takeIdx, 1);

        // Aggiorna sequence nel cleaner sorgente
        srcEntry.tasks.forEach((t: any, i: number) => { t.sequence = i + 1; });
      }

      // Caso B: provengo da CONTAINER
      if (!moved && fromContainer && containersData?.containers?.[fromContainer]?.tasks) {
        const srcArr = containersData.containers[fromContainer].tasks as any[];
        let idx = findTaskIndex(srcArr, taskKey);
        if (idx === -1 && typeof sourceIndex === 'number' && srcArr[sourceIndex]) idx = sourceIndex;
        if (idx === -1) {
          return res.status(404).json({ success: false, message: 'Task non trovata nel container sorgente' });
        }
        [moved] = srcArr.splice(idx, 1);
        containersData.containers[fromContainer].summary.total = srcArr.length;
      }

      // Caso C: riordino interno
      if (!moved) {
        const idx = findTaskIndex(dstEntry.tasks, taskKey);
        if (idx === -1) {
          return res.status(404).json({ success: false, message: 'Task non trovata' });
        }
        removedFromIndex = idx;
        [moved] = dstEntry.tasks.splice(idx, 1);
      }

      // Inserimento nella posizione richiesta
      let insertAt = typeof destIndex === 'number' ? destIndex : dstEntry.tasks.length;

      // CRITICAL FIX: Quando spostiamo nello stesso cleaner, dopo aver rimosso la task
      // l'array è più corto di 1, quindi dobbiamo aggiustare l'indice di destinazione
      if (removedFromIndex !== null && removedFromIndex < insertAt) {
        insertAt = insertAt - 1;
        console.log(`🔧 Aggiustato destIndex da ${destIndex} a ${insertAt} (rimozione da ${removedFromIndex})`);
      }

      if (insertAt < 0) insertAt = 0;
      if (insertAt > dstEntry.tasks.length) insertAt = dstEntry.tasks.length;
      dstEntry.tasks.splice(insertAt, 0, moved);

      // Aggiorna sequence nel cleaner destinazione
      dstEntry.tasks.forEach((t: any, i: number) => { t.sequence = i + 1; });

      // Ricalcola tempi usando lo script Python per avere start_time/end_time coerenti con la sequenza
      try {
        const updatedDst = await recalculateCleanerTimes(dstEntry);
        dstEntry.tasks = updatedDst.tasks;
        console.log(`✅ Tempi ricalcolati per cleaner ${toCleanerId} dopo inserimento`);

        // Se c'è un cleaner sorgente diverso, ricalcola anche quello
        if (typeof fromCleanerId === 'number' && fromCleanerId !== toCleanerId) {
          const srcEntry = getCleanerEntry(fromCleanerId);
          if (srcEntry && srcEntry.tasks.length > 0) {
            const updatedSrc = await recalculateCleanerTimes(srcEntry);
            srcEntry.tasks = updatedSrc.tasks;
            console.log(`✅ Tempi ricalcolati per cleaner ${fromCleanerId} dopo rimozione`);
          }
        }
      } catch (pythonError: any) {
        console.error(`⚠️ Errore nel ricalcolo dei tempi:`, pythonError.message);
        // Fallback: mantieni sequence manualmente (già fatto sopra)
      }

      // CRITICAL FIX: Usa timelineData direttamente (già contiene tutti i cleaner)
      // NON ricaricare da file perché timelineData è già completo
      
      // Aggiorna solo metadata
      timelineData.metadata = timelineData.metadata || {};
      timelineData.metadata.last_updated = new Date().toISOString();
      timelineData.metadata.date = workDate;

      // Salvataggi atomici
      const tmp1 = `${timelinePath}.tmp`;
      await fs.writeFile(tmp1, JSON.stringify(timelineData, null, 2));
      await fs.rename(tmp1, timelinePath);

      if (containersData) {
        const tmp2 = `${containersPath}.tmp`;
        await fs.writeFile(tmp2, JSON.stringify(containersData, null, 2));
        await fs.rename(tmp2, containersPath);
      }

      const message = typeof fromCleanerId === 'number'
        ? (fromCleanerId === toCleanerId ? 'Riordino nel cleaner eseguito' : 'Task spostata tra cleaners')
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
      const timelinePath = path.join(process.cwd(), 'client/public/data/output/timeline.json');

      // Carica timeline.json
      let timelineData: any = JSON.parse(await fs.readFile(timelinePath, 'utf8'));

      // Trova il cleaner
      const cleanerEntry = timelineData.cleaners_assignments.find((c: any) => c.cleaner.id === cleanerId);

      if (!cleanerEntry) {
        return res.status(404).json({ success: false, message: "Cleaner non trovato" });
      }

      // Verifica che gli indici siano validi
      if (fromIndex < 0 || fromIndex >= cleanerEntry.tasks.length) {
        return res.status(400).json({ success: false, message: "Indice fromIndex non valido" });
      }

      if (toIndex < 0 || toIndex > cleanerEntry.tasks.length) {
        return res.status(400).json({ success: false, message: "Indice toIndex non valido" });
      }

      // Verifica che la task a fromIndex corrisponda al taskId/logisticCode fornito
      const taskAtFromIndex = cleanerEntry.tasks[fromIndex];
      const taskMatches =
        String(taskAtFromIndex.task_id) === String(taskId) ||
        String(taskAtFromIndex.logistic_code) === String(logisticCode);

      if (!taskMatches) {
        console.error(`Task mismatch: expected task ${taskId}/${logisticCode} at index ${fromIndex}, found ${taskAtFromIndex.task_id}/${taskAtFromIndex.logistic_code}`);
        return res.status(400).json({
          success: false,
          message: "La task all'indice specificato non corrisponde all'ID fornito. Ricarica la pagina."
        });
      }

      // Rimuovi la task dalla posizione fromIndex
      const [task] = cleanerEntry.tasks.splice(fromIndex, 1);

      // Inserisci nella nuova posizione toIndex
      cleanerEntry.tasks.splice(toIndex, 0, task);

      // Ricalcola travel_time, start_time, end_time usando lo script Python
      try {
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

      // Aggiorna metadata e meta
      timelineData.metadata = timelineData.metadata || {};
      timelineData.metadata.last_updated = new Date().toISOString();
      timelineData.metadata.date = workDate;

      timelineData.meta = timelineData.meta || {};
      timelineData.meta.total_tasks = timelineData.cleaners_assignments.reduce(
        (sum: number, c: any) => sum + (c.tasks?.length || 0),
        0
      );
      timelineData.meta.total_cleaners = timelineData.cleaners_assignments.length;

      // Scrittura atomica per evitare corruzioni
      const tmpPath = `${timelinePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(timelineData, null, 2));
      await fs.rename(tmpPath, timelinePath);

      console.log(`✅ Task ${logisticCode} riordinata da posizione ${fromIndex} a ${toIndex} per cleaner ${cleanerId}`);
      console.log(`   Nuova sequenza delle task: ${cleanerEntry.tasks.map((t: any) => `${t.logistic_code}(${t.sequence})`).join(', ')}`);

      res.json({ success: true, message: "Task riordinata con successo" });
    } catch (error: any) {
      console.error("Errore nel reorder della timeline:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}