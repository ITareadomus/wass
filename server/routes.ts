import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertTaskSchema, insertPersonnelSchema, insertAssignmentSchema } from "@shared/schema";
import { z } from "zod";

export async function registerRoutes(app: Express): Promise<Server> {
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

  const httpServer = createServer(app);
  return httpServer;
}
