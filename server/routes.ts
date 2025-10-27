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
      const timelineAssignmentsBasePath = path.join(process.cwd(), 'client/public/data/output/timeline_assignments');
      const timelineAssignmentsPath = path.join(timelineAssignmentsBasePath, `${workDate}.json`);
      const generalTimelinePath = path.join(process.cwd(), 'client/public/data/output/timeline_assignments.json');

      // Crea la directory se non esiste
      await fs.mkdir(timelineAssignmentsBasePath, { recursive: true });

      // Svuota il file principale timeline_assignments.json
      await fs.writeFile(generalTimelinePath, JSON.stringify({ assignments: [], current_date: workDate }, null, 2));
      console.log(`Timeline principale resettata: timeline_assignments.json`);

      // Svuota anche il file per questa data specifica
      await fs.writeFile(timelineAssignmentsPath, JSON.stringify({ assignments: [], current_date: workDate }, null, 2));
      console.log(`Timeline resettata per la data ${workDate}`);

      res.json({ success: true, message: `Assegnazioni della timeline resettate per ${workDate}` });
    } catch (error: any) {
      console.error("Errore nel reset delle assegnazioni della timeline:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per salvare un'assegnazione nella timeline
  app.post("/api/save-timeline-assignment", async (req, res) => {
    try {
      const { taskId, cleanerId, logisticCode, date, assignments, dropIndex } = req.body;
      const workDate = date || format(new Date(), 'yyyy-MM-dd');
      const timelineAssignmentsBasePath = path.join(process.cwd(), 'client/public/data/output/timeline_assignments');
      const timelineAssignmentsPath = path.join(timelineAssignmentsBasePath, `${workDate}.json`);

      // Crea la directory se non esiste
      await fs.mkdir(timelineAssignmentsBasePath, { recursive: true });

      // Carica o crea il file delle assegnazioni timeline
      let timelineData: any = { 
        assignments: [], 
        current_date: workDate,
        scheduleVersion: 1
      };

      try {
        const existingData = await fs.readFile(timelineAssignmentsPath, 'utf8');
        timelineData = JSON.parse(existingData);
        if (!timelineData.scheduleVersion) {
          timelineData.scheduleVersion = 1;
        }
      } catch (error) {
        console.log(`Creazione nuovo file timeline per ${workDate}`);
      }

      // Normalizza logisticCode e taskId come stringhe
      const normalizedLogisticCode = String(logisticCode);
      const normalizedTaskId = String(taskId);
      const normalizedCleanerId = Number(cleanerId);

      // Rimuovi assegnazioni precedenti dello stesso task (evita duplicazioni)
      timelineData.assignments = timelineData.assignments.filter((a: any) => {
        const aLogisticCode = String(a.logisticCode ?? a.logistic_code);
        const aTaskId = String(a.taskId ?? a.task_id);
        return aLogisticCode !== normalizedLogisticCode && aTaskId !== normalizedTaskId;
      });

      // Separa assegnazioni dello stesso cleaner e degli altri
      const sameCleanerAssignments = timelineData.assignments
        .filter((a: any) => Number(a.cleanerId) === normalizedCleanerId)
        .sort((a: any, b: any) => (a.sequence || 0) - (b.sequence || 0));

      const otherAssignments = timelineData.assignments
        .filter((a: any) => Number(a.cleanerId) !== normalizedCleanerId);

      // Crea nuovo assignment normalizzato
      const newAssignment = {
        taskId: normalizedTaskId,
        logisticCode: normalizedLogisticCode,
        cleanerId: normalizedCleanerId,
        assignmentType: 'manual_drag',
        sequence: 0
      };

      // Inserisci in posizione dropIndex
      const targetIndex = dropIndex !== undefined 
        ? Math.max(0, Math.min(dropIndex, sameCleanerAssignments.length))
        : sameCleanerAssignments.length;

      sameCleanerAssignments.splice(targetIndex, 0, newAssignment);

      // Ricalcola sequence
      sameCleanerAssignments.forEach((a: any, i: number) => {
        a.sequence = i + 1;
      });

      // Ricombina tutte le assegnazioni
      timelineData.assignments = [...otherAssignments, ...sameCleanerAssignments];
      timelineData.current_date = workDate;

      // Scrittura atomica
      const tmpPath = `${timelineAssignmentsPath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(timelineData, null, 2));
      await fs.rename(tmpPath, timelineAssignmentsPath);

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
      const timelineAssignmentsBasePath = path.join(process.cwd(), 'client/public/data/output/timeline_assignments');
      const timelineAssignmentsPath = path.join(timelineAssignmentsBasePath, `${workDate}.json`);

      console.log(`Rimozione assegnazione timeline - taskId: ${taskId}, logisticCode: ${logisticCode}, date: ${workDate}`);

      // Carica timeline_assignments per questa data
      let assignmentsData: any = { assignments: [], current_date: workDate };
      try {
        const existingData = await fs.readFile(timelineAssignmentsPath, 'utf8');
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
      await fs.writeFile(timelineAssignmentsPath, JSON.stringify(assignmentsData, null, 2));

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
      const { taskId, logisticCode, fromContainer, toContainer } = req.body;

      const earlyOutPath = path.join(process.cwd(), 'client/public/data/output/early_out.json');
      const highPriorityPath = path.join(process.cwd(), 'client/public/data/output/high_priority.json');
      const lowPriorityPath = path.join(process.cwd(), 'client/public/data/output/low_priority.json');
      const earlyOutAssignmentsPath = path.join(process.cwd(), 'client/public/data/output/early_out_assignments.json');

      const [earlyOutData, highPriorityData, lowPriorityData] = await Promise.all([
        fs.readFile(earlyOutPath, 'utf8').then(JSON.parse),
        fs.readFile(highPriorityPath, 'utf8').then(JSON.parse),
        fs.readFile(lowPriorityPath, 'utf8').then(JSON.parse)
      ]);

      // Trova e rimuovi il task dal container di origine
      let taskToMove = null;

      if (fromContainer === 'early-out') {
        const index = earlyOutData.early_out_tasks.findIndex((t: any) =>
          t.task_id === parseInt(taskId) || t.logistic_code === parseInt(logisticCode)
        );
        if (index !== -1) {
          taskToMove = earlyOutData.early_out_tasks.splice(index, 1)[0];
          earlyOutData.total_apartments = earlyOutData.early_out_tasks.length;
        }
      } else if (fromContainer === 'high') {
        const index = highPriorityData.high_priority_tasks.findIndex((t: any) =>
          t.task_id === parseInt(taskId) || t.logistic_code === parseInt(logisticCode)
        );
        if (index !== -1) {
          taskToMove = highPriorityData.high_priority_tasks.splice(index, 1)[0];
          highPriorityData.total_apartments = highPriorityData.high_priority_tasks.length;
        }
      } else if (fromContainer === 'low') {
        const index = lowPriorityData.low_priority_tasks.findIndex((t: any) =>
          t.task_id === parseInt(taskId) || t.logistic_code === parseInt(logisticCode)
        );
        if (index !== -1) {
          taskToMove = lowPriorityData.low_priority_tasks.splice(index, 1)[0];
          lowPriorityData.total_apartments = lowPriorityData.low_priority_tasks.length;
        }
      }

      if (!taskToMove) {
        res.status(404).json({ success: false, message: "Task non trovato" });
        return;
      }

      // Se la destinazione è la timeline, non aggiungere a nessun container
      if (toContainer && toContainer.startsWith('timeline-')) {
        // Solo rimuovi dal container di origine
        await Promise.all([
          fs.writeFile(earlyOutPath, JSON.stringify(earlyOutData, null, 2)),
          fs.writeFile(highPriorityPath, JSON.stringify(highPriorityData, null, 2)),
          fs.writeFile(lowPriorityPath, JSON.stringify(lowPriorityData, null, 2))
        ]);
        res.json({ success: true, message: "Task rimosso dal container" });
        return;
      }

      // Aggiorna il reason a "manually_forced"
      taskToMove.reasons = ["manually_forced"];

      // Aggiungi il task al container di destinazione
      if (toContainer === 'early-out') {
        earlyOutData.early_out_tasks.push(taskToMove);
        earlyOutData.total_apartments = earlyOutData.early_out_tasks.length;
      } else if (toContainer === 'high') {
        highPriorityData.high_priority_tasks.push(taskToMove);
        highPriorityData.total_apartments = highPriorityData.high_priority_tasks.length;
      } else if (toContainer === 'low') {
        lowPriorityData.low_priority_tasks.push(taskToMove);
        lowPriorityData.total_apartments = lowPriorityData.low_priority_tasks.length;
      }

      // Scrivi i file aggiornati
      await Promise.all([
        fs.writeFile(earlyOutPath, JSON.stringify(earlyOutData, null, 2)),
        fs.writeFile(highPriorityPath, JSON.stringify(highPriorityData, null, 2)),
        fs.writeFile(lowPriorityPath, JSON.stringify(lowPriorityData, null, 2))
      ]);

      // Se la task viene spostata nell'early-out, rimuovila da early_out_assignments
      // in modo che non sia più considerata "già assegnata" al prossimo run dell'optimizer
      if (toContainer === 'early-out') {
        let earlyOutAssignmentsData: any = { early_out_tasks_assigned: [], meta: {} };
        try {
          const existingData = await fs.readFile(earlyOutAssignmentsPath, 'utf8');
          earlyOutAssignmentsData = JSON.parse(existingData);
        } catch (error) {
          // File non esiste, usa struttura vuota
        }

        // Rimuovi la task da tutti i cleaner in early_out_tasks_assigned
        let wasRemoved = false;
        earlyOutAssignmentsData.early_out_tasks_assigned = earlyOutAssignmentsData.early_out_tasks_assigned.map((cleanerEntry: any) => {
          const filteredTasks = cleanerEntry.tasks.filter((t: any) => {
            const matchId = String(t.task_id) === String(taskId);
            const matchCode = String(t.logistic_code) === String(logisticCode);
            if (matchId || matchCode) {
              wasRemoved = true;
              console.log(`Rimossa task ${taskId}/${logisticCode} da early_out_assignments (cleaner ${cleanerEntry.cleaner.id})`);
              return false;
            }
            return true;
          });
          return { ...cleanerEntry, tasks: filteredTasks };
        }).filter((cleanerEntry: any) => cleanerEntry.tasks.length > 0); // Rimuovi cleaner senza task

        if (wasRemoved) {
          await fs.writeFile(earlyOutAssignmentsPath, JSON.stringify(earlyOutAssignmentsData, null, 2));
          console.log(`✅ Task ${taskId}/${logisticCode} rimossa da early_out_assignments.json`);
        }
      }


      res.json({ success: true, message: "Task aggiornato con successo" });
    } catch (error: any) {
      console.error("Errore nell'aggiornamento del task:", error);
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
      const scriptPath = path.join(process.cwd(), 'client/public/scripts/assign_hp_updated.py');

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

      const earlyOutAssignmentsPath = path.join(process.cwd(), 'client/public/data/output/early_out_assignments.json');
      const timelineAssignmentsBasePath = path.join(process.cwd(), 'client/public/data/output/timeline_assignments');
      const timelineAssignmentsPath = path.join(timelineAssignmentsBasePath, `${date}.json`);
      const assignedDir = path.join(process.cwd(), 'client/public/data/assigned');

      // Crea la directory per le assegnazioni se non esiste
      await fs.mkdir(timelineAssignmentsBasePath, { recursive: true });

      // Carica timeline_assignments per questa data specifica
      let timelineData: any = { assignments: [], current_date: date };
      let loadedFrom = 'new';

      try {
        // Primo tentativo: carica da timeline_assignments/{date}.json
        const existingData = await fs.readFile(timelineAssignmentsPath, 'utf8');
        timelineData = JSON.parse(existingData);

        // Se il file esiste ma è vuoto, prova a caricare da assigned
        if (!timelineData.assignments || timelineData.assignments.length === 0) {
          console.log(`Timeline per ${date} è vuota, cercando in assigned...`);
          throw new Error('No assignments in timeline file');
        }

        console.log(`Caricato timeline_assignments per ${date} con ${timelineData.assignments.length} assegnazioni`);
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

            // Salva in timeline_assignments per questa data
            await fs.writeFile(timelineAssignmentsPath, JSON.stringify(timelineData, null, 2));
          } else {
            throw new Error('No assignments in assigned file');
          }
        } catch (assignedError) {
          // Nessun file trovato in nessuna delle due posizioni, crea nuovo file vuoto
          console.log(`Nessuna assegnazione trovata per ${date} in timeline o assigned, creando timeline vuota`);
          loadedFrom = 'new';
          timelineData = { assignments: [], current_date: date };
          await fs.writeFile(timelineAssignmentsPath, JSON.stringify(timelineData, null, 2));
        }
      }

      // Non resettiamo mai - ogni data ha il suo file
      console.log(`Data selezionata: ${date}, preservo le assegnazioni esistenti (fonte: ${loadedFrom})`);

      // Assicurati che current_date sia sempre aggiornato, specialmente se è stato appena creato
      if (!timelineData.current_date) {
        timelineData.current_date = date;
        await fs.writeFile(timelineAssignmentsPath, JSON.stringify(timelineData, null, 2));
      }

      // Usa python3 e chiama task_extractor.py con la data specificata
      const command = date
        ? `python3 client/public/scripts/task_extractor.py ${date}`
        : 'python3 client/public/scripts/task_extractor.py';

      console.log(`Eseguendo task_extractor.py con data ${date || 'default'}...`);
      const taskExtractorResult = await execAsync(command, {
        cwd: process.cwd(),
        maxBuffer: 10 * 1024 * 1024
      });
      console.log("task_extractor output:", taskExtractorResult.stdout);

      console.log("Eseguendo extract_all.py...");
      const extractAllResult = await execAsync('python3 client/public/scripts/extract_all.py', {
        cwd: process.cwd(),
        maxBuffer: 10 * 1024 * 1024
      });
      console.log("extract_all output:", extractAllResult.stdout);

      res.json({
        success: true,
        message: "Dati estratti con successo",
        outputs: {
          task_extractor: taskExtractorResult.stdout,
          extract_all: extractAllResult.stdout
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
      const scriptPath = path.join(process.cwd(), 'client/public/scripts/assign_eo_updated.py');

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
      const timelineAssignmentsPath = path.join(
        process.cwd(),
        'client/public/data/output/timeline_assignments',
        `${date}.json`
      );

      // Carica le assegnazioni della timeline (manuali)
      let timelineData: any = { assignments: [], current_date: date };
      try {
        const existingData = await fs.readFile(timelineAssignmentsPath, 'utf8');
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
        // File non esiste
        res.json({
          success: true,
          data: null,
          message: 'Nessuna assegnazione confermata trovata per questa data'
        });
      }
    } catch (error: any) {
      console.error("Errore nel caricamento delle assegnazioni confermate:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });




  const httpServer = createServer(app);
  return httpServer;
}