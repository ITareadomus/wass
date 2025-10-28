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
      await fs.writeFile(timelinePath, JSON.stringify({ assignments: [], current_date: workDate }, null, 2));
      console.log(`Timeline resettata: timeline.json`);

      res.json({ success: true, message: `Assegnazioni della timeline resettate per ${workDate}` });
    } catch (error: any) {
      console.error("Errore nel reset delle assegnazioni della timeline:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per salvare un'assegnazione nella timeline
  app.post("/api/save-timeline-assignment", async (req, res) => {
    try {
      const { taskId, cleanerId, logisticCode, date, dropIndex, taskData } = req.body;
      const workDate = date || format(new Date(), 'yyyy-MM-dd');
      const timelinePath = path.join(process.cwd(), 'client/public/data/output/timeline.json');
      const containersPath = path.join(process.cwd(), 'client/public/data/output/containers.json');

      // Carica containers per ottenere i dati completi del task
      let fullTaskData: any = null;
      if (taskData) {
        fullTaskData = taskData;
      } else {
        const containersData = JSON.parse(await fs.readFile(containersPath, 'utf8'));
        // Cerca il task nei containers
        for (const containerKey of ['early_out', 'high_priority', 'low_priority']) {
          const container = containersData.containers?.[containerKey];
          if (container?.tasks) {
            const task = container.tasks.find((t: any) => 
              String(t.task_id) === String(taskId) || String(t.logistic_code) === String(logisticCode)
            );
            if (task) {
              fullTaskData = task;
              break;
            }
          }
        }
      }

      if (!fullTaskData) {
        throw new Error(`Task ${logisticCode} non trovato nei containers`);
      }

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
        const cleanersData = JSON.parse(await fs.readFile(cleanersPath, 'utf8'));
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

      // Crea il nuovo task con TUTTI i dati
      const newTask = {
        task_id: fullTaskData.task_id,
        logistic_code: fullTaskData.logistic_code,
        client_id: fullTaskData.client_id,
        premium: fullTaskData.premium,
        address: fullTaskData.address,
        lat: fullTaskData.lat,
        lng: fullTaskData.lng,
        cleaning_time: fullTaskData.cleaning_time,
        checkin_date: fullTaskData.checkin_date,
        checkout_date: fullTaskData.checkout_date,
        checkin_time: fullTaskData.checkin_time,
        checkout_time: fullTaskData.checkout_time,
        pax_in: fullTaskData.pax_in,
        pax_out: fullTaskData.pax_out,
        small_equipment: fullTaskData.small_equipment,
        operation_id: fullTaskData.operation_id,
        confirmed_operation: fullTaskData.confirmed_operation,
        straordinaria: fullTaskData.straordinaria,
        type_apt: fullTaskData.type_apt,
        alias: fullTaskData.alias,
        customer_name: fullTaskData.customer_name,
        reasons: [...(fullTaskData.reasons || []), 'manually_moved_to_timeline'],
        sequence: 0,
        // Campi che verranno calcolati dagli script di assegnazione
        start_time: null,
        end_time: null,
        travel_time: 0
      };

      // Inserisci in posizione dropIndex
      const targetIndex = dropIndex !== undefined 
        ? Math.max(0, Math.min(dropIndex, cleanerEntry.tasks.length))
        : cleanerEntry.tasks.length;

      cleanerEntry.tasks.splice(targetIndex, 0, newTask);

      // Ricalcola sequence
      cleanerEntry.tasks.forEach((t: any, i: number) => {
        t.sequence = i + 1;
      });

      // Aggiorna meta
      timelineData.current_date = workDate;
      timelineData.meta.total_cleaners = timelineData.cleaners_assignments.length;
      timelineData.meta.total_tasks = timelineData.cleaners_assignments.reduce(
        (sum: number, c: any) => sum + c.tasks.length, 0
      );
      timelineData.meta.last_updated = new Date().toISOString();

      // Scrittura atomica
      const tmpPath = `${timelinePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(timelineData, null, 2));
      await fs.rename(tmpPath, timelinePath);

      console.log(`✅ Salvato assignment per cleaner ${normalizedCleanerId} in posizione ${targetIndex}`);

      // RIMUOVI la task da containers.json se esiste
      try {
        const containersPath = path.join(process.cwd(), 'client/public/data/output/containers.json');
        const containersData = JSON.parse(await fs.readFile(containersPath, 'utf8'));

        let taskRemoved = false;
        for (const containerKey of ['early_out', 'high_priority', 'low_priority']) {
          const container = containersData.containers?.[containerKey];
          if (container?.tasks) {
            const originalCount = container.tasks.length;
            container.tasks = container.tasks.filter((t: any) => 
              String(t.task_id) !== normalizedTaskId && 
              String(t.logistic_code) !== normalizedLogisticCode
            );
            const newCount = container.tasks.length;
            
            if (originalCount > newCount) {
              container.count = newCount;
              containersData.summary[containerKey] = newCount;
              containersData.summary.total_tasks = (containersData.summary.total_tasks || 0) - (originalCount - newCount);
              taskRemoved = true;
              console.log(`✅ Rimossa task ${normalizedLogisticCode} da containers.json (${containerKey})`);
              break;
            }
          }
        }

        if (taskRemoved) {
          await fs.writeFile(containersPath, JSON.stringify(containersData, null, 2));
        }
      } catch (containerError) {
        console.warn('Errore nella rimozione da containers.json:', containerError);
        // Non bloccare la risposta, l'assegnazione timeline è già salvata
      }

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

      console.log(`Rimozione assegnazione timeline - taskId: ${taskId}, logisticCode: ${logisticCode}, date: ${workDate}`);

      // Carica timeline
      let assignmentsData: any = { assignments: [], current_date: workDate };
      try {
        const existingData = await fs.readFile(timelinePath, 'utf8');
        assignmentsData = JSON.parse(existingData);
      } catch (error) {
        // File non esiste, usa struttura vuota
      }

      console.log(`Assegnazioni prima della rimozione:`, assignmentsData.assignments);

      // Rimuovi l'assegnazione per questo task (usa OR per match su logistic_code o taskId)
      const initialLength = assignmentsData.assignments.length;
      assignmentsData.assignments = assignmentsData.assignments.filter(
        (a: any) => {
          const matchCode = String(a.logistic_code) === String(logisticCode);
          const matchId = String(a.taskId) === String(taskId);
          return !matchCode && !matchId;
        }
      );

      console.log(`Assegnazioni dopo la rimozione:`, assignmentsData.assignments);
      console.log(`Rimosse ${initialLength - assignmentsData.assignments.length} assegnazioni`);

      // Salva il file
      await fs.writeFile(timelinePath, JSON.stringify(assignmentsData, null, 2));

      res.json({ success: true, message: "Assegnazione rimossa dalla timeline con successo" });
    } catch (error: any) {
      console.error("Errore nella rimozione dell'assegnazione dalla timeline:", error);
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
        is_straordinaria: task.is_straordinaria,
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

      // CASO 1: Spostamento DA timeline A containers
      if (sourceContainer && sourceContainer.startsWith('timeline-')) {
        // Trova la task in timeline e rimuovila
        for (const cleanerEntry of timelineData.cleaners_assignments) {
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
            
            break;
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
        
        // Scrivi timeline aggiornata
        await fs.writeFile(timelinePath, JSON.stringify(timelineData, null, 2));
        
        // Aggiungi la task al container di destinazione
        if (destContainer && containersData.containers[destContainer]) {
          taskToMove.priority = destContainer;
          containersData.containers[destContainer].tasks.push(taskToMove);
          containersData.containers[destContainer].count = containersData.containers[destContainer].tasks.length;
          
          // Aggiorna summary
          containersData.summary[destContainer] = containersData.containers[destContainer].count;
          containersData.summary.total_tasks = 
            containersData.containers.early_out.count + 
            containersData.containers.high_priority.count + 
            containersData.containers.low_priority.count;
          
          await fs.writeFile(containersPath, JSON.stringify(containersData, null, 2));
          console.log(`✅ Task ${logisticCode} spostata da timeline a ${destContainer}`);
        }
        
        res.json({ success: true, message: "Task spostata da timeline a container" });
        return;
      }

      // CASO 2: Spostamento DA containers A timeline (già gestito da save-timeline-assignment)
      // CASO 3: Spostamento TRA containers
      if (sourceContainer && containersData.containers[sourceContainer]) {
        const taskIndex = containersData.containers[sourceContainer].tasks.findIndex(
          (t: any) => String(t.task_id) === String(taskId) || String(t.logistic_code) === String(logisticCode)
        );
        
        if (taskIndex !== -1) {
          taskToMove = containersData.containers[sourceContainer].tasks[taskIndex];
          containersData.containers[sourceContainer].tasks.splice(taskIndex, 1);
          containersData.containers[sourceContainer].count = containersData.containers[sourceContainer].tasks.length;
          
          // Aggiorna la priorità e aggiungi al container di destinazione
          if (destContainer && containersData.containers[destContainer]) {
            taskToMove.priority = destContainer;
            containersData.containers[destContainer].tasks.push(taskToMove);
            containersData.containers[destContainer].count = containersData.containers[destContainer].tasks.length;
          }
          
          // Aggiorna summary
          containersData.summary = {
            total_tasks: containersData.containers.early_out.count + 
                        containersData.containers.high_priority.count + 
                        containersData.containers.low_priority.count,
            early_out: containersData.containers.early_out.count,
            high_priority: containersData.containers.high_priority.count,
            low_priority: containersData.containers.low_priority.count
          };
          
          await fs.writeFile(containersPath, JSON.stringify(containersData, null, 2));
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

  // Endpoint per estrarre i cleaners
  app.post("/api/extract-cleaners", async (req, res) => {
    try {
      const { date } = req.body;
      const scriptPath = path.join(process.cwd(), 'client', 'public', 'scripts', 'extract_cleaners.py');

      // Se la data è fornita, passala come argomento allo script
      const command = date
        ? `python3 ${scriptPath} ${date}`
        : `python3 ${scriptPath}`;

      console.log("Eseguendo extract_cleaners.py con comando:", command);

      const { stdout, stderr } = await execAsync(command, { maxBuffer: 1024 * 1024 * 10 });

      if (stderr && !stderr.includes('Browserslist')) {
        console.error("Errore extract_cleaners:", stderr);
      }

      console.log("extract_cleaners output:", stdout);

      res.json({
        success: true,
        message: 'Cleaner estratti con successo',
        output: stdout
      });
    } catch (error: any) {
      console.error("Errore durante l'estrazione dei cleaners:", error);
      res.status(500).json({
        success: false,
        message: 'Errore durante l\'estrazione dei cleaners',
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
      const workDate = date || format(new Date(), 'yyyy-MM-dd');

      console.log(`Eseguendo assign_eo.py per timeline.json - data: ${workDate}`);

      const { spawn } = await import('child_process');
      const scriptPath = path.join(process.cwd(), 'client/public/scripts/assign_eo.py');

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
      const workDate = date || format(new Date(), 'yyyy-MM-dd');

      console.log(`Eseguendo assign_hp.py per timeline.json - data: ${workDate}`);

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
      const workDate = date || format(new Date(), 'yyyy-MM-dd');

      console.log(`Eseguendo assign_lp.py per timeline.json - data: ${workDate}`);

      const { spawn } = await import('child_process');
      const scriptPath = path.join(process.cwd(), 'client/public/scripts/assign_lp.py');

      const pythonProcess = spawn('python3', [scriptPath, workDate]);

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
      let timelineData: any = { assignments: [], current_date: date };
      let loadedFrom = 'new';

      try {
        // Primo tentativo: carica da timeline.json
        const existingData = await fs.readFile(timelinePath, 'utf8');
        timelineData = JSON.parse(existingData);

        // Se il file esiste ma è vuoto o per un'altra data, prova a caricare da assigned
        if (!timelineData.assignments || timelineData.assignments.length === 0 || timelineData.current_date !== date) {
          console.log(`Timeline per ${date} è vuota o per altra data, cercando in assigned...`);
          throw new Error('No assignments in timeline file');
        }

        console.log(`Caricato timeline per ${date} con ${timelineData.assignments.length} assegnazioni`);
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
              assignments: confirmedJson.assignments,
              current_date: date
            };
            console.log(`✅ Caricato da assigned/${filename} con ${timelineData.assignments.length} assegnazioni`);
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
          timelineData = { assignments: [], current_date: date };
          await fs.writeFile(timelinePath, JSON.stringify(timelineData, null, 2));
        }
      }

      // Non resettiamo mai - ogni data ha il suo file
      console.log(`Data selezionata: ${date}, preservo le assegnazioni esistenti (fonte: ${loadedFrom})`);

      // Assicurati che current_date sia sempre aggiornato, specialmente se è stato appena creato
      if (!timelineData.current_date) {
        timelineData.current_date = date;
        await fs.writeFile(timelinePath, JSON.stringify(timelineData, null, 2));
      }

      // Esegui create_containers (unifica task_extractor + extract_all)
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
        message: "Dati estratti con successo",
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
      let timelineData: any = { assignments: [], current_date: date };
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

      let allAssignments = [...timelineData.assignments];

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
      console.log(`Breakdown: ${timelineData.assignments.length} manuali + ${allAssignments.length - timelineData.assignments.length} da script`);

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
          
          if (timeline.current_date === date && timeline.assignments && timeline.assignments.length > 0) {
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




  const httpServer = createServer(app);
  return httpServer;
}