import { type Task, type InsertTask, type Personnel, type InsertPersonnel, type Assignment, type InsertAssignment } from "@shared/schema";
import { randomUUID } from "crypto";

export interface IStorage {
  // Tasks
  getTasks(): Promise<Task[]>;
  getTask(id: string): Promise<Task | undefined>;
  createTask(task: InsertTask): Promise<Task>;
  updateTask(id: string, task: Partial<Task>): Promise<Task | undefined>;
  deleteTask(id: string): Promise<boolean>;

  // Personnel
  getPersonnel(): Promise<Personnel[]>;
  getPersonnelById(id: string): Promise<Personnel | undefined>;
  createPersonnel(personnel: InsertPersonnel): Promise<Personnel>;
  updatePersonnel(id: string, personnel: Partial<Personnel>): Promise<Personnel | undefined>;
  deletePersonnel(id: string): Promise<boolean>;

  // Assignments
  getAssignments(): Promise<Assignment[]>;
  getAssignment(id: string): Promise<Assignment | undefined>;
  createAssignment(assignment: InsertAssignment): Promise<Assignment>;
  updateAssignment(id: string, assignment: Partial<Assignment>): Promise<Assignment | undefined>;
  deleteAssignment(id: string): Promise<boolean>;
  getAssignmentsByPersonnel(personnelId: string): Promise<Assignment[]>;
  getAssignmentsByTask(taskId: string): Promise<Assignment[]>;
}

export class MemStorage implements IStorage {
  private tasks: Map<string, Task>;
  private personnel: Map<string, Personnel>;
  private assignments: Map<string, Assignment>;

  constructor() {
    this.tasks = new Map();
    this.personnel = new Map();
    this.assignments = new Map();

    // Initialize with sample data
    this.initializeSampleData();
  }

