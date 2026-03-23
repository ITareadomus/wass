import { sql } from "drizzle-orm";
import { pgTable, pgSchema, text, varchar, timestamp, integer, serial, boolean, date, jsonb, uuid, smallint, bigserial, primaryKey } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ==================== OPTIMIZER SCHEMA ====================
// Schema separato per le tabelle dell'algoritmo di ottimizzazione
export const optimizerSchema = pgSchema("optimizer");

// ==================== SELECTED_CLEANERS_REVISIONS ====================
// Traccia le modifiche alla selezione giornaliera dei cleaners
export const selectedCleanersRevisions = pgTable("selected_cleaners_revisions", {
  id: serial("id").primaryKey(),
  selectedCleanersId: integer("selected_cleaners_id").notNull(),
  workDate: date("work_date").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  cleanersBefore: integer("cleaners_before").array().notNull().default(sql`'{}'`),
  cleanersAfter: integer("cleaners_after").array().notNull().default(sql`'{}'`),
  actionType: varchar("action_type", { length: 30 }).notNull(), // 'REMOVE', 'ADD', 'SWAP', 'ROLLBACK'
  actionPayload: jsonb("action_payload"), // dettagli extra, es: {"removed": 123}
  performedBy: varchar("performed_by", { length: 100 }),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertSelectedCleanersRevisionSchema = createInsertSchema(selectedCleanersRevisions).omit({
  id: true,
  createdAt: true,
});

export type InsertSelectedCleanersRevision = z.infer<typeof insertSelectedCleanersRevisionSchema>;
export type SelectedCleanersRevision = typeof selectedCleanersRevisions.$inferSelect;

// ==================== LG_SELECTED_DRIVERS (logistics convocati) ====================
export const lgSelectedDrivers = pgTable("lg_selected_drivers", {
  id: serial("id").primaryKey(),
  workDate: date("work_date").notNull().unique(),
  drivers: integer("drivers").array().notNull().default(sql`'{}'`),
  vehicleAssignments: jsonb("vehicle_assignments").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const lgSelectedDriversRevisions = pgTable("lg_selected_drivers_revisions", {
  id: serial("id").primaryKey(),
  selectedDriversId: integer("selected_drivers_id").notNull(),
  workDate: date("work_date").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  driversBefore: integer("drivers_before").array().notNull().default(sql`'{}'`),
  driversAfter: integer("drivers_after").array().notNull().default(sql`'{}'`),
  vehicleAssignmentsBefore: jsonb("vehicle_assignments_before").notNull().default(sql`'{}'::jsonb`),
  vehicleAssignmentsAfter: jsonb("vehicle_assignments_after").notNull().default(sql`'{}'::jsonb`),
  actionType: varchar("action_type", { length: 30 }).notNull(),
  actionPayload: jsonb("action_payload"),
  performedBy: varchar("performed_by", { length: 100 }),
  createdAt: timestamp("created_at").defaultNow(),
});

// ==================== CLEANER_ALIASES ====================
// Tabella permanente per gli alias dei cleaners (indipendente dalla data)
export const cleanerAliases = pgTable("cleaner_aliases", {
  cleanerId: integer("cleaner_id").primaryKey(),
  alias: varchar("alias", { length: 100 }).notNull(),
  name: varchar("name", { length: 255 }),
  lastname: varchar("lastname", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertCleanerAliasSchema = createInsertSchema(cleanerAliases).omit({
  createdAt: true,
  updatedAt: true,
});

export type InsertCleanerAlias = z.infer<typeof insertCleanerAliasSchema>;
export type CleanerAlias = typeof cleanerAliases.$inferSelect;

// ==================== DAILY_TASK_LOCKS ====================
// Tabella per gestire il lock dei task nei containers (refresh-safe)
// Un task locked non può essere assegnato/spostato in timeline
export const dailyTaskLocks = pgTable("daily_task_locks", {
  workDate: date("work_date").notNull(),
  taskId: integer("task_id").notNull(),
  locked: boolean("locked").notNull().default(true),
  lockedReason: text("locked_reason"),
  lockedBy: text("locked_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.workDate, table.taskId] }),
}));

export const insertDailyTaskLockSchema = createInsertSchema(dailyTaskLocks).omit({
  updatedAt: true,
});

export type InsertDailyTaskLock = z.infer<typeof insertDailyTaskLockSchema>;
export type DailyTaskLock = typeof dailyTaskLocks.$inferSelect;

// ==================== USERS (replaces accounts.json) ====================
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  role: text("role").notNull().default("user"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const tasks = pgTable("tasks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  type: text("type").notNull(), // PREMIUM, STANDARD, PREMIUM - STRADE
  duration: text("duration").notNull(), // e.g. "6.30", "4.00"
  priority: text("priority"), // early-out, high, low, null for unassigned
  assignedTo: varchar("assigned_to"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const personnel = pgTable("personnel", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  type: text("type").notNull(), // PREMIUM - STRADE, STANDARD, PREMIUM
  color: text("color").notNull(), // hex color for avatar
  createdAt: timestamp("created_at").defaultNow(),
});

export const assignments = pgTable("assignments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  taskId: varchar("task_id").notNull(),
  personnelId: varchar("personnel_id").notNull(),
  priority: text("priority").notNull(), // early-out, high, low
  startTime: text("start_time"), // e.g. "10:00"
  endTime: text("end_time"), // e.g. "16:30"
  assignedAt: timestamp("assigned_at").defaultNow(),
});

export const insertTaskSchema = createInsertSchema(tasks).omit({
  id: true,
  createdAt: true,
});

export const insertPersonnelSchema = createInsertSchema(personnel).omit({
  id: true,
  createdAt: true,
});

export const insertAssignmentSchema = createInsertSchema(assignments).omit({
  id: true,
  assignedAt: true,
});

export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasks.$inferSelect;

export type InsertPersonnel = z.infer<typeof insertPersonnelSchema>;
export type Personnel = typeof personnel.$inferSelect;

export type InsertAssignment = z.infer<typeof insertAssignmentSchema>;
export type Assignment = typeof assignments.$inferSelect;

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
  straordinaria: z.boolean().optional(),
  confirmed_operation: z.boolean().optional(),
  checkout_date: z.string().optional(),
  checkout_time: z.string().optional().nullable(),
  checkin_date: z.string().optional(),
  checkin_time: z.string().optional().nullable(),
  pax_in: z.number().optional(),
  pax_out: z.number().optional(),
  operation_id: z.number().optional(),
  customer_name: z.string().optional(),
  customer_reference: z.string().optional(),
  type_apt: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  locked: z.boolean().optional(),
  locked_reason: z.string().optional(),
  locked_by: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type TaskType = z.infer<typeof taskSchema>;

export const InsertTaskSchema = taskSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Timeline Assignment Schema
export const timelineAssignmentSchema = z.object({
  taskId: z.string(),
  logisticCode: z.string(),
  cleanerId: z.number().int().nonnegative(),
  sequence: z.number().int().positive(),
  assignmentType: z.string().optional(),
  address: z.string().optional(),
  lat: z.union([z.string(), z.number()]).optional(),
  lng: z.union([z.string(), z.number()]).optional(),
  premium: z.boolean().optional(),
  straordinaria: z.boolean().optional(),
  cleaningTime: z.number().optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  travelTime: z.number().optional(),
  followup: z.boolean().optional(),
});

export const timelineFileSchema = z.object({
  current_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  scheduleVersion: z.number().int().nonnegative().default(1),
  assignments: z.array(timelineAssignmentSchema)
});

export type TimelineAssignment = z.infer<typeof timelineAssignmentSchema>;
export type TimelineFile = z.infer<typeof timelineFileSchema>;

// ==================== OPTIMIZER TABLES ====================
// Tabelle nello schema 'optimizer' per l'algoritmo decisionale

// Tabella: una riga = una run dell'algoritmo
export const optimizerRun = optimizerSchema.table("optimizer_run", {
  runId: uuid("run_id").primaryKey(),
  workDate: date("work_date").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  algorithmVersion: text("algorithm_version").notNull(),
  params: jsonb("params").notNull(),
  status: text("status").notNull(), // 'success', 'partial', 'failed'
  summary: jsonb("summary"),
});

export const insertOptimizerRunSchema = createInsertSchema(optimizerRun).omit({
  createdAt: true,
});
export type InsertOptimizerRun = z.infer<typeof insertOptimizerRunSchema>;
export type OptimizerRun = typeof optimizerRun.$inferSelect;

// Log decisioni / reasoning (append-only)
export const optimizerDecision = optimizerSchema.table("optimizer_decision", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  runId: uuid("run_id").notNull().references(() => optimizerRun.runId, { onDelete: "cascade" }),
  phase: smallint("phase").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertOptimizerDecisionSchema = createInsertSchema(optimizerDecision).omit({
  id: true,
  createdAt: true,
});
export type InsertOptimizerDecision = z.infer<typeof insertOptimizerDecisionSchema>;
export type OptimizerDecision = typeof optimizerDecision.$inferSelect;

// Assegnazioni finali prodotte dall'optimizer
export const optimizerAssignment = optimizerSchema.table("optimizer_assignment", {
  runId: uuid("run_id").notNull().references(() => optimizerRun.runId, { onDelete: "cascade" }),
  cleanerId: integer("cleaner_id").notNull(),
  taskId: integer("task_id").notNull(),
  sequence: smallint("sequence").notNull(),
  startTime: timestamp("start_time", { withTimezone: true }),
  endTime: timestamp("end_time", { withTimezone: true }),
  travelMinutesFromPrev: integer("travel_minutes_from_prev"),
  reasons: text("reasons").array(),
});

export const insertOptimizerAssignmentSchema = createInsertSchema(optimizerAssignment);
export type InsertOptimizerAssignment = z.infer<typeof insertOptimizerAssignmentSchema>;
export type OptimizerAssignment = typeof optimizerAssignment.$inferSelect;

// Task non assegnate + motivazione
export const optimizerUnassigned = optimizerSchema.table("optimizer_unassigned", {
  runId: uuid("run_id").notNull().references(() => optimizerRun.runId, { onDelete: "cascade" }),
  taskId: integer("task_id").notNull(),
  reasonCode: text("reason_code").notNull(),
  details: jsonb("details"),
});

export const insertOptimizerUnassignedSchema = createInsertSchema(optimizerUnassigned);
export type InsertOptimizerUnassigned = z.infer<typeof insertOptimizerUnassignedSchema>;
export type OptimizerUnassigned = typeof optimizerUnassigned.$inferSelect;

// ==================== TRAVEL TIME CACHE ====================
// Cache tecnica per i tempi di percorrenza stimati (non operativa)
export const optimizerTravelTimeCache = optimizerSchema.table("optimizer_travel_time_cache", {
  cacheKey: text("cache_key").primaryKey(),
  minutes: smallint("minutes").notNull(),
  source: text("source").notNull().default("estimated"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

export const insertOptimizerTravelTimeCacheSchema = createInsertSchema(optimizerTravelTimeCache).omit({
  updatedAt: true,
});
export type InsertOptimizerTravelTimeCache = z.infer<typeof insertOptimizerTravelTimeCacheSchema>;
export type OptimizerTravelTimeCache = typeof optimizerTravelTimeCache.$inferSelect;

// ==================== TASK COLLABORATORS ====================
// Tabella per gestire la collaborazione multi-cleaner su un singolo task
// Quando più cleaners collaborano, il cleaning_time viene diviso proporzionalmente
export const taskCollaborators = pgTable("task_collaborators", {
  workDate: date("work_date").notNull(),
  taskId: integer("task_id").notNull(),
  cleanerId: integer("cleaner_id").notNull(),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.workDate, table.taskId, table.cleanerId] }),
}));

export const insertTaskCollaboratorSchema = createInsertSchema(taskCollaborators).omit({
  createdAt: true,
});
export type InsertTaskCollaborator = z.infer<typeof insertTaskCollaboratorSchema>;
export type TaskCollaborator = typeof taskCollaborators.$inferSelect;