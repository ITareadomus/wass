
import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, boolean, json, serial, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Tabella per le operazioni attive
export const operations = pgTable("operations", {
  id: serial("id").primaryKey(),
  active: boolean("active").notNull().default(true),
  enableWass: boolean("enable_wass").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

// Tabella per i cleaners
export const cleaners = pgTable("cleaners", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  lastname: text("lastname").notNull(),
  role: text("role").notNull(), // Premium, Standard, Formatore
  active: boolean("active").notNull().default(true),
  ranking: integer("ranking").default(0),
  counterHours: integer("counter_hours").default(0),
  counterDays: integer("counter_days").default(0),
  available: boolean("available").notNull().default(true),
  contractType: text("contract_type"), // A, B, C, a chiamata
  preferredCustomers: json("preferred_customers").$type<number[]>().default([]),
  telegramId: text("telegram_id"),
  startTime: text("start_time"),
  premium: boolean("premium").default(false),
  homeLat: text("home_lat"),
  homeLng: text("home_lng"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Tabella per i tasks
export const tasks = pgTable("tasks", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull().unique(),
  logisticCode: text("logistic_code").notNull(),
  clientId: integer("client_id"),
  premium: boolean("premium").default(false),
  address: text("address"),
  lat: text("lat"),
  lng: text("lng"),
  cleaningTime: integer("cleaning_time"), // in minuti
  checkinDate: date("checkin_date"),
  checkoutDate: date("checkout_date"),
  checkinTime: text("checkin_time"),
  checkoutTime: text("checkout_time"),
  paxIn: integer("pax_in"),
  paxOut: integer("pax_out"),
  smallEquipment: boolean("small_equipment").default(false),
  operationId: integer("operation_id"),
  confirmedOperation: boolean("confirmed_operation").default(true),
  straordinaria: boolean("straordinaria").default(false),
  typeApt: text("type_apt"), // A, B, C, D, E, F, X
  alias: text("alias"),
  customerName: text("customer_name"),
  priority: text("priority"), // early-out, high, low
  status: text("status").default("pending"), // pending, assigned, completed
  workDate: date("work_date").notNull(), // data di lavoro
  reasons: json("reasons").$type<string[]>().default([]),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Tabella per le assegnazioni nella timeline
export const timelineAssignments = pgTable("timeline_assignments", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull(),
  logisticCode: text("logistic_code").notNull(),
  cleanerId: integer("cleaner_id").notNull(),
  assignmentType: text("assignment_type").notNull(), // early_out, high_priority, manual_drag
  sequence: integer("sequence").notNull().default(0),
  address: text("address"),
  lat: text("lat"),
  lng: text("lng"),
  premium: boolean("premium").default(false),
  cleaningTime: integer("cleaning_time"),
  startTime: text("start_time"),
  endTime: text("end_time"),
  travelTime: integer("travel_time").default(0),
  followup: boolean("followup").default(false),
  workDate: date("work_date").notNull(),
  checkinDate: date("checkin_date"),
  checkoutDate: date("checkout_date"),
  checkinTime: text("checkin_time"),
  checkoutTime: text("checkout_time"),
  paxIn: integer("pax_in"),
  paxOut: integer("pax_out"),
  operationId: integer("operation_id"),
  confirmedOperation: boolean("confirmed_operation"),
  straordinaria: boolean("straordinaria").default(false),
  typeApt: text("type_apt"),
  alias: text("alias"),
  customerName: text("customer_name"),
  smallEquipment: boolean("small_equipment").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Tabella per le assegnazioni confermate (assignments_ddmmyy.json)
export const confirmedAssignments = pgTable("confirmed_assignments", {
  id: serial("id").primaryKey(),
  workDate: date("work_date").notNull(),
  confirmedAt: timestamp("confirmed_at").notNull(),
  logisticCode: text("logistic_code").notNull(),
  cleanerId: integer("cleaner_id").notNull(),
  assignmentType: text("assignment_type").notNull(),
  sequence: integer("sequence").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// Schemi di validazione
export const insertCleanerSchema = createInsertSchema(cleaners).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertTaskSchema = createInsertSchema(tasks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertTimelineAssignmentSchema = createInsertSchema(timelineAssignments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertConfirmedAssignmentSchema = createInsertSchema(confirmedAssignments).omit({
  id: true,
  createdAt: true,
});

// Types
export type Cleaner = typeof cleaners.$inferSelect;
export type InsertCleaner = z.infer<typeof insertCleanerSchema>;

export type Task = typeof tasks.$inferSelect;
export type InsertTask = z.infer<typeof insertTaskSchema>;

export type TimelineAssignment = typeof timelineAssignments.$inferSelect;
export type InsertTimelineAssignment = z.infer<typeof insertTimelineAssignmentSchema>;

export type ConfirmedAssignment = typeof confirmedAssignments.$inferSelect;
export type InsertConfirmedAssignment = z.infer<typeof insertConfirmedAssignmentSchema>;

// Schema esistenti per compatibilità
export const personnel = pgTable("personnel", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  type: text("type").notNull(),
  color: text("color").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const assignments = pgTable("assignments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  taskId: varchar("task_id").notNull(),
  personnelId: varchar("personnel_id").notNull(),
  priority: text("priority").notNull(),
  startTime: text("start_time"),
  endTime: text("end_time"),
  assignedAt: timestamp("assigned_at").defaultNow(),
});

export const insertPersonnelSchema = createInsertSchema(personnel).omit({
  id: true,
  createdAt: true,
});

export const insertAssignmentSchema = createInsertSchema(assignments).omit({
  id: true,
  assignedAt: true,
});

export type InsertPersonnel = z.infer<typeof insertPersonnelSchema>;
export type Personnel = typeof personnel.$inferSelect;

export type InsertAssignment = z.infer<typeof insertAssignmentSchema>;
export type Assignment = typeof assignments.$inferSelect;

// Schema per il task type usato nel frontend
export const taskSchema = z.object({
  id: z.string(),
  name: z.string(),
  alias: z.string().optional(),
  type: z.string(),
  duration: z.string(),
  priority: z.enum(["early-out", "high", "low"]).nullable(),
  assignedTo: z.string().nullable(),
  status: z.enum(["pending", "assigned", "in-progress", "completed"]).default("pending"),
  scheduledTime: z.string().nullable(),
  address: z.string().optional(),
  lat: z.string().optional(),
  lng: z.string().optional(),
  premium: z.boolean().optional(),
  is_straordinaria: z.boolean().optional(),
  confirmed_operation: z.boolean().optional(),
  checkout_date: z.string().optional(),
  checkout_time: z.string().optional().nullable(),
  checkin_date: z.string().optional(),
  checkin_time: z.string().optional().nullable(),
  pax_in: z.number().optional(),
  pax_out: z.number().optional(),
  operation_id: z.number().optional(),
  customer_name: z.string().optional(),
  type_apt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type TaskType = z.infer<typeof taskSchema>;