  private async initializeSampleData() {
    // Sample personnel
    const samplePersonnel = [
      { name: "LOPEZ ERNESTO", type: "PREMIUM - STRADE", color: "#8b5cf6" },
      { name: "SOLY LAMIN", type: "STANDARD", color: "#3b82f6" },
      { name: "BAJU MUSTAPHA", type: "PREMIUM", color: "#ef4444" },
      { name: "OKE TRACY", type: "PREMIUM", color: "#16a34a" },
      { name: "DA EL HADJI", type: "PREMIUM - STRADE", color: "#f97316" },
      { name: "DI SINGA RACHE", type: "STANDARD", color: "#84cc16" },
      { name: "SHIOUDEM HEMI", type: "STANDARD", color: "#06b6d4" },
      { name: "EONE LASSINE", type: "PREMIUM - STRADE", color: "#6366f1" },
    ];

    for (const person of samplePersonnel) {
      await this.createPersonnel(person);
    }

    // Sample tasks (some unassigned)
    const sampleTasks: Task[] = [
      // Early Out Tasks (15 tasks)
      {
        id: "1",
        name: "A.D.G",
        type: "1536",
        duration: "8.15",
        priority: "early-out",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "eo2",
        name: "MARCO ROSSI",
        type: "PREMIUM",
        duration: "7.30",
        priority: "early-out",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "eo3",
        name: "GIULIA BIANCHI",
        type: "STANDARD",
        duration: "6.45",
        priority: "early-out",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "eo4",
        name: "FRANCESCO VERDE",
        type: "PREMIUM - STRADE",
        duration: "8.00",
        priority: "early-out",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "eo5",
        name: "SARA NERI",
        type: "1536",
        duration: "7.15",
        priority: "early-out",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "eo6",
        name: "DAVIDE COSTA",
        type: "PREMIUM",
        duration: "6.30",
        priority: "early-out",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "eo7",
        name: "ELENA FERRARI",
        type: "STANDARD",
        duration: "7.45",
        priority: "early-out",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "eo8",
        name: "LUCA MARINI",
        type: "PREMIUM - STRADE",
        duration: "8.30",
        priority: "early-out",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "eo9",
        name: "CHIARA RICCI",
        type: "1536",
        duration: "6.00",
        priority: "early-out",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "eo10",
        name: "MATTEO GALLI",
        type: "PREMIUM",
        duration: "7.00",
        priority: "early-out",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "eo11",
        name: "VALENTINA CONTI",
        type: "STANDARD",
        duration: "6.15",
        priority: "early-out",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "eo12",
        name: "ANDREA MORO",
        type: "PREMIUM - STRADE",
        duration: "8.45",
        priority: "early-out",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "eo13",
        name: "FEDERICA LEONE",
        type: "1536",
        duration: "7.30",
        priority: "early-out",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "eo14",
        name: "SIMONE ROMANO",
        type: "PREMIUM",
        duration: "6.45",
        priority: "early-out",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "eo15",
        name: "LAURA FONTANA",
        type: "STANDARD",
        duration: "7.15",
        priority: "early-out",
        assignedTo: null,
        createdAt: new Date(),
      },

      // High Priority Tasks (20 tasks)
      {
        id: "2", 
        name: "ANDRESSA",
        type: "PREMIUM",
        duration: "4.15",
        priority: "high",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "hp2",
        name: "ROBERTO SILVA",
        type: "STANDARD",
        duration: "5.30",
        priority: "high",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "hp3",
        name: "PAOLA GRECO",
        type: "PREMIUM - STRADE",
        duration: "4.45",
        priority: "high",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "hp4",
        name: "GIOVANNI VILLA",
        type: "1536",
        duration: "5.00",
        priority: "high",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "hp5",
        name: "MONICA SANNA",
        type: "PREMIUM",
        duration: "4.30",
        priority: "high",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "hp6",
        name: "ALESSANDRO PIRAS",
        type: "STANDARD",
        duration: "5.15",
        priority: "high",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "hp7",
        name: "CRISTINA TESTA",
        type: "PREMIUM - STRADE",
        duration: "4.00",
        priority: "high",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "hp8",
        name: "FABIO MARTINI",
        type: "1536",
        duration: "5.45",
        priority: "high",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "hp9",
        name: "SILVIA MONTI",
        type: "PREMIUM",
        duration: "4.15",
        priority: "high",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "hp10",
        name: "DIEGO CARUSO",
        type: "STANDARD",
        duration: "5.30",
        priority: "high",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "hp11",
        name: "ANNA VITALI",
        type: "PREMIUM - STRADE",
        duration: "4.45",
        priority: "high",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "hp12",
        name: "MICHELE BRUNO",
        type: "1536",
        duration: "5.00",
        priority: "high",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "hp13",
        name: "TERESA AMATO",
        type: "PREMIUM",
        duration: "4.30",
        priority: "high",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "hp14",
        name: "NICOLA PELLEGRINI",
        type: "STANDARD",
        duration: "5.15",
        priority: "high",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "hp15",
        name: "CARMEN LOMBARDI",
        type: "PREMIUM - STRADE",
        duration: "4.00",
        priority: "high",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "hp16",
        name: "ENRICO GATTI",
        type: "1536",
        duration: "5.45",
        priority: "high",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "hp17",
        name: "PATRIZIA LONGO",
        type: "PREMIUM",
        duration: "4.15",
        priority: "high",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "hp18",
        name: "STEFANO GIORGI",
        type: "STANDARD",
        duration: "5.30",
        priority: "high",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "hp19",
        name: "MANUELA FIORE",
        type: "PREMIUM - STRADE",
        duration: "4.45",
        priority: "high",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "hp20",
        name: "ANTONIO MORETTI",
        type: "1536",
        duration: "5.00",
        priority: "high",
        assignedTo: null,
        createdAt: new Date(),
      },

      // Low Priority Tasks (10 tasks)
      {
        id: "3",
        name: "ANTONIO",
        type: "STANDARD",
        duration: "6.30",
        priority: "low",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "lp2",
        name: "FRANCESCA RIVA",
        type: "PREMIUM",
        duration: "3.30",
        priority: "low",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "lp3",
        name: "MASSIMO BARBIERI",
        type: "STANDARD",
        duration: "3.45",
        priority: "low",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "lp4",
        name: "DANIELA MARCHETTI",
        type: "PREMIUM - STRADE",
        duration: "3.15",
        priority: "low",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "lp5",
        name: "CLAUDIO PAGANO",
        type: "1536",
        duration: "4.00",
        priority: "low",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "lp6",
        name: "ROSSANA CATTANEO",
        type: "PREMIUM",
        duration: "3.30",
        priority: "low",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "lp7",
        name: "MAURIZIO FERRETTI",
        type: "STANDARD",
        duration: "3.45",
        priority: "low",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "lp8",
        name: "GIOVANNA GUERRA",
        type: "PREMIUM - STRADE",
        duration: "3.15",
        priority: "low",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "lp9",
        name: "CARLO MARINO",
        type: "1536",
        duration: "4.00",
        priority: "low",
        assignedTo: null,
        createdAt: new Date(),
      },
      {
        id: "lp10",
        name: "LUCIA BENEDETTI",
        type: "PREMIUM",
        duration: "3.30",
        priority: "low",
        assignedTo: null,
        createdAt: new Date(),
      },

      // Unassigned Tasks
      {
        id: "4",
        name: "BARBARA",
        type: "PREMIUM - STRADE",
        duration: "5.45",
        priority: null,
        assignedTo: null,
        createdAt: new Date(),
      },
    ];

    for (const task of sampleTasks) {
      await this.createTask(task);
    }
  }

