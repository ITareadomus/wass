CREATE TABLE "assignments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" varchar NOT NULL,
	"personnel_id" varchar NOT NULL,
	"priority" text NOT NULL,
	"start_time" text,
	"end_time" text,
	"assigned_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "cleaners" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"lastname" text NOT NULL,
	"role" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"ranking" integer DEFAULT 0,
	"counter_hours" integer DEFAULT 0,
	"counter_days" integer DEFAULT 0,
	"available" boolean DEFAULT true NOT NULL,
	"contract_type" text,
	"preferred_customers" json DEFAULT '[]'::json,
	"telegram_id" text,
	"start_time" text,
	"premium" boolean DEFAULT false,
	"home_lat" text,
	"home_lng" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "confirmed_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"work_date" date NOT NULL,
	"confirmed_at" timestamp NOT NULL,
	"logistic_code" text NOT NULL,
	"cleaner_id" integer NOT NULL,
	"assignment_type" text NOT NULL,
	"sequence" integer NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"id" serial PRIMARY KEY NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"enable_wass" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "personnel" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"color" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"logistic_code" text NOT NULL,
	"client_id" integer,
	"premium" boolean DEFAULT false,
	"address" text,
	"lat" text,
	"lng" text,
	"cleaning_time" integer,
	"checkin_date" date,
	"checkout_date" date,
	"checkin_time" text,
	"checkout_time" text,
	"pax_in" integer,
	"pax_out" integer,
	"small_equipment" boolean DEFAULT false,
	"operation_id" integer,
	"confirmed_operation" boolean DEFAULT true,
	"straordinaria" boolean DEFAULT false,
	"type_apt" text,
	"alias" text,
	"customer_name" text,
	"priority" text,
	"status" text DEFAULT 'pending',
	"work_date" date NOT NULL,
	"reasons" json DEFAULT '[]'::json,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "tasks_task_id_unique" UNIQUE("task_id")
);
--> statement-breakpoint
CREATE TABLE "timeline_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"logistic_code" text NOT NULL,
	"cleaner_id" integer NOT NULL,
	"assignment_type" text NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"address" text,
	"lat" text,
	"lng" text,
	"premium" boolean DEFAULT false,
	"cleaning_time" integer,
	"start_time" text,
	"end_time" text,
	"travel_time" integer DEFAULT 0,
	"followup" boolean DEFAULT false,
	"work_date" date NOT NULL,
	"checkin_date" date,
	"checkout_date" date,
	"checkin_time" text,
	"checkout_time" text,
	"pax_in" integer,
	"pax_out" integer,
	"operation_id" integer,
	"confirmed_operation" boolean,
	"straordinaria" boolean DEFAULT false,
	"type_apt" text,
	"alias" text,
	"customer_name" text,
	"small_equipment" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
