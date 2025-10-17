import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertTaskSchema, insertPersonnelSchema, insertAssignmentSchema } from "@shared/schema";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import * as fs from 'fs/promises'; // Import fs/promises for async file operations

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
      const timelineAssignmentsPath = path.join(process.cwd(), 'client/public/data/output/timeline_assignments.json');

      // Svuota il file
      await fs.writeFile(timelineAssignmentsPath, JSON.stringify({ assignments: [] }, null, 2));

      res.json({ success: true, message: "Assegnazioni della timeline resettate con successo" });
    } catch (error: any) {
      console.error("Errore nel reset delle assegnazioni della timeline:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint per salvare un'assegnazione nella timeline
  app.post("/api/save-timeline-assignment", async (req, res) => {
    try {
      const { taskId, cleanerId, logisticCode } = req.body;
      const timelineAssignmentsPath = path.join(process.cwd(), 'client/public/data/output/timeline_assignments.json');

      // Carica o crea timeline_assignments.json
      let assignmentsData: any = { assignments: [] };
      try {
        const existingData = await fs.readFile(timelineAssignmentsPath, 'utf8');
        assignmentsData = JSON.parse(existingData);
      } catch (error) {
        // File non esiste, usa struttura vuota
      }

      // Rimuovi eventuali assegnazioni precedenti per questo task (usa logistic_code se disponibile)
      assignmentsData.assignments = assignmentsData.assignments.filter(
        (a: any) => a.logistic_code !== logisticCode && a.taskId !== taskId
      );

      // Aggiungi la nuova assegnazione
      assignmentsData.assignments.push({
        logistic_code: logisticCode,
        cleanerId,
        assignment_type: "manual_drag"
      });

      // Salva il file
      await fs.writeFile(timelineAssignmentsPath, JSON.stringify(assignmentsData, null, 2));

      res.json({ success: true, message: "Assegnazione salvata nella timeline con successo" });
    } catch (error: any) {
      console.error("Errore nel salvataggio dell'assegnazione nella timeline:", error);
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

  // Endpoint per eseguire assign_early_out.py
  app.post("/api/assign-early-out", async (req, res) => {
    try {
      console.log("Eseguendo assign_early_out.py...");
      const { stdout, stderr } = await execAsync(
        `python3 client/public/scripts/assign_early_out.py`,
        { maxBuffer: 1024 * 1024 * 10 }
      );

      if (stderr && !stderr.includes('Browserslist')) {
        console.error("Errore assign_early_out:", stderr);
      }
      console.log("assign_early_out output:", stdout);

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

  // Endpoint per eseguire l'estrazione dei dati
  app.post("/api/extract-data", async (req, res) => {
    try {
      const { date } = req.body;

      // Resetta solo early_out_assignments, NON timeline_assignments (che persiste tra refresh)
      const earlyOutAssignmentsPath = path.join(process.cwd(), 'client/public/data/output/early_out_assignments.json');

      await fs.writeFile(earlyOutAssignmentsPath, JSON.stringify({ early_out_tasks_assigned: [], meta: {} }, null, 2));

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

  // Task routes
  app.get("/api/tasks", async (req, res) => {
    try {
      const tasks = await storage.getTasks();
      res.json(tasks);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch tasks" });
    }
  });

  app.post("/api/tasks", async (req, res) => {
    try {
      const taskData = insertTaskSchema.parse(req.body);
      const task = await storage.createTask(taskData);
      res.status(201).json(task);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid task data", errors: error.errors });
      } else {
        res.status(500).json({ message: "Failed to create task" });
      }
    }
  });

  app.put("/api/tasks/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const updates = req.body;
      const task = await storage.updateTask(id, updates);

      if (!task) {
        res.status(404).json({ message: "Task not found" });
        return;
      }

      res.json(task);
    } catch (error) {
      res.status(500).json({ message: "Failed to update task" });
    }
  });

  app.delete("/api/tasks/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await storage.deleteTask(id);

      if (!deleted) {
        res.status(404).json({ message: "Task not found" });
        return;
      }

      res.status(204).send();
    } catch (error) {
      res.status(500).json({ message: "Failed to delete task" });
    }
  });

  // Personnel routes
  app.get("/api/personnel", async (req, res) => {
    try {
      const personnel = await storage.getPersonnel();
      res.json(personnel);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch personnel" });
    }
  });

  app.post("/api/personnel", async (req, res) => {
    try {
      const personnelData = insertPersonnelSchema.parse(req.body);
      const person = await storage.createPersonnel(personnelData);
      res.status(201).json(person);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid personnel data", errors: error.errors });
      } else {
        res.status(500).json({ message: "Failed to create personnel" });
      }
    }
  });

  // Assignment routes
  app.get("/api/assignments", async (req, res) => {
    try {
      const assignments = await storage.getAssignments();
      res.json(assignments);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch assignments" });
    }
  });

  app.post("/api/assignments", async (req, res) => {
    try {
      const assignmentData = insertAssignmentSchema.parse(req.body);
      const assignment = await storage.createAssignment(assignmentData);
      res.status(201).json(assignment);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid assignment data", errors: error.errors });
      } else {
        res.status(500).json({ message: "Failed to create assignment" });
      }
    }
  });

  // Bulk update task priority and assignment (for drag and drop)
  app.put("/api/tasks/:id/priority", async (req, res) => {
    try {
      const { id } = req.params;
      const { priority } = req.body;

      let assignedTo: string | null = null;

      // Auto-assign to personnel when moving to priority column
      if (priority && priority !== null) {
        const personnel = await storage.getPersonnel();
        const tasks = await storage.getTasks();

        // Simple round-robin assignment based on current workload
        const workloadMap = new Map<string, number>();

        // Initialize workload counter
        personnel.forEach(person => {
          workloadMap.set(person.id, 0);
        });

        // Count current assignments
        tasks.forEach(task => {
          if (task.assignedTo && task.priority) {
            const currentCount = workloadMap.get(task.assignedTo) || 0;
            workloadMap.set(task.assignedTo, currentCount + 1);
          }
        });

        // Find person with least workload
        let minWorkload = Infinity;
        for (const [personId, workload] of Array.from(workloadMap.entries())) {
          if (workload < minWorkload) {
            minWorkload = workload;
            assignedTo = personId;
          }
        }
      }

      const task = await storage.updateTask(id, { priority, assignedTo });

      if (!task) {
        res.status(404).json({ message: "Task not found" });
        return;
      }

      res.json(task);
    } catch (error) {
      res.status(500).json({ message: "Failed to update task priority" });
    }
  });

  // Auto-assign tasks endpoint
  app.post("/api/tasks/auto-assign", async (req, res) => {
    try {
      const tasks = await storage.getTasks();
      const personnel = await storage.getPersonnel();
      const unassignedTasks = tasks.filter(task => !task.priority);

      // Initialize workload counter
      const workloadMap = new Map<string, number>();
      personnel.forEach(person => {
        workloadMap.set(person.id, 0);
      });

      // Count current assignments
      tasks.forEach(task => {
        if (task.assignedTo && task.priority) {
          const currentCount = workloadMap.get(task.assignedTo) || 0;
          workloadMap.set(task.assignedTo, currentCount + 1);
        }
      });

      // Assign each unassigned task
      for (let i = 0; i < unassignedTasks.length; i++) {
        const priorities = ['early-out', 'high', 'low'];
        const priority = priorities[i % priorities.length];

        // Find person with least workload
        let minWorkload = Infinity;
        let assignedTo: string | null = null;

        for (const [personId, workload] of Array.from(workloadMap.entries())) {
          if (workload < minWorkload) {
            minWorkload = workload;
            assignedTo = personId;
          }
        }

        // Update task and increment workload counter
        await storage.updateTask(unassignedTasks[i].id, { priority, assignedTo });
        if (assignedTo) {
          workloadMap.set(assignedTo, (workloadMap.get(assignedTo) || 0) + 1);
        }
      }

      const updatedTasks = await storage.getTasks();
      res.json(updatedTasks);
    } catch (error) {
      res.status(500).json({ message: "Failed to auto-assign tasks" });
    }
  });

  // Clear all assignments
  app.post("/api/tasks/clear-assignments", async (req, res) => {
    try {
      const tasks = await storage.getTasks();

      for (const task of tasks) {
        await storage.updateTask(task.id, { priority: null, assignedTo: null });
      }

      const updatedTasks = await storage.getTasks();
      res.json(updatedTasks);
    } catch (error) {
      res.status(500).json({ message: "Failed to clear assignments" });
    }
  });

  // Schedule task to timeline (create assignment entry)
  app.put("/api/tasks/:id/schedule", async (req, res) => {
    try {
      const { id } = req.params;
      const tasks = await storage.getTasks();
      const task = tasks.find(t => t.id === id);

      console.log(`[Schedule] Task ${id} found:`, { name: task?.name, priority: task?.priority, assignedTo: task?.assignedTo });

      if (!task) {
        console.log(`[Schedule] Task ${id} not found`);
        res.status(404).json({ message: "Task not found" });
        return;
      }

      if (!task.priority) {
        console.log(`[Schedule] Task ${id} missing priority`, { priority: task.priority, assignedTo: task.assignedTo });
        res.status(400).json({ message: "Task must have priority before scheduling" });
        return;
      }

      // Auto-assign if not already assigned
      let assignedTo = task.assignedTo;
      if (!assignedTo) {
        console.log(`[Schedule] Auto-assigning task ${id}`);
        const personnel = await storage.getPersonnel();
        const tasks = await storage.getTasks();

        // Initialize workload counter
        const workloadMap = new Map<string, number>();
        personnel.forEach(person => {
          workloadMap.set(person.id, 0);
        });

        // Count current assignments
        tasks.forEach(t => {
          if (t.assignedTo && t.priority) {
            const currentCount = workloadMap.get(t.assignedTo) || 0;
            workloadMap.set(t.assignedTo, currentCount + 1);
          }
        });

        // Find person with least workload
        let minWorkload = Infinity;
        for (const [personId, workload] of Array.from(workloadMap.entries())) {
          if (workload < minWorkload) {
            minWorkload = workload;
            assignedTo = personId;
          }
        }

        if (assignedTo) {
          // Update task with assignment
          await storage.updateTask(id, { assignedTo });
          console.log(`[Schedule] Task ${id} assigned to ${assignedTo}`);
        } else {
          console.log(`[Schedule] No personnel available for assignment`);
          res.status(400).json({ message: "No personnel available for assignment" });
          return;
        }
      }

      // Create assignment entry for timeline visibility
      if (!assignedTo) {
        console.log(`[Schedule] Critical error: assignedTo is still null after assignment attempt`);
        res.status(500).json({ message: "Failed to assign task to personnel" });
        return;
      }

      await storage.createAssignment({
        taskId: task.id,
        personnelId: assignedTo,
        priority: task.priority,
        startTime: "10:00", // Default start time
        endTime: "16:30", // Default end time
      });

      res.json(task);
    } catch (error) {
      res.status(500).json({ message: "Failed to schedule task" });
    }
  });

  // Endpoint for running the optimizer script
  app.post("/api/run-optimizer", async (req, res) => {
    try {
      console.log("Eseguendo opt_updated.py...");
      const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        exec(
          "python3 /home/runner/workspace/client/public/scripts/opt_updated.py",
          (error, stdout, stderr) => {
            if (error) {
              reject(error);
              return;
            }
            resolve({ stdout, stderr });
          }
        );
      });

      console.log("opt_updated.py output:", result.stdout);
      if (result.stderr) {
        console.error("opt_updated.py stderr:", result.stderr);
      }

      res.json({
        success: true,
        message: "Optimizer eseguito con successo",
        output: result.stdout,
      });
    } catch (error: any) {
      console.error("Errore nell'esecuzione di opt_updated.py:", error);
      res.status(500).json({
        success: false,
        message: "Errore nell'esecuzione dell'optimizer",
        error: error.message,
      });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}