  // Task methods
  async getTasks(): Promise<Task[]> {
    return Array.from(this.tasks.values());
  }

  async getTask(id: string): Promise<Task | undefined> {
    return this.tasks.get(id);
  }

  async createTask(insertTask: InsertTask): Promise<Task> {
    const id = randomUUID();
    const task: Task = {
      ...insertTask,
      id,
      createdAt: new Date(),
      priority: insertTask.priority ?? null,
      assignedTo: insertTask.assignedTo ?? null,
    };
    this.tasks.set(id, task);
    return task;
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<Task | undefined> {
    const task = this.tasks.get(id);
    if (!task) return undefined;

    const updatedTask = { ...task, ...updates };
    this.tasks.set(id, updatedTask);
    return updatedTask;
  }

  async deleteTask(id: string): Promise<boolean> {
    return this.tasks.delete(id);
  }

  // Personnel methods
  async getPersonnel(): Promise<Personnel[]> {
    return Array.from(this.personnel.values());
  }

  async getPersonnelById(id: string): Promise<Personnel | undefined> {
    return this.personnel.get(id);
  }

  async createPersonnel(insertPersonnel: InsertPersonnel): Promise<Personnel> {
    const id = randomUUID();
    const person: Personnel = { ...insertPersonnel, id, createdAt: new Date() };
    this.personnel.set(id, person);
    return person;
  }

  async updatePersonnel(id: string, updates: Partial<Personnel>): Promise<Personnel | undefined> {
    const person = this.personnel.get(id);
    if (!person) return undefined;

    const updatedPerson = { ...person, ...updates };
    this.personnel.set(id, updatedPerson);
    return updatedPerson;
  }

  async deletePersonnel(id: string): Promise<boolean> {
    return this.personnel.delete(id);
  }

  // Assignment methods
  async getAssignments(): Promise<Assignment[]> {
    return Array.from(this.assignments.values());
  }

  async getAssignment(id: string): Promise<Assignment | undefined> {
    return this.assignments.get(id);
  }

  async createAssignment(insertAssignment: InsertAssignment): Promise<Assignment> {
    const id = randomUUID();
    const assignment: Assignment = {
      ...insertAssignment,
      id,
      assignedAt: new Date(),
      startTime: insertAssignment.startTime ?? null,
      endTime: insertAssignment.endTime ?? null,
    };
    this.assignments.set(id, assignment);
    return assignment;
  }

  async updateAssignment(id: string, updates: Partial<Assignment>): Promise<Assignment | undefined> {
    const assignment = this.assignments.get(id);
    if (!assignment) return undefined;

    const updatedAssignment = { ...assignment, ...updates };
    this.assignments.set(id, updatedAssignment);
    return updatedAssignment;
  }

  async deleteAssignment(id: string): Promise<boolean> {
    return this.assignments.delete(id);
  }

  async getAssignmentsByPersonnel(personnelId: string): Promise<Assignment[]> {
    return Array.from(this.assignments.values()).filter(
      assignment => assignment.personnelId === personnelId
    );
  }

  async getAssignmentsByTask(taskId: string): Promise<Assignment[]> {
    return Array.from(this.assignments.values()).filter(
      assignment => assignment.taskId === taskId
    );
  }
}

export const storage = new MemStorage();