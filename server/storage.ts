
import { Task, Personnel, Assignment } from "@shared/schema";

// Sample tasks with varied durations
export let tasks: Task[] = [
  { id: "1", name: "TASK1", type: "PREMIUM", duration: "1.00", priority: null, assignedTo: null, createdAt: new Date() },
  { id: "2", name: "TASK2", type: "STANDARD", duration: "2.30", priority: null, assignedTo: null, createdAt: new Date() },
  { id: "3", name: "TASK3", type: "PREMIUM - STRADE", duration: "1.30", priority: null, assignedTo: null, createdAt: new Date() },
  { id: "4", name: "TASK4", type: "PREMIUM", duration: "3.00", priority: null, assignedTo: null, createdAt: new Date() },
  { id: "5", name: "TASK5", type: "STANDARD", duration: "0.30", priority: null, assignedTo: null, createdAt: new Date() },
  { id: "6", name: "TASK6", type: "PREMIUM", duration: "2.00", priority: null, assignedTo: null, createdAt: new Date() },
  { id: "7", name: "TASK7", type: "STANDARD", duration: "1.00", priority: null, assignedTo: null, createdAt: new Date() },
  { id: "8", name: "TASK8", type: "PREMIUM - STRADE", duration: "4.00", priority: null, assignedTo: null, createdAt: new Date() },
  { id: "9", name: "TASK9", type: "PREMIUM", duration: "2.30", priority: null, assignedTo: null, createdAt: new Date() },
  { id: "10", name: "TASK10", type: "STANDARD", duration: "1.30", priority: null, assignedTo: null, createdAt: new Date() },
  { id: "11", name: "TASK11", type: "PREMIUM", duration: "3.30", priority: null, assignedTo: null, createdAt: new Date() },
  { id: "12", name: "TASK12", type: "STANDARD", duration: "1.00", priority: null, assignedTo: null, createdAt: new Date() },
  { id: "13", name: "TASK13", type: "PREMIUM - STRADE", duration: "2.00", priority: null, assignedTo: null, createdAt: new Date() },
  { id: "14", name: "TASK14", type: "PREMIUM", duration: "0.30", priority: null, assignedTo: null, createdAt: new Date() },
  { id: "15", name: "TASK15", type: "STANDARD", duration: "5.00", priority: null, assignedTo: null, createdAt: new Date() },
];

export let personnel: Personnel[] = [
  { id: "1", name: "LOPEZ ERNESTO", type: "PREMIUM - STRADE", color: "#FF6B6B", createdAt: new Date() },
  { id: "2", name: "GARCIA MARIA", type: "STANDARD", color: "#4ECDC4", createdAt: new Date() },
  { id: "3", name: "ROSSI PAOLO", type: "PREMIUM", color: "#45B7D1", createdAt: new Date() },
];

export let assignments: Assignment[] = [];

export function getTasks(): Task[] {
  return tasks;
}

export function getPersonnel(): Personnel[] {
  return personnel;
}

export function getAssignments(): Assignment[] {
  return assignments;
}

export function updateTaskPriority(taskId: string, priority: string | null): Task | undefined {
  const task = tasks.find(t => t.id === taskId);
  if (task) {
    task.priority = priority;
  }
  return task;
}

export function updateTaskAssignment(taskId: string, personnelId: string | null): Task | undefined {
  const task = tasks.find(t => t.id === taskId);
  if (task) {
    task.assignedTo = personnelId;
  }
  return task;
}

export function clearAllAssignments(): Task[] {
  tasks = tasks.map(task => ({
    ...task,
    priority: null,
    assignedTo: null,
  }));
  assignments = [];
  return tasks;
}
