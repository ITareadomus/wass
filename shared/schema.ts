import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

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