import type { Express } from "express";
import { createServer, type Server } from "http";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import * as fs from 'fs/promises';
import { format } from "date-fns";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const execAsync = promisify(exec);

/**
 * Helper function to recalculate travel_time, start_time, end_time for a cleaner's tasks
 */
async function recalculateCleanerTimes(cleanerData: any): Promise<any> {
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
        reject(new Error(`Failed to parse Python output: ${parseError.message}`));
      }
    });

    pythonProcess.on('error', (error) => {
      reject(new Error(`Failed to spawn Python process: ${error.message}`));
    });

    // Scrivi il JSON su stdin e chiudi
    pythonProcess.stdin.write(cleanerDataJson);
    pythonProcess.stdin.end();
  });
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

      // Svuota il file timeline.json
      await fs.writeFile(timelinePath, JSON.stringify({ 
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
      }, null, 2));
      console.log(`Timeline resettata: timeline.json`);

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

      res.json({ 
        success: true, 
        message: `Assegnazioni resettate e containers ripristinati per ${workDate}` 
      });
    } catch (error: any) {
      console.error("Errore nel reset delle assegnazioni della timeline:", error);
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

      // 5. Rimuovi cleaner entries vuote
      timelineData.cleaners_assignments = timelineData.cleaners_assignments.filter(
        (c: any) => c.tasks && c.tasks.length > 0
      );

      // 6. Aggiorna metadata
      timelineData.metadata = timelineData.metadata || {};
      timelineData.metadata.last_updated = new Date().toISOString();
      timelineData.metadata.date = workDate;
      timelineData.meta.total_cleaners = timelineData.cleaners_assignments.length;
      timelineData.meta.total_tasks = timelineData.cleaners_assignments.reduce(
        (sum: number, c: any) => sum + c.tasks.length, 0
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

      // Trova entrambi i cleaners
      const sourceEntry = timelineData.cleaners_assignments.find((c: any) => c.cleaner.id === sourceCleanerId);
      const destEntry = timelineData.cleaners_assignments.find((c: any) => c.cleaner.id === destCleanerId);

      if (!sourceEntry) {
        return res.status(404).json({ 
          success: false, 
          message: `Cleaner sorgente ${sourceCleanerId} non trovato nella timeline` 
        });
      }

      if (!destEntry) {
        return res.status(404).json({ 
          success: false, 
          message: `Cleaner destinazione ${destCleanerId} non trovato nella timeline` 
        });
      }

      // Scambia le task array
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

      // Rimuovi cleaner entries vuote (se dopo lo swap uno è rimasto senza task)
      timelineData.cleaners_assignments = timelineData.cleaners_assignments.filter(
        (c: any) => c.tasks && c.tasks.length > 0
      );

      // Aggiorna metadata
      timelineData.metadata = timelineData.metadata || {};
      timelineData.metadata.last_updated = new Date().toISOString();
      timelineData.metadata.date = workDate;
      timelineData.meta.total_cleaners = timelineData.cleaners_assignments.length;
      timelineData.meta.total_tasks = timelineData.cleaners_assignments.reduce(
        (sum: number, c: any) => sum + c.tasks.length, 0
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
        (sum: number, c: any) => sum + c.tasks.length, 0
      );

      // Scrittura atomica
      const tmpPath = `${timelinePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(timelineData, null, 2));
      await fs.rename(tmpPath, timelinePath);

      // RIMUOVI SEMPRE la task da containers.json quando salvata in timeline
      if (containersData && containersData.containers) {
        try {
          let taskRemoved = false;
          
          // Cerca in tutti i container
          for (const [containerType, container] of Object.entries(containersData.containers)) {
            const containerObj = container as any;
            if (!containerObj.tasks) continue;
            
            const originalCount = containerObj.tasks.length;
            containerObj.tasks = containerObj.tasks.filter((t: any) => 
              String(t.task_id) !== normalizedTaskId && 
              String(t.logistic_code) !== normalizedLogisticCode
            );
            const newCount = containerObj.tasks.length;

            if (originalCount > newCount) {
              containerObj.count = newCount;
              taskRemoved = true;
              console.log(`✅ Task ${normalizedLogisticCode} rimossa da ${containerType}`);
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
        (sum: number, c: any) => sum + c.tasks.length, 0
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
              !['automatic_assignment_eo', 'automatic_assignment_hp', 'automatic_assignment_lp', 'manual_assignment'].includes(r)
            );
          }

          // Aggiungi al container
          if (!containersData.containers[containerType].tasks) {
            containersData.containers[containerType].tasks = [];
          }
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

  // Endpoint per aggiungere un cleaner alla timeline
  app.post("/api/add-cleaner-to-timeline", async (req, res) => {
    try {
      const { cleanerId, date } = req.body;
      const workDate = date || format(new Date(), 'yyyy-MM-dd');
      const timelinePath = path.join(process.cwd(), 'client/public/data/output/timeline.json');
      const cleanersPath = path.join(process.cwd(), 'client/public/data/cleaners/cleaners.json');

      console.log(`Aggiunta cleaner ${cleanerId} alla timeline per data ${workDate}`);

      // Carica cleaners.json per ottenere i dati del cleaner
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
      const cleanerData = dateCleaners.find((c: any) => c.id === cleanerId);

      if (!cleanerData) {
        return res.status(404).json({ success: false, error: "Cleaner non trovato per questa data" });
      }

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

      // Verifica che il cleaner non sia già presente
      const existingCleaner = timelineData.cleaners_assignments.find(
        (c: any) => c.cleaner?.id === cleanerId || c.cleaner_id === cleanerId
      );

      if (existingCleaner) {
        return res.status(400).json({ success: false, error: "Cleaner già presente nella timeline" });
      }

      // Aggiungi il cleaner alla timeline con array tasks vuoto
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

      timelineData.cleaners_assignments.push(newCleanerEntry);

      // Aggiorna metadata
      timelineData.metadata = timelineData.metadata || {};
      timelineData.metadata.last_updated = new Date().toISOString();
      timelineData.metadata.date = workDate;
      timelineData.meta.total_cleaners = timelineData.cleaners_assignments.length;
      timelineData.meta.total_tasks = timelineData.cleaners_assignments.reduce(
        (sum: number, c: any) => sum + c.tasks.length, 0
      );
      timelineData.meta.last_updated = new Date().toISOString();

      // Scrittura atomica timeline
      const tmpPath = `${timelinePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(timelineData, null, 2));
      await fs.rename(tmpPath, timelinePath);

      // Aggiorna anche selected_cleaners.json per persistere il cleaner
      const selectedCleanersPath = path.join(process.cwd(), 'client/public/data/cleaners/selected_cleaners.json');
      let selectedCleanersData: any;
      
      try {
        const selectedContent = await fs.readFile(selectedCleanersPath, 'utf8');
        selectedCleanersData = JSON.parse(selectedContent);
      } catch (error) {
        // Se il file non esiste, crealo
        selectedCleanersData = { cleaners: [], total_selected: 0 };
      }

      // Verifica che il cleaner non sia già in selected_cleaners.json
      const isAlreadySelected = selectedCleanersData.cleaners.some((c: any) => c.id === cleanerId);
      
      if (!isAlreadySelected) {
        // Aggiungi il cleaner COMPLETO con tutti i suoi campi, non solo i campi base
        selectedCleanersData.cleaners.push(cleanerData);
        selectedCleanersData.total_selected = selectedCleanersData.cleaners.length;
        
        // Salva selected_cleaners.json
        await fs.writeFile(selectedCleanersPath, JSON.stringify(selectedCleanersData, null, 2));
        console.log(`✅ Cleaner ${cleanerId} aggiunto anche a selected_cleaners.json`);
      }

      console.log(`✅ Cleaner ${cleanerId} aggiunto alla timeline con successo`);
      res.json({ success: true, cleaner: newCleanerEntry });
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
      const { taskId, logisticCode, fromContainer: sourceContainer, toContainer: destContainer } = req.body;

      const containersPath = path.join(process.cwd(), 'client/public/data/output/containers.json');
      const timelinePath = path.join(process.cwd(), 'client/public/data/output/timeline.json');

      // Carica containers.json
      let containersData: any = {
        containers: {
          early_out: { tasks: [], count: 0 },
          high_priority: { tasks: [], count: 0 },
          low_priority: { tasks: [], count: 0 }
        },
        summary: { total_tasks: 0, early_out: 0, high_priority: 0, low_priority: 0 }
      };
      try {
        const existingData = await fs.readFile(containersPath, 'utf8');
        containersData = JSON.parse(existingData);
      } catch (error) {
        console.log('File containers.json non trovato, creazione di una nuova struttura.');
      }

      // Carica timeline.json
      let timelineData: any = {
        cleaners_assignments: [],
        current_date: format(new Date(), 'yyyy-MM-dd'),
        meta: { total_cleaners: 0, total_tasks: 0, last_updated: new Date().toISOString() }
      };
      try {
        const existingData = await fs.readFile(timelinePath, 'utf8');
        timelineData = JSON.parse(existingData);
      } catch (error) {
        console.log('File timeline.json non trovato, creazione di una nuova struttura.');
      }

      let taskToMove = null;
      let sourceContainerType: string | null = null; // To track where the task came from if it's from containers

      // CASO 1: Spostamento DA timeline A containers
      if (sourceContainer && sourceContainer.startsWith('timeline-')) {
        const cleanerId = Number(sourceContainer.split('-')[1]); // Extract cleaner ID from timeline-id

        // Trova la task in timeline e rimuovila
        for (const cleanerEntry of timelineData.cleaners_assignments) {
          if (cleanerEntry.cleaner.id === cleanerId) {
            const taskIndex = cleanerEntry.tasks.findIndex((t: any) => 
              String(t.task_id) === String(taskId) || String(t.logistic_code) === String(logisticCode)
            );
            if (taskIndex !== -1) {
              taskToMove = cleanerEntry.tasks[taskIndex];
              cleanerEntry.tasks.splice(taskIndex, 1);

              // Rimuovi campi specifici della timeline
              delete taskToMove.sequence;
              delete taskToMove.start_time;
              delete taskToMove.end_time;
              delete taskToMove.travel_time;
              delete taskToMove.followup;

              // Aggiorna la reason
              taskToMove.reasons = taskToMove.reasons || [];
              if (!taskToMove.reasons.includes('manually_moved_to_container')) {
                taskToMove.reasons.push('manually_moved_to_container');
              }

              break; // Task found and removed from this cleaner
            }
          }
        }

        // Rimuovi cleaner entries vuote
        timelineData.cleaners_assignments = timelineData.cleaners_assignments.filter(
          (c: any) => c.tasks && c.tasks.length > 0
        );

        // Aggiorna meta timeline
        timelineData.meta.total_cleaners = timelineData.cleaners_assignments.length;
        timelineData.meta.total_tasks = timelineData.cleaners_assignments.reduce(
          (sum: number, c: any) => sum + c.tasks.length, 0
        );
        timelineData.meta.last_updated = new Date().toISOString();

        // Scrittura atomica per timeline
        const tmpTimelinePath = `${timelinePath}.tmp`;
        await fs.writeFile(tmpTimelinePath, JSON.stringify(timelineData, null, 2));
        await fs.rename(tmpTimelinePath, timelinePath);


        // Aggiungi la task al container di destinazione
        if (destContainer && containersData.containers[destContainer]) {
          taskToMove.priority = destContainer;
          containersData.containers[destContainer].tasks.push(taskToMove);
          containersData.containers[destContainer].count = containersData.containers[destContainer].tasks.length;

          // Aggiorna summary
          if(containersData.summary) {
            containersData.summary[destContainer] = containersData.containers[destContainer].count;
            containersData.summary.total_tasks = 
              containersData.containers.early_out.count + 
              containersData.containers.high_priority.count + 
              containersData.containers.low_priority.count;
          }

          // Scrittura atomica per containers
          const tmpContainersPath = `${containersPath}.tmp`;
          await fs.writeFile(tmpContainersPath, JSON.stringify(containersData, null, 2));
          await fs.rename(tmpContainersPath, containersPath);

          console.log(`✅ Task ${logisticCode} spostata da timeline a ${destContainer}`);
        }

        res.json({ success: true, message: "Task spostata da timeline a container" });
        return;
      }

      // CASO 2: Spostamento DA containers A timeline
      if (destContainer.startsWith('timeline-')) {
        const cleanerId = Number(destContainer.split('-')[1]);

        // Cerca la task in containers e rimuovila
        for (const [containerType, container] of Object.entries(containersData.containers || {})) {
          const taskIndex = (container as any).tasks?.findIndex((t: any) => 
            String(t.task_id) === String(taskId) || String(t.logistic_code) === String(logisticCode)
          );
          if (taskIndex !== -1) {
            taskToMove = (container as any).tasks[taskIndex];
            sourceContainerType = containerType; // Track where it came from
            (container as any).tasks.splice(taskIndex, 1);
            (container as any).count = (container as any).tasks.length;
            break;
          }
        }

        if (!taskToMove) {
          return res.status(404).json({ error: 'Task non trovata nei containers.' });
        }

        // Aggiungi la task alla timeline del cleaner
        let cleanerEntry = timelineData.cleaners_assignments.find((c: any) => c.cleaner.id === cleanerId);
        if (!cleanerEntry) {
          // Se il cleaner non esiste, cercalo in selected_cleaners.json
          const cleanersPath = path.join(process.cwd(), 'client/public/data/cleaners/selected_cleaners.json');
          const cleanersData = JSON.parse(await fs.readFile(cleanersPath, 'utf8'));
          const cleaner = cleanersData.cleaners.find((c: any) => c.id === cleanerId);
          if (!cleaner) {
            return res.status(404).json({ error: 'Cleaner non trovato.' });
          }
          cleanerEntry = {
            cleaner: {
              id: cleaner.id,
              name: cleaner.name,
              lastname: cleaner.lastname,
              role: cleaner.role,
              premium: cleaner.premium
            },
            tasks: []
          };
          timelineData.cleaners_assignments.push(cleanerEntry);
        }

        // Trova la sequenza corretta
        const maxSequence = cleanerEntry.tasks.reduce((max: number, t: any) => Math.max(max, t.sequence || 0), 0);
        const newSequence = maxSequence + 1;

        // Costruisci la task per la timeline mantenendo TUTTI i campi originali (incluso confirmed_operation)
        const task_for_timeline = {
          ...taskToMove, // Mantiene TUTTI i campi originali, incluso confirmed_operation
          sequence: newSequence,
          followup: newSequence > 1,
          travel_time: 0,
          start_time: taskToMove.start_time || "10:00",
          end_time: taskToMove.end_time || "11:00",
          reasons: [
            ...(taskToMove.reasons || []),
            "manual_assignment"
          ],
          priority: taskToMove.priority || sourceContainerType || 'low_priority' // Assign correct priority
        };

        cleanerEntry.tasks.push(task_for_timeline);

        // Aggiorna meta timeline
        timelineData.meta.total_cleaners = timelineData.cleaners_assignments.length;
        timelineData.meta.total_tasks = timelineData.cleaners_assignments.reduce(
          (sum: number, c: any) => sum + c.tasks.length, 0
        );
        timelineData.meta.last_updated = new Date().toISOString();

        // Scrittura atomica per timeline
        const tmpTimelinePath = `${timelinePath}.tmp`;
        await fs.writeFile(tmpTimelinePath, JSON.stringify(timelineData, null, 2));
        await fs.rename(tmpTimelinePath, timelinePath);

        // Aggiorna summary containers
        if(containersData.summary) {
          containersData.summary = {
            total_tasks: containersData.containers.early_out.count + 
                          containersData.containers.high_priority.count + 
                          containersData.containers.low_priority.count,
            early_out: containersData.containers.early_out.count,
            high_priority: containersData.containers.high_priority.count,
            low_priority: containersData.containers.low_priority.count
          };
        }

        // Scrittura atomica per containers
        const tmpContainersPath = `${containersPath}.tmp`;
        await fs.writeFile(tmpContainersPath, JSON.stringify(containersData, null, 2));
        await fs.rename(tmpContainersPath, containersPath);

        console.log(`✅ Task ${logisticCode} spostata da ${sourceContainerType} a timeline (cleaner ${cleanerId})`);
      }
      // CASO 3: Spostamento TRA containers
      if (sourceContainer && containersData.containers[sourceContainer]) {
        sourceContainerType = sourceContainer; // Mark that the task originates from a container
        const taskIndex = containersData.containers[sourceContainer].tasks.findIndex(
          (t: any) => String(t.task_id) === String(taskId) || String(t.logistic_code) === String(logisticCode)
        );

        if (taskIndex !== -1) {
          taskToMove = containersData.containers[sourceContainer].tasks[taskIndex];
          containersData.containers[sourceContainer].tasks.splice(taskIndex, 1);
          containersData.containers[sourceContainer].count = containersData.containers[sourceContainer].tasks.length;

          // Aggiungi al container di destinazione
          if (destContainer && containersData.containers[destContainer]) {
            taskToMove.priority = destContainer;
            containersData.containers[destContainer].tasks.push(taskToMove);
            containersData.containers[destContainer].count = containersData.containers[destContainer].tasks.length;
          }

          // Aggiorna summary
          if(containersData.summary) {
            containersData.summary = {
              total_tasks: containersData.containers.early_out.count + 
                          containersData.containers.high_priority.count + 
                          containersData.containers.low_priority.count,
              early_out: containersData.containers.early_out.count,
              high_priority: containersData.containers.high_priority.count,
              low_priority: containersData.containers.low_priority.count
            };
          }

          // Scrittura atomica per containers
          const tmpContainersPath = `${containersPath}.tmp`;
          await fs.writeFile(tmpContainersPath, JSON.stringify(containersData, null, 2));
          await fs.rename(tmpContainersPath, containersPath);
          console.log(`✅ Task ${logisticCode} spostata da ${sourceContainer} a ${destContainer}`);
        }
      }

      res.json({ success: true, message: "Task spostata con successo" });
    } catch (error: any) {
      console.error("Errore nello spostamento del task:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per salvare i cleaners selezionati
  app.post("/api/save-selected-cleaners", async (req, res) => {
    try {
      const selectedCleanersPath = path.join(process.cwd(), 'client/public/data/cleaners/selected_cleaners.json');
      const dataToSave = req.body;

      await fs.writeFile(selectedCleanersPath, JSON.stringify(dataToSave, null, 2));

      res.json({
        success: true,
        message: `Salvati ${dataToSave.total_selected} cleaners in selected_cleaners.json`,
        total_selected: dataToSave.total_selected
      });
    } catch (error: any) {
      console.error("Errore nel salvataggio dei cleaners selezionati:", error);
      res.status(500).json({
        success: false,
        message: 'Errore nel salvataggio dei cleaners selezionati',
        error: error.message
      });
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
        message: 'Errore durante l\'estrazione delle statistiche task per convocazioni',
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
        message: 'Errore durante l\'estrazione dei cleaners (ottimizzato)',
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

      // Carica timeline per questa data specifica
      let timelineData: any = { 
        metadata: { last_updated: new Date().toISOString(), date },
        cleaners_assignments: [],
        meta: { total_cleaners: 0, used_cleaners: 0, assigned_tasks: 0 }
      };
      let loadedFrom = 'new';

      try {
        // Primo tentativo: carica da timeline.json
        const existingData = await fs.readFile(timelinePath, 'utf8');
        timelineData = JSON.parse(existingData);

        // Se il file esiste ma è vuoto o per un'altra data, prova a caricare da assigned
        if (!timelineData.cleaners_assignments || timelineData.cleaners_assignments.length === 0 || 
            (timelineData.metadata && timelineData.metadata.date !== date)) {
          console.log(`Timeline per ${date} è vuota o per altra data, cercando in assigned...`);
          throw new Error('No assignments in timeline file');
        }

        console.log(`Caricato timeline per ${date} con ${timelineData.cleaners_assignments.length} assegnazioni`);
        loadedFrom = 'timeline';
      } catch (error) {
        // Secondo tentativo: carica da assigned/assignments_{ddmmyy}.json
        try {
          const dateObj = new Date(date);
          const day = String(dateObj.getDate()).padStart(2, '0');
          const month = String(dateObj.getMonth() + 1).padStart(2, '0');
          const year = String(dateObj.getFullYear()).slice(-2);
          const filename = `assignments_${day}${month}${year}.json`;
          const assignedFilePath = path.join(assignedDir, filename);

          console.log(`Cercando file confermato: ${filename}`);
          const confirmedData = await fs.readFile(assignedFilePath, 'utf8');
          const confirmedJson = JSON.parse(confirmedData);

          if (confirmedJson.assignments && confirmedJson.assignments.length > 0) {
            timelineData = {
              metadata: { last_updated: new Date().toISOString(), date },
              cleaners_assignments: confirmedJson.assignments || [],
              meta: { total_cleaners: 0, used_cleaners: 0, assigned_tasks: confirmedJson.assignments.length }
            };
            console.log(`✅ Caricato da assigned/${filename} con ${timelineData.cleaners_assignments.length} assegnazioni`);
            loadedFrom = 'assigned';

            // Salva in timeline
            await fs.writeFile(timelinePath, JSON.stringify(timelineData, null, 2));
          } else {
            throw new Error('No assignments in assigned file');
          }
        } catch (assignedError) {
          // Nessun file trovato in nessuna delle due posizioni, crea nuovo file vuoto
          console.log(`Nessuna assegnazione trovata per ${date} in timeline o assigned, creando timeline vuota`);
          loadedFrom = 'new';
          timelineData = { 
            metadata: { last_updated: new Date().toISOString(), date },
            cleaners_assignments: [],
            meta: { total_cleaners: 0, used_cleaners: 0, assigned_tasks: 0 }
          };
          await fs.writeFile(timelinePath, JSON.stringify(timelineData, null, 2));
        }
      }

      // Non resettiamo mai - ogni data ha il suo file
      console.log(`Data selezionata: ${date}, preservo le assegnazioni esistenti (fonte: ${loadedFrom})`);

      // Assicurati che metadata sia sempre aggiornato, specialmente se è stato appena creato
      if (!timelineData.metadata) {
        timelineData.metadata = { last_updated: new Date().toISOString(), date };
        await fs.writeFile(timelinePath, JSON.stringify(timelineData, null, 2));
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

  // Endpoint per salvare le assegnazioni confermate
  app.post("/api/confirm-assignments", async (req, res) => {
    try {
      const { date } = req.body;
      const assignedDir = path.join(process.cwd(), 'client/public/data/assigned');

      // Crea la directory se non esiste
      await fs.mkdir(assignedDir, { recursive: true });

      // Formato data: ddmmyy
      const dateObj = new Date(date);
      const day = String(dateObj.getDate()).padStart(2, '0');
      const month = String(dateObj.getMonth() + 1).padStart(2, '0');
      const year = String(dateObj.getFullYear()).slice(-2);
      const filename = `assignments_${day}${month}${year}.json`;

      const assignedFilePath = path.join(assignedDir, filename);
      const timelinePath = path.join(process.cwd(), 'client/public/data/output/timeline.json');

      // Carica le assegnazioni della timeline (manuali)
      let timelineData: any = { 
        metadata: { last_updated: new Date().toISOString(), date },
        cleaners_assignments: [],
        meta: { total_cleaners: 0, used_cleaners: 0, assigned_tasks: 0 }
      };
      try {
        const existingData = await fs.readFile(timelinePath, 'utf8');
        timelineData = JSON.parse(existingData);
      } catch (error) {
        console.log('Nessuna assegnazione manuale trovata per questa data');
      }

      // Carica le assegnazioni dagli script
      const eoAssignmentsPath = path.join(process.cwd(), 'client/public/data/output/early_out_assignments.json');
      const hpAssignmentsPath = path.join(process.cwd(), 'client/public/data/output/high_priority_assignments.json');
      const lpAssignmentsPath = path.join(process.cwd(), 'client/public/data/output/low_priority_assignments.json');

      // Trasforma cleaners_assignments in formato piatto per compatibilità
      let allAssignments: any[] = [];
      if (timelineData.cleaners_assignments) {
        for (const cleanerEntry of timelineData.cleaners_assignments) {
          for (const task of cleanerEntry.tasks || []) {
            allAssignments.push({
              task_id: task.task_id,
              logistic_code: String(task.logistic_code),
              cleanerId: cleanerEntry.cleaner.id,
              assignment_type: task.priority || "manual",
              sequence: task.sequence,
              address: task.address,
              lat: task.lat,
              lng: task.lng,
              premium: task.premium,
              cleaning_time: task.cleaning_time,
              start_time: task.start_time,
              end_time: task.end_time,
              travel_time: task.travel_time,
              followup: task.followup
            });
          }
        }
      }

      // Aggiungi assegnazioni EO
      try {
        const eoData = await fs.readFile(eoAssignmentsPath, 'utf8');
        const eoJson = JSON.parse(eoData);
        console.log(`EO file current_date: ${eoJson.current_date}, searching for: ${date}`);
        console.log(`EO tasks found: ${eoJson.early_out_tasks_assigned?.length || 0} cleaners`);

        if (eoJson.current_date === date) {
          for (const cleanerEntry of eoJson.early_out_tasks_assigned || []) {
            const cleanerId = cleanerEntry.cleaner.id;
            console.log(`Processing cleaner ${cleanerId} with ${cleanerEntry.tasks?.length || 0} EO tasks`);
            for (const task of cleanerEntry.tasks || []) {
              // Verifica se questa task non è già nelle assegnazioni manuali
              const alreadyExists = allAssignments.some(a => 
                String(a.logistic_code) === String(task.logistic_code) ||
                String(a.task_id) === String(task.task_id)
              );
              if (!alreadyExists) {
                console.log(`Adding EO task ${task.task_id} (${task.logistic_code}) to cleaner ${cleanerId}`);
                allAssignments.push({
                  task_id: task.task_id,
                  logistic_code: String(task.logistic_code),
                  cleanerId: cleanerId,
                  assignment_type: "early_out",
                  sequence: task.sequence,
                  address: task.address,
                  lat: task.lat,
                  lng: task.lng,
                  premium: task.premium,
                  cleaning_time: task.cleaning_time,
                  start_time: task.start_time,
                  end_time: task.end_time,
                  travel_time: task.travel_time,
                  followup: task.followup
                });
              } else {
                console.log(`Skipping duplicate EO task ${task.task_id} (${task.logistic_code})`);
              }
            }
          }
        } else {
          console.log(`EO file date mismatch: ${eoJson.current_date} !== ${date}`);
        }
      } catch (error) {
        console.log('Nessuna assegnazione Early Out trovata:', error);
      }

      // Aggiungi assegnazioni HP
      try {
        const hpData = await fs.readFile(hpAssignmentsPath, 'utf8');
        const hpJson = JSON.parse(hpData);
        console.log(`HP file current_date: ${hpJson.current_date}, searching for: ${date}`);
        console.log(`HP tasks found: ${hpJson.high_priority_tasks_assigned?.length || 0} cleaners`);

        // Confronta solo la data senza l'ora
        const hpDate = hpJson.current_date?.split('T')[0] || hpJson.current_date;
        const searchDate = date.split('T')[0];

        if (hpDate === searchDate) {
          for (const cleanerEntry of hpJson.high_priority_tasks_assigned || []) {
            const cleanerId = cleanerEntry.cleaner.id;
            console.log(`Processing cleaner ${cleanerId} with ${cleanerEntry.tasks?.length || 0} HP tasks`);
            for (const task of cleanerEntry.tasks || []) {
              const alreadyExists = allAssignments.some(a => 
                String(a.logistic_code) === String(task.logistic_code) ||
                String(a.task_id) === String(task.task_id)
              );
              if (!alreadyExists) {
                console.log(`Adding HP task ${task.task_id} (${task.logistic_code}) to cleaner ${cleanerId}`);
                allAssignments.push({
                  task_id: task.task_id,
                  logistic_code: String(task.logistic_code),
                  cleanerId: cleanerId,
                  assignment_type: "high_priority",
                  sequence: task.sequence,
                  address: task.address,
                  lat: task.lat,
                  lng: task.lng,
                  premium: task.premium,
                  cleaning_time: task.cleaning_time,
                  start_time: task.start_time,
                  end_time: task.end_time,
                  travel_time: task.travel_time,
                  followup: task.followup
                });
              } else {
                console.log(`Skipping duplicate HP task ${task.task_id} (${task.logistic_code})`);
              }
            }
          }
        } else {
          console.log(`HP file date mismatch: ${hpDate} !== ${searchDate}`);
        }
      } catch (error) {
        console.log('Nessuna assegnazione High Priority trovata:', error);
      }

      // Aggiungi assegnazioni LP
      try {
        const lpData = await fs.readFile(lpAssignmentsPath, 'utf8');
        const lpJson = JSON.parse(lpData);
        console.log(`LP file current_date: ${lpJson.current_date}, searching for: ${date}`);
        console.log(`LP tasks found: ${lpJson.low_priority_tasks_assigned?.length || 0} cleaners`);

        // Confronta solo la data senza l'ora
        const lpDate = lpJson.current_date?.split('T')[0] || lpJson.current_date;
        const searchDate = date.split('T')[0];

        if (lpDate === searchDate) {
          for (const cleanerEntry of lpJson.low_priority_tasks_assigned || []) {
            const cleanerId = cleanerEntry.cleaner.id;
            console.log(`Processing cleaner ${cleanerId} with ${cleanerEntry.tasks?.length || 0} LP tasks`);
            for (const task of cleanerEntry.tasks || []) {
              const alreadyExists = allAssignments.some(a => 
                String(a.logistic_code) === String(task.logistic_code) ||
                String(a.task_id) === String(task.task_id)
              );
              if (!alreadyExists) {
                console.log(`Adding LP task ${task.task_id} (${task.logistic_code}) to cleaner ${cleanerId}`);
                allAssignments.push({
                  task_id: task.task_id,
                  logistic_code: String(task.logistic_code),
                  cleanerId: cleanerId,
                  assignment_type: "low_priority",
                  sequence: task.sequence,
                  address: task.address,
                  lat: task.lat,
                  lng: task.lng,
                  premium: task.premium,
                  cleaning_time: task.cleaning_time,
                  start_time: task.start_time,
                  end_time: task.end_time,
                  travel_time: task.travel_time,
                  followup: task.followup
                });
              } else {
                console.log(`Skipping duplicate LP task ${task.task_id} (${task.logistic_code})`);
              }
            }
          }
        } else {
          console.log(`LP file date mismatch: ${lpDate} !== ${searchDate}`);
        }
      } catch (error) {
        console.log('Nessuna assegnazione Low Priority trovata:', error);
      }

      // Salva tutte le assegnazioni confermate
      const confirmedData = {
        date: date,
        confirmed_at: new Date().toISOString(),
        assignments: allAssignments
      };

      console.log(`Salvando ${allAssignments.length} assegnazioni totali in ${filename}`);
      // console.log(`Breakdown: ${timelineData.assignments.length} manuali + ${allAssignments.length - timelineData.assignments.length} da script`); // Corrected line for breakdown

      await fs.writeFile(assignedFilePath, JSON.stringify(confirmedData, null, 2));

      res.json({
        success: true,
        message: `Assegnazioni confermate salvate in ${filename}`,
        filename: filename,
        total_assignments: allAssignments.length
      });
    } catch (error: any) {
      console.error("Errore nel salvataggio delle assegnazioni confermate:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per caricare assegnazioni confermate
  app.get("/api/load-confirmed-assignments/:date", async (req, res) => {
    try {
      const { date } = req.params;
      const assignedDir = path.join(process.cwd(), 'client/public/data/assigned');
      const timelinePath = path.join(process.cwd(), 'client/public/data/output/timeline.json');

      // Formato data: ddmmyy
      const dateObj = new Date(date);
      const day = String(dateObj.getDate()).padStart(2, '0');
      const month = String(dateObj.getMonth() + 1).padStart(2, '0');
      const year = String(dateObj.getFullYear()).slice(-2);
      const filename = `assignments_${day}${month}${year}.json`;

      const assignedFilePath = path.join(assignedDir, filename);

      try {
        const data = await fs.readFile(assignedFilePath, 'utf8');
        const confirmedData = JSON.parse(data);

        res.json({
          success: true,
          data: confirmedData,
          message: `Assegnazioni caricate da ${filename}`
        });
      } catch (error) {
        // File non esiste in assigned, prova timeline.json
        try {
          const timelineData = await fs.readFile(timelinePath, 'utf8');
          const timeline = JSON.parse(timelineData);

          if (timeline.metadata?.date === date && timeline.assignments && timeline.assignments.length > 0) {
            res.json({
              success: true,
              data: timeline,
              message: `Assegnazioni caricate da timeline.json`
            });
          } else {
            res.json({
              success: true,
              data: null,
              message: 'Nessuna assegnazione confermata trovata per questa data'
            });
          }
        } catch (timelineError) {
          res.json({
            success: true,
            data: null,
            message: 'Nessuna assegnazione confermata trovata per questa data'
          });
        }
      }
    } catch (error: any) {
      console.error("Errore nel caricamento delle assegnazioni confermate:", error);
      res.status(500).json({ success: false, error: error.message });
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

      // Trova la task da spostare
      const taskIndex = cleanerEntry.tasks.findIndex((t: any) => 
        String(t.task_id) === String(taskId) || String(t.logistic_code) === String(logisticCode)
      );

      if (taskIndex === -1) {
        return res.status(404).json({ success: false, message: "Task non trovata" });
      }

      // Rimuovi la task dalla posizione originale
      const [task] = cleanerEntry.tasks.splice(taskIndex, 1);

      // Inserisci nella nuova posizione
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
        (sum: number, c: any) => sum + (c.tasks?.length || 0), 0
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