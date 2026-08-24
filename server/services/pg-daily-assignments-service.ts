import pool, { query } from '../../shared/pg-db';
import { taskCollaborationService } from './pg-task-collaboration-service';
import { formatInTimeZone } from 'date-fns-tz';
import { databaseConfig } from '../../config/database';

const ROME_TZ = 'Europe/Rome';

/**
 * Normalize any date-ish value to `YYYY-MM-DD` without UTC day-shifts.
 *
 * Why: Postgres `DATE` casting from timestamp/ISO strings depends on session timezone.
 * If we send `Date`/ISO with time, local (often UTC) can shift the day (e.g. Rome midnight -> previous UTC day).
 * We ALWAYS store date-only strings for checkin/checkout.
 */
function normalizeDateToYmd(value: any): string | null {
  if (value == null) return null;

  // Date instance
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return formatInTimeZone(value, ROME_TZ, 'yyyy-MM-dd');
  }

  // Timestamp number
  if (typeof value === 'number') {
    const d = new Date(value);
    if (isNaN(d.getTime())) return null;
    return formatInTimeZone(d, ROME_TZ, 'yyyy-MM-dd');
  }

  // String forms
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;

    // Already YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

    // ISO-ish: take date part without timezone conversion
    if (s.includes('T')) {
      const part = s.split('T')[0];
      if (/^\d{4}-\d{2}-\d{2}$/.test(part)) return part;
    }

    // Italian format DD/MM/YYYY
    const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;

    // Fallback parse, but then format in Rome TZ to avoid UTC shifts
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      return formatInTimeZone(d, ROME_TZ, 'yyyy-MM-dd');
    }

    return null;
  }

  return null;
}

function normalizeCustomerNoteHistory(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function toCustomerNoteHistoryJson(value: unknown): string {
  return JSON.stringify(normalizeCustomerNoteHistory(value));
}

export interface PgDailyAssignmentRow {
  id?: number;
  work_date: string;
  cleaner_id: number;
  cleaner_name?: string | null;
  cleaner_lastname?: string | null;
  cleaner_role?: string | null;
  cleaner_premium?: boolean | null;
  cleaner_start_time?: string | null;
  cleaner_end_time?: string | null;
  task_id: number;
  logistic_code: number;
  client_id?: number | null;
  premium: boolean;
  address: string;
  lat?: number | null;
  lng?: number | null;
  cleaning_time: number;
  base_cleaning_time?: number | null;
  checkin_date?: string | null;
  checkout_date?: string | null;
  checkin_time?: string | null;
  checkout_time?: string | null;
  pax_in?: number | null;
  pax_out?: number | null;
  small_equipment?: boolean | null;
  operation_id?: number | null;
  confirmed_operation?: boolean | null;
  straordinaria?: boolean | null;
  type_apt?: string | null;
  alias?: string | null;
  customer_name?: string | null;
  customer_reference?: string | number | null;
  customer_note?: string | null;
  customer_note_history?: any[] | null;
  reasons: string[];
  priority?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  followup?: boolean | null;
  sequence: number;
  travel_time: number;
  manually_moved?: boolean;
  created_at?: Date;
  updated_at?: Date;
}

/** Flat row for daily_logistics_assignments_* (mirror of PgDailyAssignmentRow, driver_*) */
export interface PgLogisticsAssignmentRow {
  work_date: string;
  driver_id: number;
  driver_name?: string | null;
  driver_lastname?: string | null;
  driver_role?: string | null;
  driver_premium?: boolean | null;
  driver_start_time?: string | null;
  driver_end_time?: string | null;
  task_id: number;
  logistic_code: number;
  client_id?: number | null;
  premium: boolean;
  address: string;
  lat?: number | null;
  lng?: number | null;
  cleaning_time: number;
  base_cleaning_time?: number | null;
  checkin_date?: string | null;
  checkout_date?: string | null;
  checkin_time?: string | null;
  checkout_time?: string | null;
  pax_in?: number | null;
  pax_out?: number | null;
  small_equipment?: boolean | null;
  operation_id?: number | null;
  confirmed_operation?: boolean | null;
  straordinaria?: boolean | null;
  type_apt?: string | null;
  alias?: string | null;
  customer_name?: string | null;
  customer_reference?: string | number | null;
  customer_note?: string | null;
  customer_note_history?: any[] | null;
  reasons: string[];
  priority?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  followup?: boolean | null;
  sequence: number;
  travel_time: number;
  checkout_wait_minutes?: number;
  manually_moved?: boolean;
  is_finished?: boolean;
  logistics_task_kind?: string | null;
  logistics_task_kind_source?: string | null;
}

export class PgDailyAssignmentsService {
  private normalizeScope(scope?: string | null): 'housekeeping' | 'office' {
    return String(scope || '').toLowerCase() === 'office' ? 'office' : 'housekeeping';
  }

  private getDuplicateGroupId(logisticCode: unknown): string | null {
    if (logisticCode == null) return null;
    const rawCode = String(logisticCode).trim();
    if (!rawCode) return null;
    const numericCode = Number(rawCode);
    if (Number.isFinite(numericCode)) {
      return String(numericCode);
    }
    return rawCode;
  }

  private annotateActiveDuplicateMetadata(tasksByPriority: { [key: string]: any[] }): void {
    const allTasks = [
      ...(tasksByPriority.early_out || []),
      ...(tasksByPriority.high_priority || []),
      ...(tasksByPriority.low_priority || []),
    ];
    const activeGroupCounts = new Map<string, number>();

    for (const task of allTasks) {
      const duplicateGroupId = this.getDuplicateGroupId(task?.logistic_code);
      if (!duplicateGroupId) continue;
      if (task?.locked) continue;
      activeGroupCounts.set(duplicateGroupId, (activeGroupCounts.get(duplicateGroupId) || 0) + 1);
    }

    for (const task of allTasks) {
      const duplicateGroupId = this.getDuplicateGroupId(task?.logistic_code);
      const duplicateGroupSizeActive = duplicateGroupId
        ? (activeGroupCounts.get(duplicateGroupId) || 0)
        : 0;
      task.duplicate_group_id = duplicateGroupId ?? undefined;
      task.duplicate_group_size_active = duplicateGroupSizeActive;
      task.is_duplicate_active = !task?.locked && duplicateGroupSizeActive > 1;
    }
  }

  /** Locked tasks stay at the end of each priority bucket; relative order within each group is preserved. */
  private sortContainerBucketsLockedLast(tasksByPriority: {
    early_out?: any[];
    high_priority?: any[];
    low_priority?: any[];
  }): void {
    for (const key of ['early_out', 'high_priority', 'low_priority'] as const) {
      const tasks = tasksByPriority[key];
      if (!tasks?.length) continue;
      const unlocked: any[] = [];
      const locked: any[] = [];
      for (const task of tasks) {
        if (task?.locked === true) locked.push(task);
        else unlocked.push(task);
      }
      tasksByPriority[key] = [...unlocked, ...locked];
    }
  }

  /**
   * Ensure aliases and selected_cleaners_revisions tables exist
   */
  async ensureCleanerAliasesAndRevisionsTables(): Promise<void> {
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS aliases (
          cleaner_id INTEGER PRIMARY KEY,
          alias VARCHAR(100) NOT NULL,
          name VARCHAR(255),
          lastname VARCHAR(255),
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS selected_cleaners_revisions (
          id SERIAL PRIMARY KEY,
          selected_cleaners_id INTEGER NOT NULL,
          work_date DATE NOT NULL,
          scope VARCHAR(32) NOT NULL DEFAULT 'housekeeping',
          revision_number INTEGER NOT NULL,
          cleaners_before INTEGER[] NOT NULL DEFAULT '{}',
          cleaners_after INTEGER[] NOT NULL DEFAULT '{}',
          action_type VARCHAR(30) NOT NULL,
          action_payload JSONB,
          performed_by VARCHAR(100),
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE (selected_cleaners_id, revision_number)
        )
      `);
      await query(`
        CREATE INDEX IF NOT EXISTS idx_sel_cleaners_revisions_date
        ON selected_cleaners_revisions(work_date)
      `);
      await query(`DROP TABLE IF EXISTS cleaners_history CASCADE`);
      console.log('✅ PG: Tabelle aliases e selected_cleaners_revisions verificate');
    } catch (error) {
      console.warn('⚠️ PG: Errore (ignorabile) nella migrazione:', error);
    }
  }

  /**
   * Ensure locked columns exist on daily_containers and daily_containers_history tables
   */
  async ensureLockedColumns(): Promise<void> {
    try {
      // Add locked and locked_reason columns to daily_containers
      await query(`ALTER TABLE daily_containers ADD COLUMN IF NOT EXISTS locked BOOLEAN DEFAULT FALSE`);
      await query(`ALTER TABLE daily_containers ADD COLUMN IF NOT EXISTS locked_reason TEXT DEFAULT NULL`);
      
      // Add locked and locked_reason columns to daily_containers_history
      await query(`ALTER TABLE daily_containers_history ADD COLUMN IF NOT EXISTS locked BOOLEAN DEFAULT FALSE`);
      await query(`ALTER TABLE daily_containers_history ADD COLUMN IF NOT EXISTS locked_reason TEXT DEFAULT NULL`);
      
      console.log('✅ PG: Colonne locked e locked_reason aggiunte a daily_containers e daily_containers_history');
    } catch (error) {
      console.warn('⚠️ PG: Errore (ignorabile) nella migrazione locked columns:', error);
    }
  }

  /**
   * Ensure customer note columns exist on all task tables (current + history)
   */
  async ensureCustomerNoteColumns(): Promise<void> {
    try {
      await query(`ALTER TABLE IF EXISTS daily_containers ADD COLUMN IF NOT EXISTS customer_note TEXT`);
      await query(`ALTER TABLE IF EXISTS daily_containers_history ADD COLUMN IF NOT EXISTS customer_note TEXT`);
      await query(`ALTER TABLE IF EXISTS daily_assignments_current ADD COLUMN IF NOT EXISTS customer_note TEXT`);
      await query(`ALTER TABLE IF EXISTS daily_assignments_history ADD COLUMN IF NOT EXISTS customer_note TEXT`);
      await query(`ALTER TABLE IF EXISTS lg_containers ADD COLUMN IF NOT EXISTS customer_note TEXT`);
      await query(`ALTER TABLE IF EXISTS lg_containers_history ADD COLUMN IF NOT EXISTS customer_note TEXT`);
      await query(`ALTER TABLE IF EXISTS lg_timeline ADD COLUMN IF NOT EXISTS customer_note TEXT`);
      await query(`ALTER TABLE IF EXISTS lg_timeline_history ADD COLUMN IF NOT EXISTS customer_note TEXT`);
      await query(`ALTER TABLE IF EXISTS daily_containers ADD COLUMN IF NOT EXISTS customer_note_history JSONB NOT NULL DEFAULT '[]'::jsonb`);
      await query(`ALTER TABLE IF EXISTS daily_containers_history ADD COLUMN IF NOT EXISTS customer_note_history JSONB NOT NULL DEFAULT '[]'::jsonb`);
      await query(`ALTER TABLE IF EXISTS daily_assignments_current ADD COLUMN IF NOT EXISTS customer_note_history JSONB NOT NULL DEFAULT '[]'::jsonb`);
      await query(`ALTER TABLE IF EXISTS daily_assignments_history ADD COLUMN IF NOT EXISTS customer_note_history JSONB NOT NULL DEFAULT '[]'::jsonb`);
      await query(`ALTER TABLE IF EXISTS lg_containers ADD COLUMN IF NOT EXISTS customer_note_history JSONB NOT NULL DEFAULT '[]'::jsonb`);
      await query(`ALTER TABLE IF EXISTS lg_containers_history ADD COLUMN IF NOT EXISTS customer_note_history JSONB NOT NULL DEFAULT '[]'::jsonb`);
      await query(`ALTER TABLE IF EXISTS lg_timeline ADD COLUMN IF NOT EXISTS customer_note_history JSONB NOT NULL DEFAULT '[]'::jsonb`);
      await query(`ALTER TABLE IF EXISTS lg_timeline_history ADD COLUMN IF NOT EXISTS customer_note_history JSONB NOT NULL DEFAULT '[]'::jsonb`);
      console.log('✅ PG: Colonna customer_note verificata su current/history HK+LG');
    } catch (error) {
      console.warn('⚠️ PG: ensureCustomerNoteColumns:', error);
    }
  }

  /**
   * Ensure daily_task_locks table exists (source of truth for task locking)
   * This table persists lock state across refreshes - locked tasks cannot be assigned to timeline
   */
  async ensureTaskLocksTable(): Promise<void> {
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS daily_task_locks (
          work_date DATE NOT NULL,
          task_id INTEGER NOT NULL,
          locked BOOLEAN NOT NULL DEFAULT TRUE,
          locked_reason TEXT,
          locked_by TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (work_date, task_id)
        )
      `);
      await query(`
        CREATE INDEX IF NOT EXISTS idx_daily_task_locks_date 
        ON daily_task_locks(work_date)
      `);
      console.log('✅ PG: Tabella daily_task_locks verificata');
    } catch (error) {
      console.warn('⚠️ PG: Errore (ignorabile) nella creazione daily_task_locks:', error);
    }
  }

  async ensureOperationalDayTable(): Promise<void> {
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS daily_operational_day (
          work_date DATE NOT NULL,
          scope VARCHAR(32) NOT NULL DEFAULT 'housekeeping',
          started BOOLEAN NOT NULL DEFAULT FALSE,
          started_at TIMESTAMPTZ,
          started_by TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (work_date, scope)
        )
      `);
      console.log('✅ PG: Tabella daily_operational_day verificata');
    } catch (error) {
      console.warn('⚠️ PG: Errore (ignorabile) nella creazione daily_operational_day:', error);
    }
  }

  async isOperationalDayStarted(
    workDate: string,
    scope: string = 'housekeeping'
  ): Promise<boolean> {
    const day = await this.getOperationalDay(workDate, scope);
    return day.started;
  }

  async getOperationalDay(
    workDate: string,
    scope: string = 'housekeeping'
  ): Promise<{
    started: boolean;
    startedAt: string | null;
    startedBy: string | null;
  }> {
    await this.ensureOperationalDayTable();
    const date = normalizeDateToYmd(workDate);
    const resolvedScope = scope === 'office' ? 'office' : 'housekeeping';
    if (!date) {
      return { started: false, startedAt: null, startedBy: null };
    }
    const result = await query(
      `SELECT started, started_at, started_by
       FROM daily_operational_day
       WHERE work_date = $1 AND scope = $2`,
      [date, resolvedScope]
    );
    const row = result.rows[0];
    const started = row?.started === true;
    const todayRome = formatInTimeZone(new Date(), ROME_TZ, 'yyyy-MM-dd');
    if (started && date < todayRome) {
      await query(
        `UPDATE daily_operational_day
         SET started = FALSE, started_at = NULL, started_by = NULL, updated_at = NOW()
         WHERE work_date = $1 AND scope = $2 AND started = TRUE`,
        [date, resolvedScope]
      );
      return { started: false, startedAt: null, startedBy: null };
    }
    return {
      started,
      startedAt: row?.started_at ? String(row.started_at) : null,
      startedBy: row?.started_by != null ? String(row.started_by) : null,
    };
  }

  async setOperationalDayStarted(
    workDate: string,
    scope: string,
    started: boolean,
    username: string = 'unknown'
  ): Promise<{
    started: boolean;
    startedAt: string | null;
    startedBy: string | null;
  }> {
    await this.ensureOperationalDayTable();
    const date = normalizeDateToYmd(workDate);
    if (!date) {
      throw new Error('work_date non valida');
    }
    const resolvedScope = scope === 'office' ? 'office' : 'housekeeping';
    await query(
      `INSERT INTO daily_operational_day (work_date, scope, started, started_at, started_by, updated_at)
       VALUES ($1, $2, $3, CASE WHEN $3 THEN NOW() ELSE NULL END, CASE WHEN $3 THEN $4 ELSE NULL END, NOW())
       ON CONFLICT (work_date, scope) DO UPDATE SET
         started = EXCLUDED.started,
         started_at = CASE
           WHEN EXCLUDED.started THEN COALESCE(daily_operational_day.started_at, NOW())
           ELSE NULL
         END,
         started_by = CASE
           WHEN EXCLUDED.started THEN COALESCE(daily_operational_day.started_by, EXCLUDED.started_by)
           ELSE NULL
         END,
         updated_at = NOW()`,
      [date, resolvedScope, started, username]
    );
    return this.getOperationalDay(date, resolvedScope);
  }

  /**
   * Dopo l'aggiunta di `scope` su daily_assignments_revisions, il vecchio UNIQUE(work_date, revision)
   * fa collidere housekeeping e office (stesso revision per stessa data).
   * Rimuove quel vincolo e crea UNIQUE(work_date, revision, scope).
   */
  async ensureDailyAssignmentsRevisionsScopeUnique(): Promise<void> {
    try {
      const col = await query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'daily_assignments_revisions'
          AND column_name = 'scope'
      `);
      if (!col.rows.length) {
        return;
      }

      await query(`
        UPDATE daily_assignments_revisions
        SET scope = 'housekeeping'
        WHERE scope IS NULL
      `);

      await query(`
        DO $$
        DECLARE r RECORD;
        BEGIN
          FOR r IN
            SELECT c.conname
            FROM pg_constraint c
            JOIN pg_class t ON c.conrelid = t.oid
            JOIN pg_namespace n ON t.relnamespace = n.oid
            WHERE n.nspname = 'public'
              AND t.relname = 'daily_assignments_revisions'
              AND c.contype = 'u'
              AND pg_get_constraintdef(c.oid) NOT LIKE '%scope%'
          LOOP
            EXECUTE format('ALTER TABLE daily_assignments_revisions DROP CONSTRAINT %I', r.conname);
          END LOOP;
        END $$
      `);

      await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS daily_assignments_revisions_work_date_revision_scope_uidx
        ON daily_assignments_revisions (work_date, revision, (COALESCE(scope, 'housekeeping'::text)))
      `);
      console.log('✅ PG: daily_assignments_revisions UNIQUE allineato a (work_date, revision, scope)');
    } catch (error) {
      console.warn('⚠️ PG: ensureDailyAssignmentsRevisionsScopeUnique:', error);
    }
  }

  /**
   * Dopo lo split per scope, il vecchio UNIQUE(work_date, task_id) su daily_containers
   * genera collisioni tra housekeeping e office sulla stessa task/data.
   * Migra verso univocita per scope.
   */
  async ensureDailyContainersScopeUnique(): Promise<void> {
    try {
      const col = await query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'daily_containers'
          AND column_name = 'scope'
      `);
      if (!col.rows.length) {
        return;
      }

      await query(`
        UPDATE daily_containers
        SET scope = 'housekeeping'
        WHERE scope IS NULL
      `);

      await query(`
        DO $$
        DECLARE r RECORD;
        BEGIN
          FOR r IN
            SELECT c.conname
            FROM pg_constraint c
            JOIN pg_class t ON c.conrelid = t.oid
            JOIN pg_namespace n ON t.relnamespace = n.oid
            WHERE n.nspname = 'public'
              AND t.relname = 'daily_containers'
              AND c.contype = 'u'
              AND pg_get_constraintdef(c.oid) NOT LIKE '%scope%'
          LOOP
            EXECUTE format('ALTER TABLE daily_containers DROP CONSTRAINT %I', r.conname);
          END LOOP;
        END $$
      `);

      await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS daily_containers_work_date_task_scope_uidx
        ON daily_containers (work_date, task_id, (COALESCE(scope, 'housekeeping'::text)))
      `);
      console.log('✅ PG: daily_containers UNIQUE allineato a (work_date, task_id, scope)');
    } catch (error) {
      console.warn('⚠️ PG: ensureDailyContainersScopeUnique:', error);
    }
  }

  /**
   * Scope migration for selected cleaners tables:
   * - daily_selected_cleaners: unique per (work_date, scope)
   * - selected_cleaners_revisions: scope column + indexes
   */
  async ensureSelectedCleanersScopeStructure(): Promise<void> {
    try {
      await query(`ALTER TABLE daily_selected_cleaners ADD COLUMN IF NOT EXISTS scope VARCHAR(32)`);
      await query(`UPDATE daily_selected_cleaners SET scope = 'housekeeping' WHERE scope IS NULL`);
      await query(`ALTER TABLE daily_selected_cleaners ALTER COLUMN scope SET NOT NULL`);
      await query(`ALTER TABLE daily_selected_cleaners ALTER COLUMN scope SET DEFAULT 'housekeeping'`);

      await query(`
        DO $$
        DECLARE r RECORD;
        BEGIN
          FOR r IN
            SELECT c.conname
            FROM pg_constraint c
            JOIN pg_class t ON c.conrelid = t.oid
            JOIN pg_namespace n ON t.relnamespace = n.oid
            WHERE n.nspname = 'public'
              AND t.relname = 'daily_selected_cleaners'
              AND c.contype = 'u'
              AND pg_get_constraintdef(c.oid) NOT LIKE '%scope%'
          LOOP
            EXECUTE format('ALTER TABLE daily_selected_cleaners DROP CONSTRAINT %I', r.conname);
          END LOOP;
        END $$;
      `);

      await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS daily_selected_cleaners_work_date_scope_uidx
        ON daily_selected_cleaners (work_date, scope)
      `);

      await query(`ALTER TABLE selected_cleaners_revisions ADD COLUMN IF NOT EXISTS scope VARCHAR(32)`);
      await query(`UPDATE selected_cleaners_revisions SET scope = 'housekeeping' WHERE scope IS NULL`);
      await query(`ALTER TABLE selected_cleaners_revisions ALTER COLUMN scope SET NOT NULL`);
      await query(`ALTER TABLE selected_cleaners_revisions ALTER COLUMN scope SET DEFAULT 'housekeeping'`);
      await query(`
        CREATE INDEX IF NOT EXISTS idx_sel_cleaners_revisions_work_date_scope
        ON selected_cleaners_revisions(work_date, scope, revision_number DESC)
      `);
      await query(`
        CREATE INDEX IF NOT EXISTS idx_sel_cleaners_revisions_sel_scope
        ON selected_cleaners_revisions(selected_cleaners_id, scope, revision_number DESC)
      `);

      console.log('✅ PG: Struttura selected_cleaners allineata a scope');
    } catch (error) {
      console.warn('⚠️ PG: ensureSelectedCleanersScopeStructure:', error);
    }
  }

  /**
   * Logistics: lg_selected_drivers*, daily_logistics_assignments_* (timeline separata da HK)
   */
  async ensureLogisticsWorkspaceTables(): Promise<void> {
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS lg_selected_drivers (
          id SERIAL PRIMARY KEY,
          work_date DATE NOT NULL UNIQUE,
          drivers INTEGER[] NOT NULL DEFAULT '{}',
          vehicle_assignments JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await query(`
        ALTER TABLE lg_selected_drivers
        ADD COLUMN IF NOT EXISTS vehicle_assignments JSONB NOT NULL DEFAULT '{}'::jsonb
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_lg_selected_drivers_work_date ON lg_selected_drivers(work_date)`);
      await query(`
        CREATE TABLE IF NOT EXISTS lg_selected_drivers_revision (
          id SERIAL PRIMARY KEY,
          selected_drivers_id INTEGER NOT NULL REFERENCES lg_selected_drivers(id) ON DELETE CASCADE,
          work_date DATE NOT NULL,
          revision_number INTEGER NOT NULL,
          drivers_before INTEGER[] NOT NULL DEFAULT '{}',
          drivers_after INTEGER[] NOT NULL DEFAULT '{}',
          vehicle_assignments_before JSONB NOT NULL DEFAULT '{}'::jsonb,
          vehicle_assignments_after JSONB NOT NULL DEFAULT '{}'::jsonb,
          action_type VARCHAR(30) NOT NULL,
          action_payload JSONB,
          performed_by VARCHAR(100),
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE (selected_drivers_id, revision_number)
        )
      `);
      await query(`
        ALTER TABLE lg_selected_drivers_revision
        ADD COLUMN IF NOT EXISTS vehicle_assignments_before JSONB NOT NULL DEFAULT '{}'::jsonb
      `);
      await query(`
        ALTER TABLE lg_selected_drivers_revision
        ADD COLUMN IF NOT EXISTS vehicle_assignments_after JSONB NOT NULL DEFAULT '{}'::jsonb
      `);
      await query(`
        CREATE INDEX IF NOT EXISTS idx_lg_sel_drivers_rev_work_date ON lg_selected_drivers_revision(work_date)
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS lg_timeline_revision (
          id SERIAL PRIMARY KEY,
          work_date DATE NOT NULL,
          revision INTEGER NOT NULL,
          task_count INTEGER DEFAULT 0,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          created_by VARCHAR(100) DEFAULT 'system',
          modification_type VARCHAR(100),
          UNIQUE(work_date, revision)
        )
      `);
      await query(`
        CREATE INDEX IF NOT EXISTS idx_lg_timeline_revision_work_date
        ON lg_timeline_revision(work_date, revision DESC)
      `);
      await query(`ALTER TABLE lg_timeline_revision ADD COLUMN IF NOT EXISTS edited_fields TEXT[] DEFAULT '{}'`);
      await query(`ALTER TABLE lg_timeline_revision ADD COLUMN IF NOT EXISTS old_values TEXT[] DEFAULT '{}'`);
      await query(`ALTER TABLE lg_timeline_revision ADD COLUMN IF NOT EXISTS new_values TEXT[] DEFAULT '{}'`);

      await query(`
        CREATE TABLE IF NOT EXISTS lg_timeline (
          id BIGSERIAL PRIMARY KEY,
          work_date DATE NOT NULL,
          driver_id INTEGER NOT NULL,
          driver_name VARCHAR(255),
          driver_lastname VARCHAR(255),
          driver_role VARCHAR(100),
          driver_premium BOOLEAN DEFAULT FALSE,
          driver_start_time VARCHAR(10) DEFAULT '10:00',
          driver_end_time VARCHAR(10) DEFAULT '20:00',
          task_id INTEGER NOT NULL,
          logistic_code INTEGER NOT NULL,
          client_id INTEGER,
          premium BOOLEAN NOT NULL DEFAULT FALSE,
          address TEXT NOT NULL DEFAULT '',
          lat NUMERIC(9, 6),
          lng NUMERIC(9, 6),
          cleaning_time INTEGER NOT NULL DEFAULT 0,
          base_cleaning_time INTEGER,
          checkin_date DATE,
          checkout_date DATE,
          checkin_time VARCHAR(10),
          checkout_time VARCHAR(10),
          pax_in INTEGER,
          pax_out INTEGER,
          small_equipment BOOLEAN,
          operation_id INTEGER,
          confirmed_operation BOOLEAN,
          straordinaria BOOLEAN,
          type_apt VARCHAR(100),
          alias VARCHAR(255),
          customer_name VARCHAR(255),
          customer_reference TEXT,
          customer_note TEXT,
          customer_note_history JSONB NOT NULL DEFAULT '[]'::jsonb,
          reasons TEXT[] NOT NULL DEFAULT '{}',
          manually_moved BOOLEAN NOT NULL DEFAULT FALSE,
          priority VARCHAR(50),
          start_time VARCHAR(10),
          end_time VARCHAR(10),
          followup BOOLEAN,
          sequence INTEGER NOT NULL DEFAULT 0,
          travel_time INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_lg_timeline_work_date ON lg_timeline(work_date)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_lg_timeline_driver_date ON lg_timeline(driver_id, work_date)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_lg_timeline_task ON lg_timeline(task_id)`);

      await query(`
        CREATE TABLE IF NOT EXISTS lg_timeline_history (
          id SERIAL PRIMARY KEY,
          work_date DATE NOT NULL,
          revision INTEGER NOT NULL,
          driver_id INTEGER NOT NULL,
          driver_name VARCHAR(255),
          driver_lastname VARCHAR(255),
          driver_role VARCHAR(100),
          driver_premium BOOLEAN DEFAULT FALSE,
          driver_start_time VARCHAR(10) DEFAULT '10:00',
          driver_end_time VARCHAR(10) DEFAULT '20:00',
          task_id INTEGER NOT NULL,
          logistic_code INTEGER NOT NULL,
          client_id INTEGER,
          premium BOOLEAN NOT NULL DEFAULT FALSE,
          address TEXT NOT NULL DEFAULT '',
          lat NUMERIC(9, 6),
          lng NUMERIC(9, 6),
          cleaning_time INTEGER NOT NULL DEFAULT 0,
          base_cleaning_time INTEGER,
          checkin_date DATE,
          checkout_date DATE,
          checkin_time VARCHAR(10),
          checkout_time VARCHAR(10),
          pax_in INTEGER,
          pax_out INTEGER,
          small_equipment BOOLEAN,
          operation_id INTEGER,
          confirmed_operation BOOLEAN,
          straordinaria BOOLEAN,
          type_apt VARCHAR(100),
          alias VARCHAR(255),
          customer_name VARCHAR(255),
          customer_reference TEXT,
          customer_note TEXT,
          customer_note_history JSONB NOT NULL DEFAULT '[]'::jsonb,
          reasons TEXT[] NOT NULL DEFAULT '{}',
          manually_moved BOOLEAN NOT NULL DEFAULT FALSE,
          priority VARCHAR(50),
          start_time VARCHAR(10),
          end_time VARCHAR(10),
          followup BOOLEAN,
          sequence INTEGER NOT NULL DEFAULT 0,
          travel_time INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          created_by VARCHAR(100) DEFAULT 'system'
        )
      `);
      await query(`
        CREATE INDEX IF NOT EXISTS idx_lg_timeline_history_work_rev
        ON lg_timeline_history(work_date, revision DESC)
      `);
      await query(`ALTER TABLE IF EXISTS lg_timeline ADD COLUMN IF NOT EXISTS customer_note TEXT`);
      await query(`ALTER TABLE IF EXISTS lg_timeline_history ADD COLUMN IF NOT EXISTS customer_note TEXT`);
      await query(`ALTER TABLE IF EXISTS lg_containers ADD COLUMN IF NOT EXISTS customer_note TEXT`);
      await query(`ALTER TABLE IF EXISTS lg_containers_history ADD COLUMN IF NOT EXISTS customer_note TEXT`);
      await query(`ALTER TABLE IF EXISTS lg_timeline ADD COLUMN IF NOT EXISTS customer_note_history JSONB NOT NULL DEFAULT '[]'::jsonb`);
      await query(`ALTER TABLE IF EXISTS lg_timeline_history ADD COLUMN IF NOT EXISTS customer_note_history JSONB NOT NULL DEFAULT '[]'::jsonb`);
      await query(`ALTER TABLE IF EXISTS lg_containers ADD COLUMN IF NOT EXISTS customer_note_history JSONB NOT NULL DEFAULT '[]'::jsonb`);
      await query(`ALTER TABLE IF EXISTS lg_containers_history ADD COLUMN IF NOT EXISTS customer_note_history JSONB NOT NULL DEFAULT '[]'::jsonb`);
      await query(
        `ALTER TABLE IF EXISTS lg_timeline ADD COLUMN IF NOT EXISTS checkout_wait_minutes INTEGER NOT NULL DEFAULT 0`
      );
      await query(
        `ALTER TABLE IF EXISTS lg_timeline_history ADD COLUMN IF NOT EXISTS checkout_wait_minutes INTEGER NOT NULL DEFAULT 0`
      );
      await query(`ALTER TABLE IF EXISTS lg_timeline ADD COLUMN IF NOT EXISTS driver_end_time VARCHAR(10) DEFAULT '20:00'`);
      await query(`ALTER TABLE IF EXISTS lg_timeline_history ADD COLUMN IF NOT EXISTS driver_end_time VARCHAR(10) DEFAULT '20:00'`);
      await query(`ALTER TABLE IF EXISTS lg_drivers ADD COLUMN IF NOT EXISTS end_time VARCHAR(10) NOT NULL DEFAULT '20:00'`);
      await query(`UPDATE lg_timeline SET driver_end_time = '20:00' WHERE driver_end_time IS NULL`);
      await query(`UPDATE lg_timeline_history SET driver_end_time = '20:00' WHERE driver_end_time IS NULL`);
      await query(
        `ALTER TABLE IF EXISTS lg_timeline ADD COLUMN IF NOT EXISTS logistics_task_kind VARCHAR(50)`
      );
      await query(
        `ALTER TABLE IF EXISTS lg_timeline_history ADD COLUMN IF NOT EXISTS logistics_task_kind VARCHAR(50)`
      );
      await query(
        `ALTER TABLE IF EXISTS lg_timeline ADD COLUMN IF NOT EXISTS logistics_task_kind_source VARCHAR(20)`
      );
      await query(
        `ALTER TABLE IF EXISTS lg_timeline_history ADD COLUMN IF NOT EXISTS logistics_task_kind_source VARCHAR(20)`
      );
      await query(
        `ALTER TABLE IF EXISTS lg_timeline ADD COLUMN IF NOT EXISTS is_finished BOOLEAN NOT NULL DEFAULT FALSE`
      );
      await query(
        `ALTER TABLE IF EXISTS lg_timeline_history ADD COLUMN IF NOT EXISTS is_finished BOOLEAN NOT NULL DEFAULT FALSE`
      );
      await query(
        `ALTER TABLE IF EXISTS lg_containers ADD COLUMN IF NOT EXISTS logistics_task_kind VARCHAR(50)`
      );
      await query(
        `ALTER TABLE IF EXISTS lg_containers_history ADD COLUMN IF NOT EXISTS logistics_task_kind VARCHAR(50)`
      );
      await query(
        `ALTER TABLE IF EXISTS lg_containers ADD COLUMN IF NOT EXISTS logistics_task_kind_source VARCHAR(20)`
      );
      await query(
        `ALTER TABLE IF EXISTS lg_containers_history ADD COLUMN IF NOT EXISTS logistics_task_kind_source VARCHAR(20)`
      );
      await query(`UPDATE lg_drivers SET end_time = '20:00' WHERE end_time IS NULL`);

      await query(`
        CREATE TABLE IF NOT EXISTS lg_drivers (
          id SERIAL PRIMARY KEY,
          driver_id INTEGER NOT NULL,
          work_date DATE NOT NULL,
          name VARCHAR(255) NOT NULL,
          lastname VARCHAR(255) NOT NULL,
          role VARCHAR(50) DEFAULT 'Driver',
          active BOOLEAN DEFAULT true,
          ranking INTEGER DEFAULT 0,
          counter_hours DECIMAL(6,2) DEFAULT 0,
          counter_days INTEGER DEFAULT 0,
          available BOOLEAN DEFAULT true,
          contract_type VARCHAR(50),
          preferred_customers INTEGER[] DEFAULT '{}',
          telegram_id BIGINT,
          start_time VARCHAR(10) DEFAULT '10:00',
          end_time VARCHAR(10) NOT NULL DEFAULT '20:00',
          can_do_straordinaria BOOLEAN DEFAULT false,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(driver_id, work_date)
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_lg_drivers_work_date ON lg_drivers(work_date)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_lg_drivers_driver_id ON lg_drivers(driver_id)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_lg_drivers_active ON lg_drivers(active)`);

      console.log('✅ PG: Tabelle logistics workspace verificate');
    } catch (error) {
      console.warn('⚠️ PG: ensureLogisticsWorkspaceTables:', error);
    }
  }

  /**
   * Get all locks for a specific work date as a map
   * @returns Map of task_id -> { locked, locked_reason, locked_by }
   */
  async getLocksMap(workDate: string): Promise<Map<number, { locked: boolean; lockedReason: string | null; lockedBy: string | null }>> {
    const result = await query(
      'SELECT task_id, locked, locked_reason, locked_by FROM daily_task_locks WHERE work_date = $1',
      [workDate]
    );
    
    const locksMap = new Map<number, { locked: boolean; lockedReason: string | null; lockedBy: string | null }>();
    for (const row of result.rows) {
      locksMap.set(row.task_id, {
        locked: row.locked,
        lockedReason: row.locked_reason,
        lockedBy: row.locked_by
      });
    }
    return locksMap;
  }

  /**
   * Get lock status for a specific task
   * @returns Lock record or null if not locked
   */
  async getTaskLock(workDate: string, taskId: number): Promise<{ locked: boolean; lockedReason: string | null; lockedBy: string | null } | null> {
    const result = await query(
      'SELECT locked, locked_reason, locked_by FROM daily_task_locks WHERE work_date = $1 AND task_id = $2',
      [workDate, taskId]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return {
      locked: result.rows[0].locked,
      lockedReason: result.rows[0].locked_reason,
      lockedBy: result.rows[0].locked_by
    };
  }

  /**
   * Check if a task is locked (convenience method)
   */
  async isTaskLocked(workDate: string, taskId: number): Promise<boolean> {
    const lock = await this.getTaskLock(workDate, taskId);
    return lock?.locked ?? false;
  }

  /**
   * Update lock status for a task (UPSERT)
   */
  async updateTaskLockStatus(
    workDate: string, 
    taskId: number, 
    locked: boolean, 
    lockedReason?: string | null, 
    lockedBy?: string | null
  ): Promise<void> {
    await query(`
      INSERT INTO daily_task_locks (work_date, task_id, locked, locked_reason, locked_by, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (work_date, task_id)
      DO UPDATE SET 
        locked = EXCLUDED.locked, 
        locked_reason = EXCLUDED.locked_reason,
        locked_by = EXCLUDED.locked_by,
        updated_at = NOW()
    `, [workDate, taskId, locked, lockedReason || null, lockedBy || null]);
  }

  /**
   * Bulk update lock status for multiple tasks
   */
  async bulkUpdateTaskLockStatus(
    workDate: string,
    taskIds: number[],
    locked: boolean,
    lockedReason?: string | null,
    lockedBy?: string | null
  ): Promise<void> {
    if (taskIds.length === 0) return;
    
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const taskId of taskIds) {
        await client.query(`
          INSERT INTO daily_task_locks (work_date, task_id, locked, locked_reason, locked_by, updated_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (work_date, task_id)
          DO UPDATE SET 
            locked = EXCLUDED.locked, 
            locked_reason = EXCLUDED.locked_reason,
            locked_by = EXCLUDED.locked_by,
            updated_at = NOW()
        `, [workDate, taskId, locked, lockedReason || null, lockedBy || null]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Remove lock for a task (delete from table)
   */
  async removeTaskLock(workDate: string, taskId: number): Promise<void> {
    await query(
      'DELETE FROM daily_task_locks WHERE work_date = $1 AND task_id = $2',
      [workDate, taskId]
    );
  }

  /**
   * Convert timeline JSON to flat rows for PostgreSQL
   * Each row includes both cleaner and task data for complete reconstruction
   */
  private timelineToRows(workDate: string, timeline: any): PgDailyAssignmentRow[] {
    const rows: PgDailyAssignmentRow[] = [];

    if (!timeline?.cleaners_assignments || !Array.isArray(timeline.cleaners_assignments)) {
      return rows;
    }

    for (const assignment of timeline.cleaners_assignments) {
      const cleaner = assignment.cleaner;
      if (!cleaner?.id) continue;

      const tasks = assignment.tasks || [];
      for (const task of tasks) {
        if (!task.task_id) continue;

        const row: PgDailyAssignmentRow = {
          work_date: workDate,
          // Cleaner data (repeated for each task, enables full reconstruction)
          cleaner_id: Number(cleaner.id),
          cleaner_name: cleaner.name || null,
          cleaner_lastname: cleaner.lastname || null,
          cleaner_role: cleaner.role || null,
          cleaner_premium: cleaner.premium != null ? Boolean(cleaner.premium) : null,
          cleaner_start_time: cleaner.start_time ?? '10:00',
          cleaner_end_time: cleaner.end_time ?? '20:00',
          // Task data
          task_id: Number(task.task_id),
          logistic_code: Number(task.logistic_code || 0),
          client_id: task.client_id ? Number(task.client_id) : null,
          premium: Boolean(task.premium),
          address: String(task.address || ''),
          lat: task.lat ? parseFloat(String(task.lat)) : null,
          lng: task.lng ? parseFloat(String(task.lng)) : null,
          cleaning_time: Number(task.cleaning_time || 0),
          base_cleaning_time: task.base_cleaning_time != null ? Number(task.base_cleaning_time) : Number(task.cleaning_time || 0),
          // CRITICAL: always persist date-only strings (avoid timezone day-shifts)
          checkin_date: normalizeDateToYmd(task.checkin_date),
          checkout_date: normalizeDateToYmd(task.checkout_date),
          checkin_time: task.checkin_time || null,
          checkout_time: task.checkout_time || null,
          pax_in: task.pax_in != null ? Number(task.pax_in) : null,
          pax_out: task.pax_out != null ? Number(task.pax_out) : null,
          small_equipment: task.small_equipment != null ? Boolean(task.small_equipment) : null,
          operation_id: task.operation_id != null ? Number(task.operation_id) : null,
          confirmed_operation: task.confirmed_operation != null ? Boolean(task.confirmed_operation) : null,
          straordinaria: task.straordinaria != null ? Boolean(task.straordinaria) : null,
          type_apt: task.type_apt || null,
          alias: task.alias || null,
          customer_name: task.customer_name || null,
          customer_reference: task.customer_reference ? String(task.customer_reference) : null,
          customer_note: task.customer_note != null ? String(task.customer_note) : null,
          customer_note_history: normalizeCustomerNoteHistory(task.customer_note_history),
          reasons: Array.isArray(task.reasons) ? task.reasons : [],
          priority: task.priority || null,
          start_time: task.start_time || null,
          end_time: task.end_time || null,
          followup: task.followup != null ? Boolean(task.followup) : null,
          sequence: Number(task.sequence || 0),
          travel_time: Number(task.travel_time || 0),
          manually_moved: Boolean(task.manually_moved),
        };

        rows.push(row);
      }
    }

    return rows;
  }

  /**
   * Save timeline to PostgreSQL (replaces all rows for workDate)
   */
  async saveTimeline(workDate: string, timeline: any, scope: string | null = 'housekeeping'): Promise<number> {
    const client = await pool.connect();

    try {
      const rows = this.timelineToRows(workDate, timeline);
      const normalizedScope = this.normalizeScope(scope);

      console.log(`📝 PG: Salvando ${rows.length} righe per ${workDate}...`);

      await client.query('BEGIN');

      // Delete existing rows for this work_date
      if (normalizedScope === 'office') {
        await client.query(
          "DELETE FROM daily_assignments_current WHERE work_date = $1 AND scope = 'office'",
          [workDate]
        );
      } else {
        await client.query(
          "DELETE FROM daily_assignments_current WHERE work_date = $1 AND (scope = 'housekeeping' OR scope IS NULL)",
          [workDate]
        );
      }

      if (rows.length === 0) {
        await client.query('COMMIT');
        console.log(`✅ PG: Nessuna assegnazione da salvare per ${workDate}`);
        return 0;
      }

      // Insert new rows (includes cleaner data for full reconstruction)
      for (const row of rows) {
        await client.query(`
          INSERT INTO daily_assignments_current (
            scope,
            work_date, cleaner_id, cleaner_name, cleaner_lastname, cleaner_role, cleaner_premium, cleaner_start_time, cleaner_end_time,
            task_id, logistic_code, client_id,
            premium, address, lat, lng, cleaning_time, base_cleaning_time,
            checkin_date, checkout_date, checkin_time, checkout_time,
            pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
            type_apt, alias, customer_name, customer_reference, customer_note, customer_note_history, reasons, manually_moved, priority,
            start_time, end_time, followup, sequence, travel_time
          ) VALUES (
            $1,
            $2, $3, $4, $5, $6, $7, $8, $9,
            $10, $11, $12,
            $13, $14, $15, $16, $17, $18,
            $19, $20, $21, $22,
            $23, $24, $25, $26, $27, $28,
            $29, $30, $31, $32, $33, $34, $35, $36, $37,
            $38, $39, $40, $41, $42
          )
        `, [
          normalizedScope,
          row.work_date,
          row.cleaner_id,
          row.cleaner_name,
          row.cleaner_lastname,
          row.cleaner_role,
          row.cleaner_premium,
          row.cleaner_start_time,
          row.cleaner_end_time,
          row.task_id,
          row.logistic_code,
          row.client_id,
          row.premium,
          row.address,
          row.lat,
          row.lng,
          row.cleaning_time,
          row.base_cleaning_time,
          row.checkin_date,
          row.checkout_date,
          row.checkin_time ? row.checkin_time.substring(0, 5) : null,
          row.checkout_time ? row.checkout_time.substring(0, 5) : null,
          row.pax_in,
          row.pax_out,
          row.small_equipment,
          row.operation_id,
          row.confirmed_operation,
          row.straordinaria,
          row.type_apt,
          row.alias,
          row.customer_name,
          row.customer_reference,
          row.customer_note,
          toCustomerNoteHistoryJson(row.customer_note_history),
          row.reasons,
          row.manually_moved === true,
          row.priority,
          row.start_time,
          row.end_time,
          row.followup,
          row.sequence,
          row.travel_time,
        ]);
      }

      await client.query('COMMIT');
      console.log(`✅ PG: Salvate ${rows.length} assegnazioni per ${workDate}`);
      return rows.length;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ PG: Errore nel salvataggio:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get all assignments for a work_date (flat rows)
   */
  async getAssignments(workDate: string, scope: string | null = 'housekeeping'): Promise<PgDailyAssignmentRow[]> {
    try {
      const normalizedScope = this.normalizeScope(scope);
      const result = normalizedScope === 'office'
        ? await query(
            "SELECT * FROM daily_assignments_current WHERE work_date = $1 AND scope = 'office' ORDER BY cleaner_id, sequence",
            [workDate]
          )
        : await query(
            "SELECT * FROM daily_assignments_current WHERE work_date = $1 AND (scope = 'housekeeping' OR scope IS NULL) ORDER BY cleaner_id, sequence",
            [workDate]
          );
      return result.rows;
    } catch (error) {
      console.error('❌ PG: Errore nel caricamento:', error);
      return [];
    }
  }

  /**
   * Load timeline from PostgreSQL flat records and reconstruct JSON structure
   * This is the inverse of timelineToRows - converts flat DB rows back to timeline format
   * 
   * Returns the same structure as timeline.json:
   * {
   *   cleaners_assignments: [
   *     { cleaner: {...}, tasks: [...] },
   *     ...
   *   ],
   *   metadata: { date, last_updated }
   * }
   */
  async loadTimeline(workDate: string, scope: string | null = 'housekeeping'): Promise<any | null> {
    try {
      const rows = await this.getAssignments(workDate, scope);

      if (rows.length === 0) {
        console.log(`📖 PG: Nessuna assegnazione trovata per ${workDate}`);
        return null;
      }

      // Load collaborations map for this work_date
      const collaborationsMap = await taskCollaborationService.getCollaborationsMap(workDate);
      const uniqueCleanerIds = Array.from(new Set(rows.map((r) => Number(r.cleaner_id)).filter((id) => Number.isFinite(id))));
      const cleanersAnyScope = await this.loadCleanersByIdsAnyScope(uniqueCleanerIds, workDate);
      const rosterById = new Map<number, any>(
        cleanersAnyScope.map((c: any) => [Number(c.id), c])
      );

      // Group rows by cleaner_id
      const cleanerMap = new Map<number, { cleaner: any; tasks: any[] }>();

      for (const row of rows) {
        if (!cleanerMap.has(row.cleaner_id)) {
          // Build cleaner object from stored data
          const rosterCleaner = rosterById.get(Number(row.cleaner_id));
          const rawName = typeof row.cleaner_name === 'string' ? row.cleaner_name.trim() : '';
          const rawLastname = typeof row.cleaner_lastname === 'string' ? row.cleaner_lastname.trim() : '';
          const isIdPlaceholderName =
            !!rawName &&
            (rawName.toUpperCase() === `ID ${row.cleaner_id}` || /^ID\s+\d+$/i.test(rawName));
          const resolvedName = !rawName || isIdPlaceholderName ? (rosterCleaner?.name || rawName) : rawName;
          const resolvedLastname = rawLastname || rosterCleaner?.lastname || '';
          const resolvedRole = row.cleaner_role || rosterCleaner?.role || null;

          const cleaner: any = { id: row.cleaner_id };
          if (resolvedName) cleaner.name = resolvedName;
          if (resolvedLastname) cleaner.lastname = resolvedLastname;
          if (resolvedRole) cleaner.role = resolvedRole;
          if (rosterCleaner?.alias) cleaner.alias = rosterCleaner.alias;
          if (row.cleaner_premium !== null) cleaner.premium = row.cleaner_premium;
          cleaner.start_time = row.cleaner_start_time ?? '10:00';
          cleaner.end_time = row.cleaner_end_time ?? '20:00';

          cleanerMap.set(row.cleaner_id, {
            cleaner,
            tasks: []
          });
        }

        const task: any = {
          task_id: row.task_id,
          logistic_code: row.logistic_code,
        };

        // Add optional fields only if they have values
        if (row.client_id) task.client_id = row.client_id;
        if (row.premium !== null) task.premium = row.premium;
        if (row.address) task.address = row.address;
        if (row.lat !== null) task.lat = parseFloat(String(row.lat));
        if (row.lng !== null) task.lng = parseFloat(String(row.lng));
        
        // Get collaboration info (task_id in collaborationsMap is number, row.task_id is string)
        const taskIdNum = parseInt(String(row.task_id), 10);
        const collaboration = collaborationsMap.get(taskIdNum);
        const hasCollaborators = collaboration && collaboration.count > 1;
        
        // Calculate base_cleaning_time (original duration before collaboration split)
        // If base_cleaning_time is null and there are collaborators, assume cleaning_time 
        // is already the effective time and we need to reconstruct the base
        let baseTime: number;
        if (row.base_cleaning_time != null) {
          baseTime = row.base_cleaning_time;
        } else if (hasCollaborators) {
          // Reconstruct: base = effective * count (for legacy data without base_cleaning_time)
          baseTime = row.cleaning_time * collaboration!.count;
        } else {
          baseTime = row.cleaning_time;
        }
        task.base_cleaning_time = baseTime;
        
        // Use cleaning_time directly from DB row - it's already calculated correctly
        // The DB stores the effective (split) cleaning_time, not the base
        task.cleaning_time = row.cleaning_time;
        
        // Add collaboration metadata if present
        if (hasCollaborators) {
          task.collaborator_ids = collaboration!.cleanerIds;
          task.collaborator_count = collaboration!.count;
          if (collaboration!.primaryCleanerId !== null) {
            task.is_primary = row.cleaner_id === collaboration!.primaryCleanerId;
          }
        }
        
        // Normalize on read as well (row can be Date in some pg configurations)
        task.checkin_date = normalizeDateToYmd(row.checkin_date) ?? undefined;
        task.checkout_date = normalizeDateToYmd(row.checkout_date) ?? undefined;
        if (row.checkin_time) task.checkin_time = row.checkin_time.substring(0, 5);
        if (row.checkout_time) task.checkout_time = row.checkout_time.substring(0, 5);
        if (row.pax_in !== null) task.pax_in = row.pax_in;
        if (row.pax_out !== null) task.pax_out = row.pax_out;
        if (row.small_equipment !== null) task.small_equipment = row.small_equipment;
        if (row.operation_id !== null) task.operation_id = row.operation_id;
        if (row.confirmed_operation !== null) task.confirmed_operation = row.confirmed_operation;
        if (row.straordinaria !== null) task.straordinaria = row.straordinaria;
        if (row.type_apt) task.type_apt = row.type_apt;
        if (row.alias) task.alias = row.alias;
        if (row.customer_name) task.customer_name = row.customer_name;
        if (row.customer_reference) task.customer_reference = row.customer_reference;
        if (row.customer_note) task.customer_note = row.customer_note;
        if (Array.isArray(row.customer_note_history) && row.customer_note_history.length > 0) {
          task.customer_note_history = row.customer_note_history;
        }
        if (row.reasons && row.reasons.length > 0) {
          task.reasons = row.reasons;
          const reasons = row.reasons.map((reason: unknown) => String(reason ?? "").trim());
          if (reasons.includes("preassigned_enable_wass_readonly")) {
            task.preAssignedMode = "readonly";
          } else if (reasons.includes("preassigned_enable_wass")) {
            task.preAssignedMode = "normal";
          }
        }
        task.manually_moved = row.manually_moved === true;
        if (row.priority) task.priority = row.priority;
        if (row.start_time) task.start_time = row.start_time;
        if (row.end_time) task.end_time = row.end_time;
        if (row.followup !== null) task.followup = row.followup;
        if (row.sequence !== null) task.sequence = row.sequence;
        if (row.travel_time !== null) task.travel_time = row.travel_time;

        cleanerMap.get(row.cleaner_id)!.tasks.push(task);
      }

      // Convert map to array and sort tasks by sequence
      const cleaners_assignments = Array.from(cleanerMap.values()).map(ca => ({
        ...ca,
        tasks: ca.tasks.sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
      }));

      const totalTasks = cleaners_assignments.reduce((sum, ca) => sum + ca.tasks.length, 0);
      const usedCleaners = cleaners_assignments.filter(ca => ca.tasks.length > 0).length;

      const timeline = {
        cleaners_assignments,
        metadata: {
          date: workDate,
          last_updated: new Date().toISOString(),
          source: 'postgresql'
        },
        meta: {
          total_cleaners: cleaners_assignments.length,
          used_cleaners: usedCleaners,
          assigned_tasks: totalTasks
        }
      };

      console.log(`✅ PG: Timeline ricostruita per ${workDate} (${totalTasks} task, ${cleaners_assignments.length} cleaners)`);
      return timeline;

    } catch (error) {
      console.error('❌ PG: Errore nel caricamento timeline:', error);
      return null;
    }
  }

  /**
   * Delete all assignments for a work_date
   */
  async deleteAssignments(workDate: string): Promise<boolean> {
    try {
      await query(
        'DELETE FROM daily_assignments_current WHERE work_date = $1',
        [workDate]
      );
      console.log(`✅ PG: Eliminate assegnazioni per ${workDate}`);
      return true;
    } catch (error) {
      console.error('❌ PG: Errore nella cancellazione:', error);
      return false;
    }
  }

  /**
   * Count assignments for a work_date
   */
  async countAssignments(workDate: string, scope: string | null = 'housekeeping'): Promise<number> {
    try {
      const normalizedScope = this.normalizeScope(scope);
      const result = normalizedScope === 'office'
        ? await query(
            "SELECT COUNT(*) as count FROM daily_assignments_current WHERE work_date = $1 AND scope = 'office'",
            [workDate]
          )
        : await query(
            "SELECT COUNT(*) as count FROM daily_assignments_current WHERE work_date = $1 AND (scope = 'housekeeping' OR scope IS NULL)",
            [workDate]
          );
      return parseInt(result.rows[0]?.count || '0');
    } catch (error) {
      console.error('❌ PG: Errore nel conteggio:', error);
      return 0;
    }
  }

  /**
   * Save timeline to history (audit/rollback purposes)
   * Direct write from memory - no JSON intermediate
   * 
   * Uses daily_assignments_revisions table to track revision numbers reliably.
   * Each save creates a new revision entry (even for empty timelines).
   * 
   * Change tracking:
   * - editedFields: array of field names that changed (e.g. ["cleaner_id", "sequence", "start_time"])
   * - oldValues: array of previous values in same order
   * - newValues: array of new values in same order
   */
  async saveToHistory(
    workDate: string, 
    timeline: any, 
    createdBy: string = 'system',
    modificationType: string = 'manual',
    editedFields: string[] = [],
    oldValues: string[] = [],
    newValues: string[] = [],
    scope: string | null = 'housekeeping'
  ): Promise<number> {
    const client = await pool.connect();

    try {
      const rows = this.timelineToRows(workDate, timeline);
      const normalizedScope = this.normalizeScope(scope);

      await client.query('BEGIN');

      // Lock the revisions table for this work_date to prevent race conditions
      // Use a separate SELECT FOR UPDATE on the table itself, then calculate MAX
      if (normalizedScope === 'office') {
        await client.query(
          "SELECT 1 FROM daily_assignments_revisions WHERE work_date = $1 AND scope = 'office' FOR UPDATE",
          [workDate]
        );
      } else {
        await client.query(
          "SELECT 1 FROM daily_assignments_revisions WHERE work_date = $1 AND (scope = 'housekeeping' OR scope IS NULL) FOR UPDATE",
          [workDate]
        );
      }

      // Now safely get the next revision number
      const revResult = normalizedScope === 'office'
        ? await client.query(
            "SELECT COALESCE(MAX(revision), 0) + 1 as next_revision FROM daily_assignments_revisions WHERE work_date = $1 AND scope = 'office'",
            [workDate]
          )
        : await client.query(
            "SELECT COALESCE(MAX(revision), 0) + 1 as next_revision FROM daily_assignments_revisions WHERE work_date = $1 AND (scope = 'housekeeping' OR scope IS NULL)",
            [workDate]
          );
      const revision = parseInt(revResult.rows[0]?.next_revision || '1');

      console.log(`📜 PG History: Salvando revisione ${revision} con ${rows.length} righe per ${workDate}...`);

      // ALWAYS create revision metadata entry (even for empty timelines)
      // This ensures revision numbers advance reliably
      // Includes change tracking: edited_fields, old_values, new_values
      await client.query(`
        INSERT INTO daily_assignments_revisions (scope, work_date, revision, task_count, created_by, modification_type, edited_fields, old_values, new_values)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [normalizedScope, workDate, revision, rows.length, createdBy, modificationType, editedFields, oldValues, newValues]);

      // Insert task rows if any (includes cleaner data for full reconstruction)
      for (const row of rows) {
        await client.query(`
          INSERT INTO daily_assignments_history (
            scope,
            work_date, revision, cleaner_id, cleaner_name, cleaner_lastname, cleaner_role, cleaner_premium, cleaner_start_time, cleaner_end_time,
            task_id, logistic_code, client_id,
            premium, address, lat, lng, cleaning_time, base_cleaning_time,
            checkin_date, checkout_date, checkin_time, checkout_time,
            pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
            type_apt, alias, customer_name, customer_reference, customer_note, customer_note_history, reasons, manually_moved, priority,
            start_time, end_time, followup, sequence, travel_time, created_by
          ) VALUES (
            $1,
            $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13,
            $14, $15, $16, $17, $18, $19,
            $20, $21, $22, $23,
            $24, $25, $26, $27, $28, $29,
            $30, $31, $32, $33, $34, $35, $36, $37, $38,
            $39, $40, $41, $42, $43, $44
          )
        `, [
          normalizedScope,
          row.work_date,
          revision,
          row.cleaner_id,
          row.cleaner_name,
          row.cleaner_lastname,
          row.cleaner_role,
          row.cleaner_premium,
          row.cleaner_start_time,
          row.cleaner_end_time,
          row.task_id,
          row.logistic_code,
          row.client_id,
          row.premium,
          row.address,
          row.lat,
          row.lng,
          row.cleaning_time,
          row.base_cleaning_time,
          row.checkin_date,
          row.checkout_date,
          row.checkin_time,
          row.checkout_time,
          row.pax_in,
          row.pax_out,
          row.small_equipment,
          row.operation_id,
          row.confirmed_operation,
          row.straordinaria,
          row.type_apt,
          row.alias,
          row.customer_name,
          row.customer_reference,
          row.customer_note,
          toCustomerNoteHistoryJson(row.customer_note_history),
          row.reasons,
          row.manually_moved === true,
          row.priority,
          row.start_time,
          row.end_time,
          row.followup,
          row.sequence,
          row.travel_time,
          createdBy,
        ]);
      }

      await client.query('COMMIT');
      console.log(`✅ PG History: Salvata revisione ${revision} con ${rows.length} assegnazioni per ${workDate}`);
      return revision;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ PG History: Errore nel salvataggio:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get history revisions for a work_date
   * Uses the revisions metadata table for reliable revision tracking
   * Includes change tracking fields: edited_fields, old_values, new_values
   */
  async getHistoryRevisions(workDate: string, scope: string | null = 'housekeeping'): Promise<{ 
    revision: number; 
    created_at: Date; 
    created_by: string; 
    task_count: number; 
    modification_type: string;
    edited_fields: string[];
    old_values: string[];
    new_values: string[];
  }[]> {
    try {
      const normalizedScope = this.normalizeScope(scope);
      const result = await query(`
        SELECT revision, created_at, created_by, task_count, modification_type, 
               edited_fields, old_values, new_values
        FROM daily_assignments_revisions 
        WHERE work_date = $1
          AND (${normalizedScope === 'office' ? "scope = 'office'" : "(scope = 'housekeeping' OR scope IS NULL)"})
        ORDER BY revision DESC
      `, [workDate]);
      return result.rows;
    } catch (error) {
      console.error('❌ PG History: Errore nel caricamento revisioni:', error);
      return [];
    }
  }

  /**
   * Get assignments for a specific revision
   */
  async getHistoryByRevision(workDate: string, revision: number, scope: string | null = 'housekeeping'): Promise<PgDailyAssignmentRow[]> {
    try {
      const normalizedScope = this.normalizeScope(scope);
      const result = normalizedScope === 'office'
        ? await query(
            "SELECT * FROM daily_assignments_history WHERE work_date = $1 AND revision = $2 AND scope = 'office' ORDER BY cleaner_id, sequence",
            [workDate, revision]
          )
        : await query(
            "SELECT * FROM daily_assignments_history WHERE work_date = $1 AND revision = $2 AND (scope = 'housekeeping' OR scope IS NULL) ORDER BY cleaner_id, sequence",
            [workDate, revision]
          );
      return result.rows;
    } catch (error) {
      console.error('❌ PG History: Errore nel caricamento revisione:', error);
      return [];
    }
  }

  /**
   * Get the user who created the last revision for a work_date
   * Returns null if no revisions exist
   */
  async getLastRevisionUser(workDate: string, scope: string | null = 'housekeeping'): Promise<string | null> {
    try {
      const normalizedScope = this.normalizeScope(scope);
      const result = await query(`
        SELECT created_by 
        FROM daily_assignments_revisions 
        WHERE work_date = $1
          AND (${normalizedScope === 'office' ? "scope = 'office'" : "(scope = 'housekeeping' OR scope IS NULL)"})
        ORDER BY revision DESC
        LIMIT 1
      `, [workDate]);
      return result.rows[0]?.created_by || null;
    } catch (error) {
      console.error('❌ PG History: Errore nel recupero ultimo utente:', error);
      return null;
    }
  }

  /**
   * Get the timestamp of the last transfer to ADAM for a work_date
   * Looks ONLY for 'transfer_to_adam' modification_type (actual ADAM transfers)
   * NOT 'api_save_timeline' which is only local PostgreSQL saves
   */
  async getLastTransferToAdamTimestamp(workDate: string, scope: string | null = 'housekeeping'): Promise<Date | null> {
    try {
      const normalizedScope = this.normalizeScope(scope);
      const result = await query(`
        SELECT created_at 
        FROM daily_assignments_revisions 
        WHERE work_date = $1 AND modification_type = 'transfer_to_adam'
          AND (${normalizedScope === 'office' ? "scope = 'office'" : "(scope = 'housekeeping' OR scope IS NULL)"})
        ORDER BY created_at DESC
        LIMIT 1
      `, [workDate]);
      return result.rows[0]?.created_at || null;
    } catch (error) {
      console.error('❌ PG History: Errore nel recupero ultimo trasferimento ADAM:', error);
      return null;
    }
  }

  /** Ultimo invio timeline logistica su ADAM (se presente). */
  async getLastLogisticsTransferToAdamTimestamp(workDate: string): Promise<Date | null> {
    try {
      const result = await query(
        `
        SELECT created_at
        FROM lg_timeline_revision
        WHERE work_date = $1 AND modification_type = 'transfer_to_adam'
        ORDER BY revision DESC
        LIMIT 1
      `,
        [workDate]
      );
      return result.rows[0]?.created_at || null;
    } catch (error) {
      console.error('❌ PG: getLastLogisticsTransferToAdamTimestamp:', error);
      return null;
    }
  }

  /** Driver con almeno una task nella timeline logistica corrente per la data. */
  async loadLogisticsCurrentDriverIds(workDate: string): Promise<Set<number>> {
    try {
      const result = await query(
        `SELECT DISTINCT driver_id FROM lg_timeline WHERE work_date = $1`,
        [workDate]
      );
      const s = new Set<number>();
      for (const row of result.rows) {
        const id = Number((row as any).driver_id);
        if (Number.isFinite(id)) s.add(id);
      }
      return s;
    } catch (error) {
      console.error('❌ PG: loadLogisticsCurrentDriverIds:', error);
      return new Set();
    }
  }

  /**
   * Count how many transfer_to_adam revisions exist for a work_date.
   * Used to detect "second or later transfer" for cleanup phase (clear unassigned tasks on ADAM).
   */
  async countTransferToAdamForDate(workDate: string, scope: string | null = 'housekeeping'): Promise<number> {
    try {
      const normalizedScope = this.normalizeScope(scope);
      const result = await query(
        `SELECT COUNT(*)::int AS cnt FROM daily_assignments_revisions
         WHERE work_date = $1 AND modification_type = 'transfer_to_adam'
           AND (${normalizedScope === 'office' ? "scope = 'office'" : "(scope = 'housekeeping' OR scope IS NULL)"})`,
        [workDate]
      );
      return result.rows[0]?.cnt ?? 0;
    } catch (error) {
      console.error('❌ PG History: Errore nel conteggio trasferimenti ADAM:', error);
      return 0;
    }
  }

  // ==================== LOGISTICS TIMELINE (daily_logistics_assignments_*) ====================

  private logisticsTimelineToRows(workDate: string, timeline: any): PgLogisticsAssignmentRow[] {
    const rows: PgLogisticsAssignmentRow[] = [];
    if (!timeline?.drivers_assignments || !Array.isArray(timeline.drivers_assignments)) {
      return rows;
    }
    const seenTaskKeys = new Set<string>();
    for (const assignment of timeline.drivers_assignments) {
      const driver = assignment.driver;
      if (!driver?.id) continue;
      const tasks = assignment.tasks || [];
      for (const task of tasks) {
        if (!task.task_id) continue;
        const taskKey = `task:${Number(task.task_id)}`;
        if (seenTaskKeys.has(taskKey)) {
          console.warn(
            `⚠️ PG Logistics: task duplicata ignorata in saveLogisticsTimeline (${workDate}, task_id=${task.task_id})`
          );
          continue;
        }
        seenTaskKeys.add(taskKey);
        rows.push({
          work_date: workDate,
          driver_id: Number(driver.id),
          driver_name: driver.name || null,
          driver_lastname: driver.lastname || null,
          driver_role: driver.role || null,
          driver_premium: driver.premium != null ? Boolean(driver.premium) : null,
          driver_start_time: driver.start_time ?? '10:00',
          driver_end_time: driver.end_time ?? '20:00',
          task_id: Number(task.task_id),
          logistic_code: Number(task.logistic_code || 0),
          client_id: task.client_id ? Number(task.client_id) : null,
          premium: Boolean(task.premium),
          address: String(task.address || ''),
          lat: task.lat ? parseFloat(String(task.lat)) : null,
          lng: task.lng ? parseFloat(String(task.lng)) : null,
          cleaning_time: Number(task.cleaning_time || 0),
          base_cleaning_time: task.base_cleaning_time != null ? Number(task.base_cleaning_time) : Number(task.cleaning_time || 0),
          checkin_date: normalizeDateToYmd(task.checkin_date),
          checkout_date: normalizeDateToYmd(task.checkout_date),
          checkin_time: task.checkin_time || null,
          checkout_time: task.checkout_time || null,
          pax_in: task.pax_in != null ? Number(task.pax_in) : null,
          pax_out: task.pax_out != null ? Number(task.pax_out) : null,
          small_equipment: task.small_equipment != null ? Boolean(task.small_equipment) : null,
          operation_id: task.operation_id != null ? Number(task.operation_id) : null,
          confirmed_operation: task.confirmed_operation != null ? Boolean(task.confirmed_operation) : null,
          straordinaria: task.straordinaria != null ? Boolean(task.straordinaria) : null,
          type_apt: task.type_apt || null,
          alias: task.alias || null,
          customer_name: task.customer_name || null,
          customer_reference: task.customer_reference ? String(task.customer_reference) : null,
          customer_note: task.customer_note != null ? String(task.customer_note) : null,
          customer_note_history: normalizeCustomerNoteHistory(task.customer_note_history),
          reasons: Array.isArray(task.reasons) ? task.reasons : [],
          priority: task.priority || null,
          start_time: task.start_time || null,
          end_time: task.end_time || null,
          followup: task.followup != null ? Boolean(task.followup) : null,
          sequence: Number(task.sequence || 0),
          travel_time: Number(task.travel_time || 0),
          checkout_wait_minutes:
            task.checkout_wait_minutes != null ? Number(task.checkout_wait_minutes) : 0,
          manually_moved: Boolean(task.manually_moved),
          is_finished: Boolean(task.is_finished ?? task.isFinished),
          logistics_task_kind:
            task.logistics_task_kind != null ? String(task.logistics_task_kind) : null,
          logistics_task_kind_source:
            task.logistics_task_kind_source != null
              ? String(task.logistics_task_kind_source)
              : null,
        });
      }
    }
    return rows;
  }

  async saveLogisticsTimeline(workDate: string, timeline: any): Promise<number> {
    const client = await pool.connect();
    try {
      const { enrichLogisticsTimelineData, loadManualLogisticsTimelineTaskKinds } = await import(
        "./logistics-task-kind-enrichment"
      );
      const manualKindsByTaskId = await loadManualLogisticsTimelineTaskKinds(workDate);
      await enrichLogisticsTimelineData(workDate, timeline, { manualKindsByTaskId });

      // Preserve is_finished when callers omit it (e.g. optimizer / DnD payloads).
      const existingFinished = new Map<number, boolean>();
      try {
        const existingRes = await client.query(
          `SELECT task_id, is_finished FROM lg_timeline WHERE work_date = $1`,
          [workDate]
        );
        for (const r of existingRes.rows) {
          const tid = Number(r.task_id);
          if (Number.isFinite(tid)) existingFinished.set(tid, r.is_finished === true);
        }
      } catch {
        // Column may not exist yet on first boot before ensureTables; ignore.
      }
      if (timeline?.drivers_assignments && Array.isArray(timeline.drivers_assignments)) {
        for (const assignment of timeline.drivers_assignments) {
          for (const task of assignment?.tasks || []) {
            const tid = Number(task?.task_id);
            if (!Number.isFinite(tid)) continue;
            if (task.is_finished != null || task.isFinished != null) continue;
            if (existingFinished.has(tid)) {
              task.is_finished = existingFinished.get(tid);
            }
          }
        }
      }

      const rows = this.logisticsTimelineToRows(workDate, timeline);
      await client.query('BEGIN');
      await client.query('DELETE FROM lg_timeline WHERE work_date = $1', [workDate]);
      if (rows.length === 0) {
        await client.query('COMMIT');
        return 0;
      }
      for (const row of rows) {
        await client.query(`
          INSERT INTO lg_timeline (
            work_date, driver_id, driver_name, driver_lastname, driver_role, driver_premium, driver_start_time, driver_end_time,
            task_id, logistic_code, client_id,
            premium, address, lat, lng, cleaning_time, base_cleaning_time,
            checkin_date, checkout_date, checkin_time, checkout_time,
            pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
            type_apt, alias, customer_name, customer_reference, customer_note, customer_note_history, reasons, manually_moved, priority,
            start_time, end_time, followup, sequence, travel_time, checkout_wait_minutes,
            logistics_task_kind, logistics_task_kind_source, is_finished
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11,
            $12, $13, $14, $15, $16, $17,
            $18, $19, $20, $21,
            $22, $23, $24, $25, $26, $27,
            $28, $29, $30, $31, $32, $33, $34, $35, $36,
            $37, $38, $39, $40, $41, $42,
            $43, $44, $45
          )
        `, [
          row.work_date,
          row.driver_id,
          row.driver_name,
          row.driver_lastname,
          row.driver_role,
          row.driver_premium,
          row.driver_start_time,
          row.driver_end_time,
          row.task_id,
          row.logistic_code,
          row.client_id,
          row.premium,
          row.address,
          row.lat,
          row.lng,
          row.cleaning_time,
          row.base_cleaning_time,
          row.checkin_date,
          row.checkout_date,
          row.checkin_time ? row.checkin_time.substring(0, 5) : null,
          row.checkout_time ? row.checkout_time.substring(0, 5) : null,
          row.pax_in,
          row.pax_out,
          row.small_equipment,
          row.operation_id,
          row.confirmed_operation,
          row.straordinaria,
          row.type_apt,
          row.alias,
          row.customer_name,
          row.customer_reference,
          row.customer_note,
          toCustomerNoteHistoryJson(row.customer_note_history),
          row.reasons,
          row.manually_moved === true,
          row.priority,
          row.start_time,
          row.end_time,
          row.followup,
          row.sequence,
          row.travel_time,
          row.checkout_wait_minutes ?? 0,
          row.logistics_task_kind,
          row.logistics_task_kind_source,
          row.is_finished === true,
        ]);
      }
      await client.query('COMMIT');
      return rows.length;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ PG Logistics: saveLogisticsTimeline', error);
      throw error;
    } finally {
      client.release();
    }
  }

  async getLogisticsAssignments(workDate: string): Promise<PgLogisticsAssignmentRow[]> {
    try {
      const result = await query(
        'SELECT * FROM lg_timeline WHERE work_date = $1 ORDER BY driver_id, sequence',
        [workDate]
      );
      return result.rows;
    } catch (error) {
      console.error('❌ PG Logistics: getLogisticsAssignments', error);
      return [];
    }
  }

  async loadLogisticsTimeline(workDate: string): Promise<any | null> {
    try {
      try {
        await this.ensureDefaultLocksForAdamLogisticCode1741(workDate);
      } catch (lockError) {
        console.warn('⚠️ PG: ensureDefaultLocksForAdamLogisticCode1741 a load timeline:', lockError);
      }
      const rows = await this.getLogisticsAssignments(workDate);
      if (rows.length === 0) {
        return null;
      }

      const taskIds = rows.map((row) => Number(row.task_id)).filter((id) => Number.isFinite(id));
      const {
        loadCleanerContextByTaskIds,
        enrichLogisticsTimelineTask,
        syncLogisticsTimelineAutoKinds,
        attachCleanerContextFields,
      } = await import("./logistics-task-kind-enrichment");
      const { buildLogisticsContainerAutoKindPatches } = await import(
        "../../shared/logistics-task-kind"
      );
      const cleanerContextByTaskId = await loadCleanerContextByTaskIds(workDate, taskIds);
      const enrichedTasksById = new Map<number, any>();
      const { attachLogisticsTaskWindowFields } = await import("./logistics-task-window-fields");

      const driverMap = new Map<number, { driver: any; tasks: any[] }>();
      for (const row of rows) {
        if (!driverMap.has(row.driver_id)) {
          const driver: any = { id: row.driver_id };
          if (row.driver_name) driver.name = row.driver_name;
          if (row.driver_lastname) driver.lastname = row.driver_lastname;
          if (row.driver_role) driver.role = row.driver_role;
          if (row.driver_premium !== null) driver.premium = row.driver_premium;
          driver.start_time = row.driver_start_time ?? '10:00';
          driver.end_time = row.driver_end_time ?? '20:00';
          driverMap.set(row.driver_id, { driver, tasks: [] });
        }
        const task: any = {
          task_id: row.task_id,
          logistic_code: row.logistic_code,
        };
        if (row.client_id) task.client_id = row.client_id;
        if (row.premium !== null) task.premium = row.premium;
        if (row.address) task.address = row.address;
        if (row.lat !== null) task.lat = parseFloat(String(row.lat));
        if (row.lng !== null) task.lng = parseFloat(String(row.lng));
        const baseTime =
          row.base_cleaning_time != null ? row.base_cleaning_time : row.cleaning_time;
        task.base_cleaning_time = baseTime;
        task.cleaning_time = row.cleaning_time;
        task.checkin_date = normalizeDateToYmd(row.checkin_date) ?? undefined;
        task.checkout_date = normalizeDateToYmd(row.checkout_date) ?? undefined;
        if (row.checkin_time) task.checkin_time = row.checkin_time.substring(0, 5);
        if (row.checkout_time) task.checkout_time = row.checkout_time.substring(0, 5);
        if (row.pax_in !== null) task.pax_in = row.pax_in;
        if (row.pax_out !== null) task.pax_out = row.pax_out;
        if (row.small_equipment !== null) task.small_equipment = row.small_equipment;
        if (row.operation_id !== null) task.operation_id = row.operation_id;
        if (row.confirmed_operation !== null) task.confirmed_operation = row.confirmed_operation;
        if (row.straordinaria !== null) task.straordinaria = row.straordinaria;
        if (row.type_apt) task.type_apt = row.type_apt;
        if (row.alias) task.alias = row.alias;
        if (row.customer_name) task.customer_name = row.customer_name;
        if (row.customer_reference) task.customer_reference = row.customer_reference;
        if (row.customer_note) task.customer_note = row.customer_note;
        if (Array.isArray(row.customer_note_history) && row.customer_note_history.length > 0) {
          task.customer_note_history = row.customer_note_history;
        }
        if (row.reasons && row.reasons.length > 0) task.reasons = row.reasons;
        task.manually_moved = row.manually_moved === true;
        task.is_finished = (row as any).is_finished === true;
        if (row.priority) task.priority = row.priority;
        if (row.start_time) task.start_time = row.start_time;
        if (row.end_time) task.end_time = row.end_time;
        if (row.followup !== null) task.followup = row.followup;
        if (row.sequence !== null) task.sequence = row.sequence;
        if (row.travel_time !== null) task.travel_time = row.travel_time;
        const cw = Number((row as any).checkout_wait_minutes ?? 0);
        if (cw > 0) task.checkout_wait_minutes = cw;
        if ((row as any).logistics_task_kind != null) {
          task.logistics_task_kind = String((row as any).logistics_task_kind);
        }
        if ((row as any).logistics_task_kind_source != null) {
          task.logistics_task_kind_source = String((row as any).logistics_task_kind_source);
        }

        const cleanerCtx = cleanerContextByTaskId.get(Number(row.task_id));
        attachCleanerContextFields(task, cleanerCtx);

        const enrichedTask = enrichLogisticsTimelineTask(
          task,
          cleanerCtx?.cleanerId ?? null,
          cleanerCtx?.cleanerSequence ?? null
        );
        attachLogisticsTaskWindowFields(enrichedTask, cleanerCtx);
        enrichedTasksById.set(Number(row.task_id), enrichedTask);
        driverMap.get(row.driver_id)!.tasks.push(enrichedTask);
      }

      try {
        const kindPatches = buildLogisticsContainerAutoKindPatches(rows, enrichedTasksById);
        const synced = await syncLogisticsTimelineAutoKinds(workDate, kindPatches);
        if (synced > 0) {
          console.log(`✅ PG: Sincronizzati ${synced} logistics_task_kind auto su lg_timeline per ${workDate}`);
        }
      } catch (syncError) {
        console.error('⚠️ PG: Errore sync logistics_task_kind su lg_timeline:', syncError);
      }

      const drivers_assignments = Array.from(driverMap.values()).map((da) => ({
        ...da,
        tasks: da.tasks.sort((a, b) => (a.sequence || 0) - (b.sequence || 0)),
      }));
      const totalTasks = drivers_assignments.reduce((sum, da) => sum + da.tasks.length, 0);
      return {
        drivers_assignments,
        metadata: {
          date: workDate,
          last_updated: new Date().toISOString(),
          source: 'postgresql_logistics',
        },
        meta: {
          total_drivers: drivers_assignments.length,
          used_drivers: drivers_assignments.filter((d) => d.tasks.length > 0).length,
          assigned_tasks: totalTasks,
        },
      };
    } catch (error) {
      console.error('❌ PG Logistics: loadLogisticsTimeline', error);
      return null;
    }
  }

  async saveLogisticsTimelineToHistory(
    workDate: string,
    timeline: any,
    createdBy: string = 'system',
    modificationType: string = 'manual',
    editedFields: string[] = [],
    oldValues: string[] = [],
    newValues: string[] = []
  ): Promise<number> {
    const client = await pool.connect();
    try {
      const { enrichLogisticsTimelineData } = await import("./logistics-task-kind-enrichment");
      await enrichLogisticsTimelineData(workDate, timeline);

      const rows = this.logisticsTimelineToRows(workDate, timeline);
      await client.query('BEGIN');
      await client.query(
        'SELECT 1 FROM lg_timeline_revision WHERE work_date = $1 FOR UPDATE',
        [workDate]
      );
      const revResult = await client.query(
        'SELECT COALESCE(MAX(revision), 0) + 1 as next_revision FROM lg_timeline_revision WHERE work_date = $1',
        [workDate]
      );
      const revision = parseInt(revResult.rows[0]?.next_revision || '1');
      await client.query(
        `
        INSERT INTO lg_timeline_revision (work_date, revision, task_count, created_by, modification_type, edited_fields, old_values, new_values)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
        [workDate, revision, rows.length, createdBy, modificationType, editedFields, oldValues, newValues]
      );
      for (const row of rows) {
        await client.query(
          `
          INSERT INTO lg_timeline_history (
            work_date, revision, driver_id, driver_name, driver_lastname, driver_role, driver_premium, driver_start_time, driver_end_time,
            task_id, logistic_code, client_id,
            premium, address, lat, lng, cleaning_time, base_cleaning_time,
            checkin_date, checkout_date, checkin_time, checkout_time,
            pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
            type_apt, alias, customer_name, customer_reference, customer_note, customer_note_history, reasons, manually_moved, priority,
            start_time, end_time, followup, sequence, travel_time, checkout_wait_minutes,
            logistics_task_kind, logistics_task_kind_source, is_finished, created_by
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9,
            $10, $11, $12,
            $13, $14, $15, $16, $17, $18,
            $19, $20, $21, $22,
            $23, $24, $25, $26, $27, $28,
            $29, $30, $31, $32, $33, $34, $35, $36, $37,
            $38, $39, $40, $41, $42, $43,
            $44, $45, $46, $47
          )
        `,
          [
            row.work_date,
            revision,
            row.driver_id,
            row.driver_name,
            row.driver_lastname,
            row.driver_role,
            row.driver_premium,
            row.driver_start_time,
            row.driver_end_time,
            row.task_id,
            row.logistic_code,
            row.client_id,
            row.premium,
            row.address,
            row.lat,
            row.lng,
            row.cleaning_time,
            row.base_cleaning_time,
            row.checkin_date,
            row.checkout_date,
            row.checkin_time,
            row.checkout_time,
            row.pax_in,
            row.pax_out,
            row.small_equipment,
            row.operation_id,
            row.confirmed_operation,
            row.straordinaria,
            row.type_apt,
            row.alias,
            row.customer_name,
            row.customer_reference,
            row.customer_note,
            toCustomerNoteHistoryJson(row.customer_note_history),
            row.reasons,
            row.manually_moved === true,
            row.priority,
            row.start_time,
            row.end_time,
            row.followup,
            row.sequence,
            row.travel_time,
            row.checkout_wait_minutes ?? 0,
            row.logistics_task_kind,
            row.logistics_task_kind_source,
            row.is_finished === true,
            createdBy,
          ]
        );
      }
      await client.query('COMMIT');
      return revision;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ PG Logistics: saveLogisticsTimelineToHistory', error);
      throw error;
    } finally {
      client.release();
    }
  }

  // ==================== CONTAINERS (FLAT STRUCTURE) ====================

  /**
   * Load containers for a work_date
   * Reconstructs JSON structure from flat PostgreSQL rows
   * Returns same structure as create_containers.py:
   * { containers: { early_out: { tasks: [...], count: N }, high_priority: {...}, low_priority: {...} } }
   */
  async loadContainers(workDate: string, scope: string | null = 'housekeeping'): Promise<any | null> {
    try {
      const normalizedScope = this.normalizeScope(scope);
      const result = normalizedScope === 'office'
        ? await query(
            "SELECT * FROM daily_containers WHERE work_date = $1 AND scope = 'office' ORDER BY priority, task_id",
            [workDate]
          )
        : await query(
            "SELECT * FROM daily_containers WHERE work_date = $1 AND (scope = 'housekeeping' OR scope IS NULL) ORDER BY priority, task_id",
            [workDate]
          );

      if (result.rows.length === 0) {
        console.log(`📖 PG: Nessun container trovato per ${workDate}`);
        return null;
      }

      // Load lock status from daily_task_locks (source of truth)
      const locksMap = await this.getLocksMap(workDate);

      // Group rows by priority (using frontend naming: high_priority, low_priority)
      const tasksByPriority: { [key: string]: any[] } = {
        early_out: [],
        high_priority: [],
        low_priority: []
      };

      // Map DB priority names to frontend names
      const priorityMap: { [key: string]: string } = {
        'early_out': 'early_out',
        'early-out': 'early_out',
        'earlyout': 'early_out',
        'early_out_assignment': 'early_out',
        'eo': 'early_out',
        'high': 'high_priority',
        'high_priority': 'high_priority',
        'high-priority': 'high_priority',
        'highpriority': 'high_priority',
        'high_priority_assignment': 'high_priority',
        'hp': 'high_priority',
        'low': 'low_priority',
        'low_priority': 'low_priority',
        'low-priority': 'low_priority',
        'lowpriority': 'low_priority',
        'low_priority_assignment': 'low_priority',
        'lp': 'low_priority'
      };

      for (const row of result.rows) {
        const task: any = {
          task_id: row.task_id,
          logistic_code: row.logistic_code,
          priority: row.priority
        };

        // Add optional fields
        if (row.client_id) task.client_id = row.client_id;
        if (row.premium !== null) task.premium = row.premium;
        if (row.address) task.address = row.address;
        if (row.lat !== null) task.lat = String(row.lat);
        if (row.lng !== null) task.lng = String(row.lng);
        if (row.cleaning_time) task.cleaning_time = row.cleaning_time;
        task.checkin_date = normalizeDateToYmd(row.checkin_date) ?? undefined;
        task.checkout_date = normalizeDateToYmd(row.checkout_date) ?? undefined;
        if (row.checkin_time) task.checkin_time = row.checkin_time.substring(0, 5);
        if (row.checkout_time) task.checkout_time = row.checkout_time.substring(0, 5);
        if (row.pax_in !== null) task.pax_in = row.pax_in;
        if (row.pax_out !== null) task.pax_out = row.pax_out;
        if (row.small_equipment !== null) task.small_equipment = row.small_equipment;
        if (row.operation_id !== null) task.operation_id = row.operation_id;
        if (row.confirmed_operation !== null) task.confirmed_operation = row.confirmed_operation;
        if (row.straordinaria !== null) task.straordinaria = row.straordinaria;
        if (row.type_apt) task.type_apt = row.type_apt;
        if (row.alias) task.alias = row.alias;
        if (row.customer_name) task.customer_name = row.customer_name;
        if (row.customer_note) task.customer_note = row.customer_note;
        if (Array.isArray(row.customer_note_history) && row.customer_note_history.length > 0) {
          task.customer_note_history = row.customer_note_history;
        }
        if (row.reasons && row.reasons.length > 0) task.reasons = row.reasons;
        if (row.customer_reference) task.customer_reference = row.customer_reference;

        // Apply lock status from daily_task_locks (source of truth)
        const lockInfo = locksMap.get(row.task_id);
        if (lockInfo) {
          task.locked = lockInfo.locked;
          task.locked_reason = lockInfo.lockedReason;
          task.locked_by = lockInfo.lockedBy;
        } else {
          task.locked = false;
        }

        // Add to appropriate priority bucket (map DB names to frontend names)
        const dbPriority = String(row.priority || 'low').toLowerCase();
        const frontendPriority = priorityMap[dbPriority] || 'low_priority';
        tasksByPriority[frontendPriority].push(task);
      }

      // For client_id = 3, fetch customer_reference from ADAM if not already present
      const allTasks = [...tasksByPriority.early_out, ...tasksByPriority.high_priority, ...tasksByPriority.low_priority];
      const tasksNeedingRef = allTasks.filter(t => t.client_id === 3 && !t.customer_reference);
      
      if (tasksNeedingRef.length > 0) {
        try {
          const mysql = await import('mysql2/promise');
          const adamConnection = await mysql.createConnection({
            host: databaseConfig.mysql.host,
            port: databaseConfig.mysql.port,
            user: databaseConfig.mysql.user,
            password: databaseConfig.mysql.password,
            database: databaseConfig.mysql.database,
          });
          
          const logisticCodes = tasksNeedingRef.map(t => t.logistic_code);
          const [rows] = await adamConnection.execute(
            `SELECT logistic_code, customer_structure_reference 
             FROM app_structures 
             WHERE logistic_code IN (${logisticCodes.map(() => '?').join(',')})`,
            logisticCodes
          );
          
          const refMap = new Map<number, string>();
          for (const row of rows as any[]) {
            if (row.customer_structure_reference) {
              refMap.set(row.logistic_code, row.customer_structure_reference);
            }
          }
          
          for (const task of tasksNeedingRef) {
            const ref = refMap.get(task.logistic_code);
            if (ref) task.customer_reference = ref;
          }
          
          await adamConnection.end();
        } catch (adamError) {
          console.error('⚠️ PG: Errore nel caricamento customer_reference da ADAM:', adamError);
        }
      }

      // Build structure matching create_containers.py format
      this.annotateActiveDuplicateMetadata(tasksByPriority);
      this.sortContainerBucketsLockedLast(tasksByPriority);

      const containers = {
        early_out: {
          tasks: tasksByPriority.early_out,
          count: tasksByPriority.early_out.length
        },
        high_priority: {
          tasks: tasksByPriority.high_priority,
          count: tasksByPriority.high_priority.length
        },
        low_priority: {
          tasks: tasksByPriority.low_priority,
          count: tasksByPriority.low_priority.length
        }
      };

      const totalTasks = containers.early_out.count + containers.high_priority.count + containers.low_priority.count;
      console.log(`✅ PG: Containers caricati per ${workDate} (${totalTasks} task)`);

      return { 
        containers,
        summary: {
          total_tasks: totalTasks,
          early_out: containers.early_out.count,
          high_priority: containers.high_priority.count,
          low_priority: containers.low_priority.count
        }
      };
    } catch (error) {
      console.error('❌ PG: Errore nel caricamento containers:', error);
      return null;
    }
  }

  // ==================== LOGISTICS CONTAINERS (lg_containers_*) ====================

  async loadLogisticsContainers(workDate: string): Promise<any | null> {
    try {
      await query(`ALTER TABLE IF EXISTS lg_containers ADD COLUMN IF NOT EXISTS sort_order INTEGER`);
      try {
        await this.ensureDefaultLocksForAdamLogisticCode1741(workDate);
      } catch (lockError) {
        console.warn('⚠️ PG: ensureDefaultLocksForAdamLogisticCode1741 a load:', lockError);
      }
      const result = await query(
        'SELECT * FROM lg_containers WHERE work_date = $1 ORDER BY priority, sort_order NULLS LAST, task_id',
        [workDate]
      );

      if (result.rows.length === 0) {
        console.log(`📖 PG: Nessun logistics container trovato per ${workDate}`);
        return null;
      }

      const locksMap = await this.getLocksMap(workDate);
      const taskIds = result.rows.map((row: any) => Number(row.task_id)).filter((id) => Number.isFinite(id));
      const {
        loadCleanerContextByTaskIds,
        enrichLogisticsContainerTask,
        syncLogisticsContainerAutoKinds,
        attachCleanerContextFields,
      } = await import("./logistics-task-kind-enrichment");
      const { buildLogisticsContainerAutoKindPatches } = await import(
        "../../shared/logistics-task-kind"
      );
      const cleanerContextByTaskId = await loadCleanerContextByTaskIds(workDate, taskIds);
      const enrichedTasksById = new Map<number, any>();

      const tasksByPriority: { [key: string]: any[] } = {
        early_out: [],
        high_priority: [],
        low_priority: []
      };

      const priorityMap: { [key: string]: string } = {
        'early_out': 'early_out',
        'early-out': 'early_out',
        'earlyout': 'early_out',
        'early_out_assignment': 'early_out',
        'eo': 'early_out',
        'high': 'high_priority',
        'high_priority': 'high_priority',
        'high-priority': 'high_priority',
        'highpriority': 'high_priority',
        'high_priority_assignment': 'high_priority',
        'hp': 'high_priority',
        'low': 'low_priority',
        'low_priority': 'low_priority',
        'low-priority': 'low_priority',
        'lowpriority': 'low_priority',
        'low_priority_assignment': 'low_priority',
        'lp': 'low_priority'
      };

      for (const row of result.rows) {
        const task: any = {
          task_id: row.task_id,
          logistic_code: row.logistic_code,
          priority: row.priority
        };
        if (row.sort_order !== null) task.sort_order = row.sort_order;
        if (row.client_id) task.client_id = row.client_id;
        if (row.premium !== null) task.premium = row.premium;
        if (row.address) task.address = row.address;
        if (row.lat !== null) task.lat = String(row.lat);
        if (row.lng !== null) task.lng = String(row.lng);
        if (row.cleaning_time) task.cleaning_time = row.cleaning_time;
        task.checkin_date = normalizeDateToYmd(row.checkin_date) ?? undefined;
        task.checkout_date = normalizeDateToYmd(row.checkout_date) ?? undefined;
        if (row.checkin_time) task.checkin_time = row.checkin_time.substring(0, 5);
        if (row.checkout_time) task.checkout_time = row.checkout_time.substring(0, 5);
        if (row.pax_in !== null) task.pax_in = row.pax_in;
        if (row.pax_out !== null) task.pax_out = row.pax_out;
        if (row.small_equipment !== null) task.small_equipment = row.small_equipment;
        if (row.operation_id !== null) task.operation_id = row.operation_id;
        if (row.confirmed_operation !== null) task.confirmed_operation = row.confirmed_operation;
        if (row.straordinaria !== null) task.straordinaria = row.straordinaria;
        if (row.type_apt) task.type_apt = row.type_apt;
        if (row.alias) task.alias = row.alias;
        if (row.customer_name) task.customer_name = row.customer_name;
        if (row.customer_note) task.customer_note = row.customer_note;
        if (Array.isArray(row.customer_note_history) && row.customer_note_history.length > 0) {
          task.customer_note_history = row.customer_note_history;
        }
        if (row.reasons && row.reasons.length > 0) task.reasons = row.reasons;
        if (row.customer_reference) task.customer_reference = row.customer_reference;
        if (row.logistics_task_kind != null) {
          task.logistics_task_kind = String(row.logistics_task_kind);
        }
        if (row.logistics_task_kind_source != null) {
          task.logistics_task_kind_source = String(row.logistics_task_kind_source);
        }

        const cleanerCtx = cleanerContextByTaskId.get(Number(row.task_id));
        attachCleanerContextFields(task, cleanerCtx);

        const enrichedTask = enrichLogisticsContainerTask(
          task,
          cleanerCtx?.cleanerId ?? null,
          cleanerCtx?.cleanerSequence ?? null
        );
        enrichedTasksById.set(Number(row.task_id), enrichedTask);

        const lockInfo = locksMap.get(row.task_id);
        if (lockInfo) {
          enrichedTask.locked = lockInfo.locked;
          enrichedTask.locked_reason = lockInfo.lockedReason;
          enrichedTask.locked_by = lockInfo.lockedBy;
        } else {
          enrichedTask.locked = row.locked || false;
          enrichedTask.locked_reason = row.locked_reason || undefined;
        }

        const dbPriority = String(row.priority || 'low').toLowerCase();
        const frontendPriority = priorityMap[dbPriority] || 'low_priority';
        tasksByPriority[frontendPriority].push(enrichedTask);
      }

      try {
        const kindPatches = buildLogisticsContainerAutoKindPatches(result.rows, enrichedTasksById);
        const synced = await syncLogisticsContainerAutoKinds(workDate, kindPatches);
        if (synced > 0) {
          console.log(`✅ PG: Sincronizzati ${synced} logistics_task_kind auto su lg_containers per ${workDate}`);
        }
      } catch (syncError) {
        console.error('⚠️ PG: Errore sync logistics_task_kind su lg_containers:', syncError);
      }

      const allTasks = [...tasksByPriority.early_out, ...tasksByPriority.high_priority, ...tasksByPriority.low_priority];
      const tasksNeedingRef = allTasks.filter(t => t.client_id === 3 && !t.customer_reference);
      if (tasksNeedingRef.length > 0) {
        try {
          const mysql = await import('mysql2/promise');
          const adamConnection = await mysql.createConnection({
            host: databaseConfig.mysql.host,
            port: databaseConfig.mysql.port,
            user: databaseConfig.mysql.user,
            password: databaseConfig.mysql.password,
            database: databaseConfig.mysql.database,
          });
          const logisticCodes = tasksNeedingRef.map(t => t.logistic_code);
          const [rows] = await adamConnection.execute(
            `SELECT logistic_code, customer_structure_reference 
             FROM app_structures 
             WHERE logistic_code IN (${logisticCodes.map(() => '?').join(',')})`,
            logisticCodes
          );
          const refMap = new Map<number, string>();
          for (const row of rows as any[]) {
            if (row.customer_structure_reference) {
              refMap.set(row.logistic_code, row.customer_structure_reference);
            }
          }
          for (const task of tasksNeedingRef) {
            const ref = refMap.get(task.logistic_code);
            if (ref) task.customer_reference = ref;
          }
          await adamConnection.end();
        } catch (adamError) {
          console.error('⚠️ PG: Errore customer_reference ADAM (logistics):', adamError);
        }
      }

      this.annotateActiveDuplicateMetadata(tasksByPriority);
      this.sortContainerBucketsLockedLast(tasksByPriority);

      const containers = {
        early_out: { tasks: tasksByPriority.early_out, count: tasksByPriority.early_out.length },
        high_priority: { tasks: tasksByPriority.high_priority, count: tasksByPriority.high_priority.length },
        low_priority: { tasks: tasksByPriority.low_priority, count: tasksByPriority.low_priority.length }
      };
      const totalTasks = containers.early_out.count + containers.high_priority.count + containers.low_priority.count;
      console.log(`✅ PG: Logistics containers caricati per ${workDate} (${totalTasks} task)`);
      return {
        containers,
        summary: {
          total_tasks: totalTasks,
          early_out: containers.early_out.count,
          high_priority: containers.high_priority.count,
          low_priority: containers.low_priority.count
        }
      };
    } catch (error) {
      console.error('❌ PG: Errore nel caricamento logistics containers:', error);
      return null;
    }
  }

  /**
   * Save containers for a work_date
   * Converts JSON structure to flat PostgreSQL rows
   * Accepts both formats:
   * - create_containers.py: { containers: { early_out: { tasks: [...] }, high_priority: {...}, low_priority: {...} } }
   * - simplified: { containers: { early_out: [...], high: [...], low: [...] } }
   */
  async saveContainers(workDate: string, containersData: any, scope: string | null = 'housekeeping'): Promise<boolean> {
    const client = await pool.connect();

    try {
      const normalizedScope = this.normalizeScope(scope);
      await client.query('BEGIN');

      // Delete existing containers for this date
      if (normalizedScope === 'office') {
        await client.query("DELETE FROM daily_containers WHERE work_date = $1 AND scope = 'office'", [workDate]);
      } else {
        await client.query("DELETE FROM daily_containers WHERE work_date = $1 AND (scope = 'housekeeping' OR scope IS NULL)", [workDate]);
      }

      const containers = containersData?.containers || {};
      let totalInserted = 0;

      // Define priority mappings (support both naming conventions)
      const priorityConfigs = [
        { dbName: 'early_out', keys: ['early_out'] },
        { dbName: 'high_priority', keys: ['high_priority', 'high'] },
        { dbName: 'low_priority', keys: ['low_priority', 'low'] }
      ];

      for (const config of priorityConfigs) {
        // Find tasks for this priority (check all possible keys)
        let tasks: any[] = [];
        for (const key of config.keys) {
          const containerData = containers[key];
          if (containerData) {
            // Handle both formats: { tasks: [...] } or direct array
            tasks = Array.isArray(containerData) ? containerData : (containerData.tasks || []);
            break;
          }
        }

        for (const task of tasks) {
          if (!task.task_id) continue;

          await client.query(`
            INSERT INTO daily_containers (
              scope,
              work_date, priority,
              task_id, logistic_code, client_id, premium, address, lat, lng,
              cleaning_time, checkin_date, checkout_date, checkin_time, checkout_time,
              pax_in, pax_out, small_equipment, operation_id, confirmed_operation,
              straordinaria, type_apt, alias, customer_name, customer_note, customer_note_history, reasons, customer_reference,
              locked, locked_reason
            ) VALUES (
              $1,
              $2, $3, $4, $5, $6, $7, $8, $9, $10,
              $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
              $21, $22, $23, $24, $25, $26, $27, $28, $29, $30
            )
          `, [
            normalizedScope,
            workDate,
            config.dbName,
            task.task_id,
            task.logistic_code || 0,
            task.client_id || null,
            task.premium || false,
            task.address || null,
            task.lat || null,
            task.lng || null,
            task.cleaning_time || 0,
            // CRITICAL: always persist date-only strings (avoid timezone day-shifts)
            normalizeDateToYmd(task.checkin_date),
            normalizeDateToYmd(task.checkout_date),
            task.checkin_time || null,
            task.checkout_time || null,
            task.pax_in ?? null,
            task.pax_out ?? null,
            task.small_equipment || false,
            task.operation_id ?? null,
            task.confirmed_operation || false,
            task.straordinaria || false,
            task.type_apt || null,
            task.alias || null,
            task.customer_name || null,
            task.customer_note != null ? String(task.customer_note) : null,
            toCustomerNoteHistoryJson(task.customer_note_history),
            task.reasons || [],
            task.customer_reference || null,
            task.locked || false,
            task.locked_reason || null
          ]);

          totalInserted++;
        }
      }

      await client.query('COMMIT');
      console.log(`✅ PG: Containers salvati per ${workDate} (${totalInserted} task)`);
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ PG: Errore nel salvataggio containers:', error);
      return false;
    } finally {
      client.release();
    }
  }

  async saveLogisticsContainers(workDate: string, containersData: any): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query(`ALTER TABLE IF EXISTS lg_containers ADD COLUMN IF NOT EXISTS sort_order INTEGER`);
      const containers = containersData?.containers || {};
      const priorityConfigs = [
        { dbName: 'early_out', keys: ['early_out'] },
        { dbName: 'high_priority', keys: ['high_priority', 'high'] },
        { dbName: 'low_priority', keys: ['low_priority', 'low'] }
      ];

      const tasksWithPriority: Array<{ dbName: string; task: any }> = [];
      for (const config of priorityConfigs) {
        let tasks: any[] = [];
        for (const key of config.keys) {
          const containerData = containers[key];
          if (containerData) {
            tasks = Array.isArray(containerData) ? containerData : (containerData.tasks || []);
            break;
          }
        }
        tasks.forEach((task, index) => {
          if (task?.task_id) {
            tasksWithPriority.push({ dbName: config.dbName, task: { ...task, sort_order: index } });
          }
        });
      }

      const taskIds = tasksWithPriority
        .map(({ task }) => Number(task.task_id))
        .filter((id) => Number.isFinite(id));
      const {
        loadCleanerContextByTaskIds,
        loadManualLogisticsContainerTaskKinds,
        enrichLogisticsContainerTask,
      } = await import("./logistics-task-kind-enrichment");
      const [cleanerContextByTaskId, manualKindsByTaskId] = await Promise.all([
        loadCleanerContextByTaskIds(workDate, taskIds),
        loadManualLogisticsContainerTaskKinds(workDate),
      ]);

      await client.query('BEGIN');
      await client.query('DELETE FROM lg_containers WHERE work_date = $1', [workDate]);

      let totalInserted = 0;
      for (const { dbName, task } of tasksWithPriority) {
        const taskId = Number(task.task_id);
        const manualKind = manualKindsByTaskId.get(taskId);
        const taskForPersist =
          manualKind && task.logistics_task_kind_source !== "manual"
            ? { ...task, ...manualKind }
            : task;
        const cleanerCtx = cleanerContextByTaskId.get(taskId);
        const enrichedTask = enrichLogisticsContainerTask(
          taskForPersist,
          cleanerCtx?.cleanerId ?? null,
          cleanerCtx?.cleanerSequence ?? null
        );

        await client.query(`
            INSERT INTO lg_containers (
              work_date, priority, sort_order,
              task_id, logistic_code, client_id, premium, address, lat, lng,
              cleaning_time, checkin_date, checkout_date, checkin_time, checkout_time,
              pax_in, pax_out, small_equipment, operation_id, confirmed_operation,
              straordinaria, type_apt, alias, customer_name, customer_note, customer_note_history, reasons, customer_reference,
              locked, locked_reason, logistics_task_kind, logistics_task_kind_source
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
              $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
              $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32
            )
          `, [
            workDate,
            dbName,
            enrichedTask.sort_order ?? 0,
            enrichedTask.task_id,
            enrichedTask.logistic_code || 0,
            enrichedTask.client_id || null,
            enrichedTask.premium || false,
            enrichedTask.address || null,
            enrichedTask.lat || null,
            enrichedTask.lng || null,
            enrichedTask.cleaning_time || 0,
            normalizeDateToYmd(enrichedTask.checkin_date),
            normalizeDateToYmd(enrichedTask.checkout_date),
            enrichedTask.checkin_time || null,
            enrichedTask.checkout_time || null,
            enrichedTask.pax_in ?? null,
            enrichedTask.pax_out ?? null,
            enrichedTask.small_equipment || false,
            enrichedTask.operation_id ?? null,
            enrichedTask.confirmed_operation || false,
            enrichedTask.straordinaria || false,
            enrichedTask.type_apt || null,
            enrichedTask.alias || null,
            enrichedTask.customer_name || null,
            enrichedTask.customer_note != null ? String(enrichedTask.customer_note) : null,
            toCustomerNoteHistoryJson(enrichedTask.customer_note_history),
            enrichedTask.reasons || [],
            enrichedTask.customer_reference || null,
            enrichedTask.locked || false,
            enrichedTask.locked_reason || null,
            enrichedTask.logistics_task_kind != null
              ? String(enrichedTask.logistics_task_kind)
              : null,
            enrichedTask.logistics_task_kind_source != null
              ? String(enrichedTask.logistics_task_kind_source)
              : null,
          ]);
        totalInserted++;
      }

      await client.query('COMMIT');
      console.log(`✅ PG: Logistics containers salvati per ${workDate} (${totalInserted} task)`);
      try {
        await this.ensureDefaultLocksForAdamLogisticCode1741(workDate);
      } catch (lockError) {
        console.warn('⚠️ PG: ensureDefaultLocksForAdamLogisticCode1741 dopo save:', lockError);
      }
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ PG: Errore nel salvataggio logistics containers:', error);
      return false;
    } finally {
      client.release();
    }
  }

  /**
   * Task con codice ADAM 1741: locked di default.
   * Crea il record in daily_task_locks solo se non esiste già (così uno sblocco manuale resta).
   */
  async ensureDefaultLocksForAdamLogisticCode1741(workDate: string): Promise<number> {
    await this.ensureTaskLocksTable();
    const reason = "Codice ADAM 1741 (lock automatico)";

    const insertResult = await query(
      `
        INSERT INTO daily_task_locks (work_date, task_id, locked, locked_reason, locked_by, updated_at)
        SELECT $1, task_id, true, $2, 'system', NOW()
        FROM (
          SELECT DISTINCT task_id
          FROM (
            SELECT task_id
            FROM lg_containers
            WHERE work_date = $1 AND CAST(logistic_code AS TEXT) = '1741'
            UNION
            SELECT task_id
            FROM lg_timeline
            WHERE work_date = $1 AND CAST(logistic_code AS TEXT) = '1741'
          ) src
          WHERE task_id IS NOT NULL
        ) t
        ON CONFLICT (work_date, task_id) DO NOTHING
      `,
      [workDate, reason]
    );

    await query(
      `
        UPDATE lg_containers c
        SET locked = true,
            locked_reason = $2,
            updated_at = NOW()
        FROM daily_task_locks l
        WHERE c.work_date = l.work_date
          AND c.task_id = l.task_id
          AND c.work_date = $1
          AND l.locked = true
          AND CAST(c.logistic_code AS TEXT) = '1741'
      `,
      [workDate, reason]
    );

    const lockedCount = insertResult.rowCount ?? 0;
    if (lockedCount > 0) {
      console.log(
        `🔒 PG: Auto-lock codice ADAM 1741 per ${workDate}: ${lockedCount} nuovi lock`
      );
    }
    return lockedCount;
  }

  async updateLogisticsContainerTaskKind(
    workDate: string,
    taskId: number,
    kind: string,
    source: string,
    createdBy: string = "system"
  ): Promise<{ success: boolean; previousKind: string | null }> {
    const existing = await query(
      `SELECT logistics_task_kind FROM lg_containers WHERE work_date = $1 AND task_id = $2`,
      [workDate, taskId]
    );
    if (existing.rows.length === 0) {
      return { success: false, previousKind: null };
    }

    const previousKind =
      existing.rows[0].logistics_task_kind != null
        ? String(existing.rows[0].logistics_task_kind)
        : null;

    await this.saveLogisticsContainersToHistory(workDate, createdBy, "manual");
    await query(
      `
        UPDATE lg_containers
        SET logistics_task_kind = $1,
            logistics_task_kind_source = $2,
            updated_at = NOW()
        WHERE work_date = $3 AND task_id = $4
      `,
      [kind, source, workDate, taskId]
    );

    return { success: true, previousKind };
  }

  /**
   * Move a task from containers to assignments (when assigned to a cleaner)
   */
  async moveTaskToAssignment(workDate: string, taskId: number): Promise<boolean> {
    try {
      await query('DELETE FROM daily_containers WHERE work_date = $1 AND task_id = $2', [workDate, taskId]);
      console.log(`✅ PG: Task ${taskId} rimosso dai containers per ${workDate}`);
      return true;
    } catch (error) {
      console.error('❌ PG: Errore nella rimozione task da containers:', error);
      return false;
    }
  }

  /**
   * Move a task from assignments back to containers (when unassigned)
   */
  async moveTaskToContainer(workDate: string, task: any, priority: string): Promise<boolean> {
    try {
      await query(`
        INSERT INTO daily_containers (
          work_date, priority,
          task_id, logistic_code, client_id, premium, address, lat, lng,
          cleaning_time, checkin_date, checkout_date, checkin_time, checkout_time,
          pax_in, pax_out, small_equipment, operation_id, confirmed_operation,
          straordinaria, type_apt, alias, customer_name, customer_note, customer_note_history, reasons, customer_reference,
          locked, locked_reason
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
          $20, $21, $22, $23, $24, $25, $26, $27, $28, $29
        )
        ON CONFLICT (work_date, task_id) DO NOTHING
      `, [
        workDate,
        priority,
        task.task_id,
        task.logistic_code || 0,
        task.client_id || null,
        task.premium || false,
        task.address || null,
        task.lat || null,
        task.lng || null,
        task.cleaning_time || 0,
        task.checkin_date || null,
        task.checkout_date || null,
        task.checkin_time || null,
        task.checkout_time || null,
        task.pax_in ?? null,
        task.pax_out ?? null,
        task.small_equipment || false,
        task.operation_id ?? null,
        task.confirmed_operation || false,
        task.straordinaria || false,
        task.type_apt || null,
        task.alias || null,
        task.customer_name || null,
        task.customer_note != null ? String(task.customer_note) : null,
        toCustomerNoteHistoryJson(task.customer_note_history),
        task.reasons || [],
        task.customer_reference || null,
        task.locked || false,
        task.locked_reason || null
      ]);

      console.log(`✅ PG: Task ${task.task_id} aggiunto ai containers (${priority}) per ${workDate}`);
      return true;
    } catch (error) {
      console.error('❌ PG: Errore nell\'aggiunta task a containers:', error);
      return false;
    }
  }

  // ==================== CONTAINERS HISTORY (UNDO/ROLLBACK) ====================

  /**
   * Save current containers state to history before making changes
   * Creates a new revision with all current container tasks
   */
  async saveContainersToHistory(
    workDate: string,
    createdBy: string = 'system',
    modificationType: string = 'manual'
  ): Promise<number> {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Lock revisions table to prevent race conditions
      await client.query(
        'SELECT 1 FROM daily_containers_revisions WHERE work_date = $1 FOR UPDATE',
        [workDate]
      );

      // Get next revision number
      const revResult = await client.query(
        'SELECT COALESCE(MAX(revision), 0) + 1 as next_revision FROM daily_containers_revisions WHERE work_date = $1',
        [workDate]
      );
      const revision = parseInt(revResult.rows[0]?.next_revision || '1');

      // Get current containers
      const currentContainers = await client.query(
        'SELECT * FROM daily_containers WHERE work_date = $1',
        [workDate]
      );

      console.log(`📜 PG Containers History: Salvando revisione ${revision} con ${currentContainers.rows.length} task per ${workDate}...`);

      // Create revision metadata entry
      await client.query(`
        INSERT INTO daily_containers_revisions (work_date, revision, task_count, created_by, modification_type)
        VALUES ($1, $2, $3, $4, $5)
      `, [workDate, revision, currentContainers.rows.length, createdBy, modificationType]);

      // Copy current containers to history
      for (const row of currentContainers.rows) {
        await client.query(`
          INSERT INTO daily_containers_history (
            work_date, revision, priority,
            task_id, logistic_code, client_id, premium, address, lat, lng,
            cleaning_time, checkin_date, checkout_date, checkin_time, checkout_time,
            pax_in, pax_out, small_equipment, operation_id, confirmed_operation,
            straordinaria, type_apt, alias, customer_name, customer_note, customer_note_history, reasons, created_by,
            locked, locked_reason
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
            $21, $22, $23, $24, $25, $26, $27, $28, $29, $30
          )
        `, [
          workDate,
          revision,
          row.priority,
          row.task_id,
          row.logistic_code,
          row.client_id,
          row.premium,
          row.address,
          row.lat,
          row.lng,
          row.cleaning_time,
          row.checkin_date,
          row.checkout_date,
          row.checkin_time,
          row.checkout_time,
          row.pax_in,
          row.pax_out,
          row.small_equipment,
          row.operation_id,
          row.confirmed_operation,
          row.straordinaria,
          row.type_apt,
          row.alias,
          row.customer_name,
          row.customer_note ?? null,
          toCustomerNoteHistoryJson(row.customer_note_history),
          row.reasons || [],
          createdBy,
          row.locked || false,
          row.locked_reason || null
        ]);
      }

      await client.query('COMMIT');
      console.log(`✅ PG Containers History: Salvata revisione ${revision} con ${currentContainers.rows.length} task`);
      return revision;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ PG Containers History: Errore nel salvataggio:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get list of container revisions for a work_date
   */
  async getContainersRevisions(workDate: string): Promise<any[]> {
    try {
      const result = await query(
        `SELECT revision, task_count, created_at, created_by, modification_type 
         FROM daily_containers_revisions 
         WHERE work_date = $1 
         ORDER BY revision DESC`,
        [workDate]
      );
      return result.rows;
    } catch (error) {
      console.error('❌ PG Containers History: Errore nel caricamento revisioni:', error);
      return [];
    }
  }

  /**
   * Get containers state at a specific revision
   */
  async getContainersAtRevision(workDate: string, revision: number): Promise<any | null> {
    try {
      const result = await query(
        'SELECT * FROM daily_containers_history WHERE work_date = $1 AND revision = $2 ORDER BY priority, task_id',
        [workDate, revision]
      );

      if (result.rows.length === 0) {
        return null;
      }

      // Reconstruct containers structure
      const containers: { [key: string]: any[] } = {
        early_out: [],
        high: [],
        low: []
      };

      for (const row of result.rows) {
        const task: any = {
          task_id: row.task_id,
          logistic_code: row.logistic_code,
          priority: row.priority,
          client_id: row.client_id,
          premium: row.premium,
          address: row.address,
          lat: row.lat,
          lng: row.lng,
          cleaning_time: row.cleaning_time,
          checkin_date: row.checkin_date,
          checkout_date: row.checkout_date,
          checkin_time: row.checkin_time,
          checkout_time: row.checkout_time,
          pax_in: row.pax_in,
          pax_out: row.pax_out,
          small_equipment: row.small_equipment,
          operation_id: row.operation_id,
          confirmed_operation: row.confirmed_operation,
          straordinaria: row.straordinaria,
          type_apt: row.type_apt,
          alias: row.alias,
          customer_name: row.customer_name,
          customer_note: row.customer_note,
          customer_note_history: normalizeCustomerNoteHistory(row.customer_note_history),
          reasons: row.reasons || [],
          locked: row.locked || false,
          locked_reason: row.locked_reason || null
        };

        const priority = row.priority || 'low';
        if (!containers[priority]) containers[priority] = [];
        containers[priority].push(task);
      }

      return { containers };
    } catch (error) {
      console.error('❌ PG Containers History: Errore nel caricamento revisione:', error);
      return null;
    }
  }

  /**
   * Restore containers from a specific revision (for undo)
   * Replaces current containers with the state from the given revision
   */
  async restoreContainersFromRevision(workDate: string, revision: number, createdBy: string = 'system'): Promise<boolean> {
    const client = await pool.connect();

    try {
      // First, save current state to history (so we can redo if needed)
      await this.saveContainersToHistory(workDate, createdBy, 'pre_restore');

      await client.query('BEGIN');

      // Get containers at the target revision
      const historyResult = await client.query(
        'SELECT * FROM daily_containers_history WHERE work_date = $1 AND revision = $2',
        [workDate, revision]
      );

      if (historyResult.rows.length === 0) {
        console.log(`⚠️ PG Containers: Nessun dato trovato per revisione ${revision}`);
        await client.query('ROLLBACK');
        return false;
      }

      // Delete current containers
      await client.query('DELETE FROM daily_containers WHERE work_date = $1', [workDate]);

      // Restore from history
      for (const row of historyResult.rows) {
        await client.query(`
          INSERT INTO daily_containers (
            work_date, priority,
            task_id, logistic_code, client_id, premium, address, lat, lng,
            cleaning_time, checkin_date, checkout_date, checkin_time, checkout_time,
            pax_in, pax_out, small_equipment, operation_id, confirmed_operation,
            straordinaria, type_apt, alias, customer_name, customer_note, customer_note_history, reasons,
            locked, locked_reason
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9,
            $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
            $20, $21, $22, $23, $24, $25, $26, $27, $28
          )
        `, [
          workDate,
          row.priority,
          row.task_id,
          row.logistic_code,
          row.client_id,
          row.premium,
          row.address,
          row.lat,
          row.lng,
          row.cleaning_time,
          row.checkin_date,
          row.checkout_date,
          row.checkin_time,
          row.checkout_time,
          row.pax_in,
          row.pax_out,
          row.small_equipment,
          row.operation_id,
          row.confirmed_operation,
          row.straordinaria,
          row.type_apt,
          row.alias,
          row.customer_name,
          row.customer_note ?? null,
          toCustomerNoteHistoryJson(row.customer_note_history),
          row.reasons || [],
          row.locked || false,
          row.locked_reason || null
        ]);
      }

      await client.query('COMMIT');
      console.log(`✅ PG Containers: Ripristinati ${historyResult.rows.length} task dalla revisione ${revision}`);
      return true;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ PG Containers: Errore nel ripristino:', error);
      return false;
    } finally {
      client.release();
    }
  }

  // ==================== LOGISTICS CONTAINERS HISTORY ====================

  async saveLogisticsContainersToHistory(
    workDate: string,
    createdBy: string = 'system',
    modificationType: string = 'manual'
  ): Promise<number> {
    const client = await pool.connect();
    try {
      const { persistLogisticsContainerAutoKindsForDate } = await import(
        "./logistics-task-kind-enrichment"
      );
      try {
        const synced = await persistLogisticsContainerAutoKindsForDate(workDate);
        if (synced > 0) {
          console.log(
            `✅ PG Logistics History: allineati ${synced} logistics_task_kind auto su lg_containers per ${workDate}`
          );
        }
      } catch (syncError) {
        console.error('⚠️ PG Logistics History: errore sync logistics_task_kind containers:', syncError);
      }

      await client.query('BEGIN');
      await client.query(`ALTER TABLE IF EXISTS lg_containers ADD COLUMN IF NOT EXISTS sort_order INTEGER`);
      await client.query(`ALTER TABLE IF EXISTS lg_containers_history ADD COLUMN IF NOT EXISTS sort_order INTEGER`);
      await client.query(
        'SELECT 1 FROM lg_containers_revision WHERE work_date = $1 FOR UPDATE',
        [workDate]
      );
      const revResult = await client.query(
        'SELECT COALESCE(MAX(revision), 0) + 1 as next_revision FROM lg_containers_revision WHERE work_date = $1',
        [workDate]
      );
      const revision = parseInt(revResult.rows[0]?.next_revision || '1');
      const currentContainers = await client.query(
        'SELECT * FROM lg_containers WHERE work_date = $1',
        [workDate]
      );
      console.log(`📜 PG Logistics History: revisione ${revision}, ${currentContainers.rows.length} task per ${workDate}...`);
      await client.query(`
        INSERT INTO lg_containers_revision (work_date, revision, task_count, created_by, modification_type)
        VALUES ($1, $2, $3, $4, $5)
      `, [workDate, revision, currentContainers.rows.length, createdBy, modificationType]);

      for (const row of currentContainers.rows) {
        await client.query(`
          INSERT INTO lg_containers_history (
            work_date, revision, priority, sort_order,
            task_id, logistic_code, client_id, premium, address, lat, lng,
            cleaning_time, checkin_date, checkout_date, checkin_time, checkout_time,
            pax_in, pax_out, small_equipment, operation_id, confirmed_operation,
            straordinaria, type_apt, alias, customer_name, customer_note, customer_note_history, reasons, customer_reference, created_by,
            locked, locked_reason, logistics_task_kind, logistics_task_kind_source
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
            $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34
          )
        `, [
          workDate,
          revision,
          row.priority,
          row.sort_order ?? null,
          row.task_id,
          row.logistic_code,
          row.client_id,
          row.premium,
          row.address,
          row.lat,
          row.lng,
          row.cleaning_time,
          row.checkin_date,
          row.checkout_date,
          row.checkin_time,
          row.checkout_time,
          row.pax_in,
          row.pax_out,
          row.small_equipment,
          row.operation_id,
          row.confirmed_operation,
          row.straordinaria,
          row.type_apt,
          row.alias,
          row.customer_name,
          row.customer_note ?? null,
          toCustomerNoteHistoryJson(row.customer_note_history),
          row.reasons || [],
          row.customer_reference ?? null,
          createdBy,
          row.locked || false,
          row.locked_reason || null,
          row.logistics_task_kind ?? null,
          row.logistics_task_kind_source ?? null,
        ]);
      }
      await client.query('COMMIT');
      console.log(`✅ PG Logistics History: revisione ${revision} salvata`);
      return revision;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ PG Logistics History: errore salvataggio:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  async getLogisticsContainersRevisions(workDate: string): Promise<any[]> {
    try {
      const result = await query(
        `SELECT revision, task_count, created_at, created_by, modification_type
         FROM lg_containers_revision
         WHERE work_date = $1 ORDER BY revision DESC`,
        [workDate]
      );
      return result.rows;
    } catch (error) {
      console.error('❌ PG Logistics History: errore revisioni:', error);
      return [];
    }
  }

  async getLogisticsContainersAtRevision(workDate: string, revision: number): Promise<any | null> {
    try {
      const result = await query(
        'SELECT * FROM lg_containers_history WHERE work_date = $1 AND revision = $2 ORDER BY priority, task_id',
        [workDate, revision]
      );
      if (result.rows.length === 0) return null;
      const containers: { [key: string]: any[] } = { early_out: [], high: [], low: [] };
      for (const row of result.rows) {
        const task: any = {
          task_id: row.task_id,
          logistic_code: row.logistic_code,
          priority: row.priority,
          client_id: row.client_id,
          premium: row.premium,
          address: row.address,
          lat: row.lat,
          lng: row.lng,
          cleaning_time: row.cleaning_time,
          checkin_date: row.checkin_date,
          checkout_date: row.checkout_date,
          checkin_time: row.checkin_time,
          checkout_time: row.checkout_time,
          pax_in: row.pax_in,
          pax_out: row.pax_out,
          small_equipment: row.small_equipment,
          operation_id: row.operation_id,
          confirmed_operation: row.confirmed_operation,
          straordinaria: row.straordinaria,
          type_apt: row.type_apt,
          alias: row.alias,
          customer_name: row.customer_name,
          customer_note: row.customer_note,
          customer_note_history: normalizeCustomerNoteHistory(row.customer_note_history),
          reasons: row.reasons || [],
          locked: row.locked || false,
          locked_reason: row.locked_reason || null
        };
        if (row.customer_reference) task.customer_reference = row.customer_reference;
        const priority = row.priority || 'low';
        if (!containers[priority]) containers[priority] = [];
        containers[priority].push(task);
      }
      return { containers };
    } catch (error) {
      console.error('❌ PG Logistics History: errore caricamento revisione:', error);
      return null;
    }
  }

  async restoreLogisticsContainersFromRevision(
    workDate: string,
    revision: number,
    createdBy: string = 'system'
  ): Promise<boolean> {
    const client = await pool.connect();
    try {
      await this.saveLogisticsContainersToHistory(workDate, createdBy, 'pre_restore');
      await client.query('BEGIN');
      const historyResult = await client.query(
        'SELECT * FROM lg_containers_history WHERE work_date = $1 AND revision = $2',
        [workDate, revision]
      );
      if (historyResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query('DELETE FROM lg_containers WHERE work_date = $1', [workDate]);
      for (const row of historyResult.rows) {
        await client.query(`
          INSERT INTO lg_containers (
            work_date, priority,
            task_id, logistic_code, client_id, premium, address, lat, lng,
            cleaning_time, checkin_date, checkout_date, checkin_time, checkout_time,
            pax_in, pax_out, small_equipment, operation_id, confirmed_operation,
            straordinaria, type_apt, alias, customer_name, customer_note, customer_note_history, reasons, customer_reference,
            locked, locked_reason, logistics_task_kind, logistics_task_kind_source
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9,
            $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
            $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31
          )
        `, [
          workDate,
          row.priority,
          row.task_id,
          row.logistic_code,
          row.client_id,
          row.premium,
          row.address,
          row.lat,
          row.lng,
          row.cleaning_time,
          row.checkin_date,
          row.checkout_date,
          row.checkin_time,
          row.checkout_time,
          row.pax_in,
          row.pax_out,
          row.small_equipment,
          row.operation_id,
          row.confirmed_operation,
          row.straordinaria,
          row.type_apt,
          row.alias,
          row.customer_name,
          row.customer_note ?? null,
          toCustomerNoteHistoryJson(row.customer_note_history),
          row.reasons || [],
          row.customer_reference ?? null,
          row.locked || false,
          row.locked_reason || null,
          row.logistics_task_kind ?? null,
          row.logistics_task_kind_source ?? null,
        ]);
      }
      await client.query('COMMIT');
      console.log(`✅ PG Logistics: ripristinati ${historyResult.rows.length} task da revisione ${revision}`);
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ PG Logistics: errore ripristino:', error);
      return false;
    } finally {
      client.release();
    }
  }

  // ==================== SELECTED CLEANERS ====================

  /**
   * Load selected cleaner IDs for a work_date
   * Returns array of cleaner IDs (integers)
   */
  async loadSelectedCleaners(workDate: string, scope: string | null = 'housekeeping'): Promise<number[] | null> {
    try {
      const normalizedScope = this.normalizeScope(scope);
      const result = normalizedScope === 'office'
        ? await query(
            "SELECT cleaners FROM daily_selected_cleaners WHERE work_date = $1 AND scope = 'office'",
            [workDate]
          )
        : await query(
            "SELECT cleaners FROM daily_selected_cleaners WHERE work_date = $1 AND (scope = 'housekeeping' OR scope IS NULL)",
            [workDate]
          );
      if (result.rows.length > 0 && result.rows[0].cleaners) {
        // cleaners is now an integer[] array, not JSON
        const cleanerIds = result.rows[0].cleaners;
        console.log(`✅ PG: Selected cleaners caricati per ${workDate}: ${cleanerIds.length} IDs`);
        return cleanerIds;
      }
      return null;
    } catch (error) {
      console.error('❌ PG: Errore nel caricamento selected cleaners:', error);
      return null;
    }
  }

  /**
   * Save selected cleaner IDs for a work_date (upsert) with revision tracking
   * @param cleanerIds - Array of cleaner IDs (integers)
   * @param actionType - Type of action: 'add', 'remove', 'replace', 'swap', 'rollback', 'init'
   * @param actionPayload - Optional JSON payload with action details
   * @param performedBy - Username/identifier of who performed the action
   */
  async saveSelectedCleaners(
    workDate: string, 
    cleanerIds: number[], 
    actionType: string = 'replace',
    actionPayload: any = null,
    performedBy: string = 'system',
    scope: string | null = 'housekeeping'
  ): Promise<boolean> {
    const client = await pool.connect();
    try {
      const normalizedScope = this.normalizeScope(scope);
      await client.query('BEGIN');

      // 1. Load current state (before)
      const currentResult = normalizedScope === 'office'
        ? await client.query(
            "SELECT id, cleaners FROM daily_selected_cleaners WHERE work_date = $1 AND scope = 'office'",
            [workDate]
          )
        : await client.query(
            "SELECT id, cleaners FROM daily_selected_cleaners WHERE work_date = $1 AND (scope = 'housekeeping' OR scope IS NULL)",
            [workDate]
          );
      const cleanersBefore: number[] = currentResult.rows[0]?.cleaners || [];
      let selectedCleanersId = currentResult.rows[0]?.id;

      // 2. Insert/update the main record
      if (selectedCleanersId) {
        await client.query(`
          UPDATE daily_selected_cleaners 
          SET cleaners = $2::integer[], scope = $3, updated_at = NOW()
          WHERE id = $1
        `, [selectedCleanersId, cleanerIds, normalizedScope]);
      } else {
        const insertResult = await client.query(`
          INSERT INTO daily_selected_cleaners (work_date, scope, cleaners, updated_at)
          VALUES ($1, $2, $3::integer[], NOW())
          RETURNING id
        `, [workDate, normalizedScope, cleanerIds]);
        selectedCleanersId = insertResult.rows[0].id;
      }

      // 3. Calculate revision number and save revision (only if there's a real change)
      const beforeSorted = [...cleanersBefore].sort((a, b) => a - b);
      const afterSorted = [...cleanerIds].sort((a, b) => a - b);
      const hasChanged = JSON.stringify(beforeSorted) !== JSON.stringify(afterSorted);

      if (hasChanged && actionType !== 'INIT') {
        const revResult = await client.query(`
          SELECT COALESCE(MAX(revision_number), 0) + 1 as next_rev
          FROM selected_cleaners_revisions
          WHERE selected_cleaners_id = $1 AND scope = $2
        `, [selectedCleanersId, normalizedScope]);
        const revisionNumber = revResult.rows[0].next_rev;

        await client.query(`
          INSERT INTO selected_cleaners_revisions 
          (selected_cleaners_id, work_date, scope, revision_number, cleaners_before, cleaners_after, action_type, action_payload, performed_by)
          VALUES ($1, $2, $3, $4, $5::integer[], $6::integer[], $7, $8, $9)
        `, [
          selectedCleanersId,
          workDate,
          normalizedScope,
          revisionNumber,
          cleanersBefore,
          cleanerIds,
          actionType,
          actionPayload ? JSON.stringify(actionPayload) : null,
          performedBy
        ]);
        console.log(`📝 PG: Revision ${revisionNumber} salvata per ${workDate} (${actionType})`);
      }

      await client.query('COMMIT');
      console.log(`✅ PG: Selected cleaners salvati per ${workDate}: ${cleanerIds.length} IDs`);
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ PG: Errore nel salvataggio selected cleaners:', error);
      return false;
    } finally {
      client.release();
    }
  }

  /**
   * Rollback selected cleaners to a specific revision
   */
  async rollbackSelectedCleaners(
    workDate: string,
    toRevisionNumber: number,
    performedBy: string = 'system',
    scope: string | null = 'housekeeping'
  ): Promise<boolean> {
    const client = await pool.connect();
    try {
      const normalizedScope = this.normalizeScope(scope);
      await client.query('BEGIN');

      // Get the revision to rollback to
      const revResult = await client.query(`
        SELECT cleaners_before, selected_cleaners_id 
        FROM selected_cleaners_revisions 
        WHERE work_date = $1 AND revision_number = $2 AND scope = $3
      `, [workDate, toRevisionNumber, normalizedScope]);

      if (revResult.rows.length === 0) {
        console.error(`❌ PG: Revision ${toRevisionNumber} non trovata per ${workDate}`);
        await client.query('ROLLBACK');
        return false;
      }

      const cleanersToRestore = revResult.rows[0].cleaners_before;
      const selectedCleanersId = revResult.rows[0].selected_cleaners_id;

      // Get current state for the new revision record
      const currentResult = await client.query(
        `SELECT cleaners FROM daily_selected_cleaners
         WHERE work_date = $1 AND ${normalizedScope === 'office' ? "scope = 'office'" : "scope = 'housekeeping'"}`,
        [workDate]
      );
      const cleanersBefore = currentResult.rows[0]?.cleaners || [];

      // Update selected_cleaners
      await client.query(`
        UPDATE daily_selected_cleaners 
        SET cleaners = $1::integer[], updated_at = NOW(), scope = $3
        WHERE work_date = $2 AND scope = $3
      `, [cleanersToRestore, workDate, normalizedScope]);

      // Create a new revision with ROLLBACK action
      const nextRevResult = await client.query(`
        SELECT COALESCE(MAX(revision_number), 0) + 1 as next_rev
        FROM selected_cleaners_revisions
        WHERE selected_cleaners_id = $1 AND scope = $2
      `, [selectedCleanersId, normalizedScope]);

      await client.query(`
        INSERT INTO selected_cleaners_revisions 
        (selected_cleaners_id, work_date, scope, revision_number, cleaners_before, cleaners_after, action_type, action_payload, performed_by)
        VALUES ($1, $2, $3, $4, $5::integer[], $6::integer[], 'ROLLBACK', $7, $8)
      `, [
        selectedCleanersId,
        workDate,
        normalizedScope,
        nextRevResult.rows[0].next_rev,
        cleanersBefore,
        cleanersToRestore,
        JSON.stringify({ rolled_back_to_revision: toRevisionNumber }),
        performedBy
      ]);

      await client.query('COMMIT');
      console.log(`✅ PG: Rollback a revision ${toRevisionNumber} completato per ${workDate}`);
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ PG: Errore nel rollback selected cleaners:', error);
      return false;
    } finally {
      client.release();
    }
  }

  /**
   * Get revision history for a work_date
   */
  async getSelectedCleanersRevisions(workDate: string, scope: string | null = 'housekeeping'): Promise<any[]> {
    try {
      const normalizedScope = this.normalizeScope(scope);
      const result = await query(`
        SELECT 
          revision_number, cleaners_before, cleaners_after, 
          action_type, action_payload, performed_by, created_at
        FROM selected_cleaners_revisions 
        WHERE work_date = $1
          AND ${normalizedScope === 'office' ? "scope = 'office'" : "scope = 'housekeeping'"}
        ORDER BY revision_number DESC
      `, [workDate]);
      return result.rows;
    } catch (error) {
      console.error('❌ PG: Errore nel caricamento revisions:', error);
      return [];
    }
  }

  // ==================== LOGISTICS SELECTED DRIVERS (lg_selected_drivers) ====================

  async loadSelectedLogisticsDrivers(workDate: string): Promise<number[] | null> {
    try {
      const result = await query(
        'SELECT drivers FROM lg_selected_drivers WHERE work_date = $1',
        [workDate]
      );
      if (result.rows.length > 0 && result.rows[0].drivers) {
        return result.rows[0].drivers;
      }
      return null;
    } catch (error) {
      console.error('❌ PG: loadSelectedLogisticsDrivers', error);
      return null;
    }
  }

  async saveSelectedLogisticsDrivers(
    workDate: string,
    driverIds: number[],
    actionType: string = 'replace',
    actionPayload: any = null,
    performedBy: string = 'system',
    vehicleAssignments: Record<string, any> = {}
  ): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const currentResult = await client.query(
        'SELECT id, drivers, vehicle_assignments FROM lg_selected_drivers WHERE work_date = $1',
        [workDate]
      );
      const driversBefore: number[] = currentResult.rows[0]?.drivers || [];
      const vehicleAssignmentsBefore: Record<string, any> =
        currentResult.rows[0]?.vehicle_assignments &&
        typeof currentResult.rows[0].vehicle_assignments === 'object'
          ? currentResult.rows[0].vehicle_assignments
          : {};
      let selectedDriversId = currentResult.rows[0]?.id;
      if (selectedDriversId) {
        await client.query(
          `UPDATE lg_selected_drivers
           SET drivers = $2::integer[], vehicle_assignments = $3::jsonb, updated_at = NOW()
           WHERE id = $1`,
          [selectedDriversId, driverIds, JSON.stringify(vehicleAssignments || {})]
        );
      } else {
        const insertResult = await client.query(
          `INSERT INTO lg_selected_drivers (work_date, drivers, vehicle_assignments, updated_at)
           VALUES ($1, $2::integer[], $3::jsonb, NOW())
           RETURNING id`,
          [workDate, driverIds, JSON.stringify(vehicleAssignments || {})]
        );
        selectedDriversId = insertResult.rows[0].id;
      }
      const beforeSorted = [...driversBefore].sort((a, b) => a - b);
      const afterSorted = [...driverIds].sort((a, b) => a - b);
      const hasDriversChanged = JSON.stringify(beforeSorted) !== JSON.stringify(afterSorted);
      const hasVehicleAssignmentsChanged =
        JSON.stringify(vehicleAssignmentsBefore || {}) !== JSON.stringify(vehicleAssignments || {});
      const hasChanged = hasDriversChanged || hasVehicleAssignmentsChanged;
      if (hasChanged && actionType !== 'INIT') {
        const revResult = await client.query(
          `SELECT COALESCE(MAX(revision_number), 0) + 1 as next_rev FROM lg_selected_drivers_revision WHERE selected_drivers_id = $1`,
          [selectedDriversId]
        );
        const revisionNumber = revResult.rows[0].next_rev;
        await client.query(
          `INSERT INTO lg_selected_drivers_revision
           (
             selected_drivers_id, work_date, revision_number,
             drivers_before, drivers_after,
             vehicle_assignments_before, vehicle_assignments_after,
             action_type, action_payload, performed_by
           )
           VALUES ($1, $2, $3, $4::integer[], $5::integer[], $6::jsonb, $7::jsonb, $8, $9, $10)`,
          [
            selectedDriversId,
            workDate,
            revisionNumber,
            driversBefore,
            driverIds,
            JSON.stringify(vehicleAssignmentsBefore || {}),
            JSON.stringify(vehicleAssignments || {}),
            actionType,
            actionPayload ? JSON.stringify(actionPayload) : null,
            performedBy,
          ]
        );
      }
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ PG: saveSelectedLogisticsDrivers', error);
      return false;
    } finally {
      client.release();
    }
  }

  async loadSelectedLogisticsDriverVehicleAssignments(workDate: string): Promise<Record<string, any>> {
    try {
      const result = await query(
        'SELECT vehicle_assignments FROM lg_selected_drivers WHERE work_date = $1',
        [workDate]
      );
      const raw = result.rows[0]?.vehicle_assignments;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return raw;
      }
      return {};
    } catch (error) {
      console.error('❌ PG: loadSelectedLogisticsDriverVehicleAssignments', error);
      return {};
    }
  }

  async rollbackSelectedLogisticsDrivers(
    workDate: string,
    toRevisionNumber: number,
    performedBy: string = 'system'
  ): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const revResult = await client.query(
        `SELECT drivers_before, vehicle_assignments_before, selected_drivers_id FROM lg_selected_drivers_revision
         WHERE work_date = $1 AND revision_number = $2`,
        [workDate, toRevisionNumber]
      );
      if (revResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      const driversToRestore = revResult.rows[0].drivers_before;
      const vehicleAssignmentsToRestore = revResult.rows[0].vehicle_assignments_before || {};
      const selectedDriversId = revResult.rows[0].selected_drivers_id;
      const currentResult = await client.query(
        'SELECT drivers, vehicle_assignments FROM lg_selected_drivers WHERE work_date = $1',
        [workDate]
      );
      const driversBefore = currentResult.rows[0]?.drivers || [];
      const vehicleAssignmentsBefore = currentResult.rows[0]?.vehicle_assignments || {};
      await client.query(
        `UPDATE lg_selected_drivers
         SET drivers = $1::integer[], vehicle_assignments = $2::jsonb, updated_at = NOW()
         WHERE work_date = $3`,
        [driversToRestore, JSON.stringify(vehicleAssignmentsToRestore || {}), workDate]
      );
      const nextRevResult = await client.query(
        `SELECT COALESCE(MAX(revision_number), 0) + 1 as next_rev FROM lg_selected_drivers_revision WHERE selected_drivers_id = $1`,
        [selectedDriversId]
      );
      await client.query(
        `INSERT INTO lg_selected_drivers_revision
         (
           selected_drivers_id, work_date, revision_number,
           drivers_before, drivers_after,
           vehicle_assignments_before, vehicle_assignments_after,
           action_type, action_payload, performed_by
         )
         VALUES ($1, $2, $3, $4::integer[], $5::integer[], $6::jsonb, $7::jsonb, 'ROLLBACK', $8, $9)`,
        [
          selectedDriversId,
          workDate,
          nextRevResult.rows[0].next_rev,
          driversBefore,
          driversToRestore,
          JSON.stringify(vehicleAssignmentsBefore || {}),
          JSON.stringify(vehicleAssignmentsToRestore || {}),
          JSON.stringify({ rolled_back_to_revision: toRevisionNumber }),
          performedBy,
        ]
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ PG: rollbackSelectedLogisticsDrivers', error);
      return false;
    } finally {
      client.release();
    }
  }

  async getSelectedLogisticsDriversRevisions(workDate: string): Promise<any[]> {
    try {
      const result = await query(
        `SELECT revision_number, drivers_before, drivers_after, vehicle_assignments_before, vehicle_assignments_after, action_type, action_payload, performed_by, created_at
         FROM lg_selected_drivers_revision WHERE work_date = $1 ORDER BY revision_number DESC`,
        [workDate]
      );
      return result.rows;
    } catch (error) {
      console.error('❌ PG: getSelectedLogisticsDriversRevisions', error);
      return [];
    }
  }

  // ==================== CLEANERS (ANAGRAFICA) ====================

  /**
   * Load all cleaners for a work_date from PostgreSQL.
   * Alias comes from aliases only (cleaners.alias no longer used).
   */
  async loadCleanersForDate(workDate: string, scope: string | null = 'housekeeping'): Promise<any[] | null> {
    try {
      const normalizedScope = this.normalizeScope(scope);
      const result = await query(`
        SELECT 
          c.cleaner_id as id, c.name, c.lastname, c.role, c.active, c.ranking,
          c.counter_hours, c.counter_days, c.available, c.contract_type,
          c.preferred_customers, c.telegram_id, c.start_time,
          ca.alias
        FROM cleaners c
        LEFT JOIN aliases ca ON ca.cleaner_id = c.cleaner_id
        WHERE c.work_date = $1
          AND c.active = true
          AND (${normalizedScope === 'office'
            ? "LOWER(TRIM(COALESCE(c.role, ''))) = 'ufficio'"
            : "LOWER(TRIM(COALESCE(c.role, ''))) <> 'ufficio'"})
        ORDER BY c.counter_hours DESC
      `, [workDate]);

      if (result.rows.length > 0) {
        console.log(`✅ PG: ${result.rows.length} cleaners caricati per ${workDate}`);
        return result.rows;
      }
      return null;
    } catch (error) {
      console.error('❌ PG: Errore nel caricamento cleaners:', error);
      return null;
    }
  }

  /**
   * Load a single cleaner by ID and date. Alias from aliases only.
   */
  async loadCleanerById(cleanerId: number, workDate: string, scope: string | null = 'housekeeping'): Promise<any | null> {
    try {
      const normalizedScope = this.normalizeScope(scope);
      const result = await query(`
        SELECT 
          c.cleaner_id as id, c.name, c.lastname, c.role, c.active, c.ranking,
          c.counter_hours, c.counter_days, c.available, c.contract_type,
          c.preferred_customers, c.telegram_id, c.start_time,
          ca.alias
        FROM cleaners c
        LEFT JOIN aliases ca ON ca.cleaner_id = c.cleaner_id
        WHERE c.cleaner_id = $1 AND c.work_date = $2
          AND (${normalizedScope === 'office'
            ? "LOWER(TRIM(COALESCE(c.role, ''))) = 'ufficio'"
            : "LOWER(TRIM(COALESCE(c.role, ''))) <> 'ufficio'"})
      `, [cleanerId, workDate]);

      if (result.rows.length > 0) {
        return result.rows[0];
      }
      return null;
    } catch (error) {
      console.error(`❌ PG: Errore nel caricamento cleaner ${cleanerId}:`, error);
      return null;
    }
  }

  /**
   * Load multiple cleaners by IDs for a specific date. Alias from aliases only.
   */
  async loadCleanersByIds(cleanerIds: number[], workDate: string, scope: string | null = 'housekeeping'): Promise<any[]> {
    if (!cleanerIds || cleanerIds.length === 0) return [];

    try {
      const normalizedScope = this.normalizeScope(scope);
      const result = await query(`
        SELECT 
          c.cleaner_id as id, c.name, c.lastname, c.role, c.active, c.ranking,
          c.counter_hours, c.counter_days, c.available, c.contract_type,
          c.preferred_customers, c.telegram_id, c.start_time,
          ca.alias
        FROM cleaners c
        LEFT JOIN aliases ca ON ca.cleaner_id = c.cleaner_id
        WHERE c.cleaner_id = ANY($1) AND c.work_date = $2
          AND (${normalizedScope === 'office'
            ? "LOWER(TRIM(COALESCE(c.role, ''))) = 'ufficio'"
            : "LOWER(TRIM(COALESCE(c.role, ''))) <> 'ufficio'"})
      `, [cleanerIds, workDate]);

      console.log(`✅ PG: ${result.rows.length} cleaners caricati per IDs ${cleanerIds.join(',')}`);
      return result.rows;
    } catch (error) {
      console.error('❌ PG: Errore nel caricamento cleaners per IDs:', error);
      return [];
    }
  }

  /**
   * Load cleaners by IDs for a date, without scope filter.
   * Used as a fallback to preserve role/name when scope-specific rows are temporarily unavailable.
   */
  async loadCleanersByIdsAnyScope(cleanerIds: number[], workDate: string): Promise<any[]> {
    if (!cleanerIds || cleanerIds.length === 0) return [];

    try {
      const result = await query(`
        SELECT
          c.cleaner_id as id, c.name, c.lastname, c.role, c.active, c.ranking,
          c.counter_hours, c.counter_days, c.available, c.contract_type,
          c.preferred_customers, c.telegram_id, c.start_time,
          ca.alias
        FROM cleaners c
        LEFT JOIN aliases ca ON ca.cleaner_id = c.cleaner_id
        WHERE c.cleaner_id = ANY($1) AND c.work_date = $2
      `, [cleanerIds, workDate]);

      return result.rows;
    } catch (error) {
      console.error('❌ PG: Errore nel caricamento cleaners any-scope per IDs:', error);
      return [];
    }
  }

  /**
   * Resolve cleaner identities by ID using the latest available roster row.
   * Useful when a cleaner is referenced in timeline but missing in the current date roster.
   */
  async resolveCleanersByIds(cleanerIds: number[]): Promise<any[]> {
    if (!cleanerIds || cleanerIds.length === 0) return [];

    try {
      const result = await query(`
        SELECT DISTINCT ON (c.cleaner_id)
          c.cleaner_id as id,
          c.name,
          c.lastname,
          c.role,
          c.start_time,
          ca.alias
        FROM cleaners c
        LEFT JOIN aliases ca ON ca.cleaner_id = c.cleaner_id
        WHERE c.cleaner_id = ANY($1)
        ORDER BY c.cleaner_id, c.work_date DESC
      `, [cleanerIds]);

      return result.rows;
    } catch (error) {
      console.error('❌ PG: Errore nella risoluzione cleaner per IDs:', error);
      return [];
    }
  }

  // ==================== LOGISTICS DRIVERS ROSTER (lg_drivers, ADAM user_role_id = 9) ====================

  async loadLgDriversForDate(workDate: string): Promise<any[] | null> {
    try {
      const result = await query(
        `
        SELECT
          d.driver_id as id, d.name, d.lastname, d.role, d.active, d.ranking,
          d.counter_hours, d.counter_days, d.available, d.contract_type,
          d.preferred_customers, d.telegram_id, d.start_time, d.end_time,
          ca.alias
        FROM lg_drivers d
        LEFT JOIN aliases ca ON ca.cleaner_id = d.driver_id
        WHERE d.work_date = $1 AND d.active = true
          AND (d.role IS NULL OR LOWER(TRIM(d.role)) <> 'vehicle')
        ORDER BY d.counter_hours DESC
      `,
        [workDate]
      );
      if (result.rows.length > 0) {
        console.log(`✅ PG: ${result.rows.length} logistics drivers caricati per ${workDate}`);
        return result.rows;
      }
      return null;
    } catch (error) {
      console.error('❌ PG: Errore nel caricamento lg_drivers:', error);
      return null;
    }
  }

  async loadLgDriversByIds(driverIds: number[], workDate: string): Promise<any[]> {
    if (!driverIds || driverIds.length === 0) return [];
    try {
      const result = await query(
        `
        SELECT
          d.driver_id as id, d.name, d.lastname, d.role, d.active, d.ranking,
          d.counter_hours, d.counter_days, d.available, d.contract_type,
          d.preferred_customers, d.telegram_id, d.start_time, d.end_time,
          ca.alias
        FROM lg_drivers d
        LEFT JOIN aliases ca ON ca.cleaner_id = d.driver_id
        WHERE d.driver_id = ANY($1) AND d.work_date = $2
          AND (d.role IS NULL OR LOWER(TRIM(d.role)) <> 'vehicle')
      `,
        [driverIds, workDate]
      );
      return result.rows;
    } catch (error) {
      console.error('❌ PG: Errore nel caricamento lg_drivers per IDs:', error);
      return [];
    }
  }

  async saveLgDriversForDate(workDate: string, drivers: any[], snapshotReason?: string): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const permanentAliases = await client.query(`
        SELECT cleaner_id, alias, name, lastname FROM aliases
      `);
      const aliasMap = new Map(permanentAliases.rows.map((r: any) => [r.cleaner_id, r.alias]));

      await client.query('DELETE FROM lg_drivers WHERE work_date = $1', [workDate]);
      for (const d of drivers) {
        if (d.alias && !aliasMap.has(d.id)) {
          await client.query(
            `
            INSERT INTO aliases (cleaner_id, alias, name, lastname, updated_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (cleaner_id) DO UPDATE SET alias = $2, updated_at = NOW()
          `,
            [d.id, d.alias, d.name, d.lastname]
          );
        }

        await client.query(
          `
          INSERT INTO lg_drivers
          (driver_id, work_date, name, lastname, role, active, ranking,
           counter_hours, counter_days, available, contract_type,
           preferred_customers, telegram_id, start_time, end_time,
           created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
        `,
          [
            d.id,
            workDate,
            d.name || '',
            d.lastname || '',
            d.role || 'Driver',
            d.active !== false,
            d.ranking || 0,
            d.counter_hours || 0,
            d.counter_days || 0,
            d.available !== false,
            d.contract_type || null,
            d.preferred_customers || [],
            d.telegram_id || null,
            d.start_time ?? '10:00',
            d.end_time ?? '20:00',
          ]
        );
      }
      await client.query('COMMIT');
      console.log(`✅ PG: ${drivers.length} lg_drivers salvati per ${workDate}${snapshotReason ? ` (${snapshotReason})` : ''}`);
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ PG: Errore nel salvataggio lg_drivers:', error);
      return false;
    } finally {
      client.release();
    }
  }

  async updateLgDriverField(driverId: number, workDate: string, field: string, value: any): Promise<boolean> {
    const allowedFields = ['start_time', 'end_time', 'available', 'active', 'ranking', 'counter_hours', 'counter_days'];
    if (!allowedFields.includes(field)) {
      console.error(`❌ PG: Campo lg_drivers non consentito: ${field}`);
      return false;
    }
    try {
      await query(
        `UPDATE lg_drivers SET ${field} = $1, updated_at = NOW() WHERE driver_id = $2 AND work_date = $3`,
        [value, driverId, workDate]
      );
      console.log(`✅ PG: lg_drivers ${driverId} (${workDate}): ${field} = ${value}`);
      return true;
    } catch (error) {
      console.error(`❌ PG: Errore update lg_drivers ${driverId}:`, error);
      return false;
    }
  }

  /**
   * Save/upsert cleaners for a work_date (bulk insert)
   * Replaces all cleaners for the date
   * NOTE: Aliases are now stored in aliases table (permanent, date-independent)
   */
  async saveCleanersForDate(
    workDate: string,
    cleaners: any[],
    snapshotReason?: string,
    scope: string | null = 'housekeeping'
  ): Promise<boolean> {
    const client = await pool.connect();
    try {
      const normalizedScope = this.normalizeScope(scope);
      await client.query('BEGIN');

      // Load permanent aliases from aliases table
      const permanentAliases = await client.query(`
        SELECT cleaner_id, alias, name, lastname FROM aliases
      `);
      const aliasMap = new Map(permanentAliases.rows.map((r: any) => [r.cleaner_id, r.alias]));
      const existingRolesResult = await client.query(
        `SELECT cleaner_id, role
         FROM cleaners
         WHERE work_date = $1
           AND (${normalizedScope === 'office'
             ? "LOWER(TRIM(COALESCE(role, ''))) = 'ufficio'"
             : "LOWER(TRIM(COALESCE(role, ''))) <> 'ufficio'"})`,
        [workDate]
      );
      const existingRolesByCleanerId = new Map<number, string>(
        existingRolesResult.rows
          .map((r: any) => [Number(r.cleaner_id), String(r.role || "").trim()] as const)
          .filter(([id, role]) => Number.isFinite(id) && role.length > 0)
      );

      // Scope-safe rewrite: aggiorna solo il segmento office/non-office della data.
      await client.query(
        `DELETE FROM cleaners
         WHERE work_date = $1
           AND (${normalizedScope === 'office'
             ? "LOWER(TRIM(COALESCE(role, ''))) = 'ufficio'"
             : "LOWER(TRIM(COALESCE(role, ''))) <> 'ufficio'"})`,
        [workDate]
      );

      // Insert new cleaners; alias only in aliases (cleaners.alias no longer used)
      for (const cleaner of cleaners) {
        const normalizedIncomingRole = String(cleaner?.role || "").trim();
        const preservedRole = existingRolesByCleanerId.get(Number(cleaner?.id)) || "";
        const resolvedRole = normalizedIncomingRole || preservedRole || "Standard";
        const roleIsOffice = resolvedRole.toLowerCase() === "ufficio";

        // Guardrail: accetta solo righe coerenti con lo scope richiesto.
        // Evita collisioni UNIQUE(cleaner_id, work_date) quando input cross-scope arriva per errore.
        if (normalizedScope === "office" ? !roleIsOffice : roleIsOffice) {
          continue;
        }

        // If cleaner has a new alias, save it to aliases (permanent)
        if (cleaner.alias && !aliasMap.has(cleaner.id)) {
          await client.query(`
            INSERT INTO aliases (cleaner_id, alias, name, lastname, updated_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (cleaner_id) DO UPDATE SET alias = $2, updated_at = NOW()
          `, [cleaner.id, cleaner.alias, cleaner.name, cleaner.lastname]);
        }
        
        await client.query(`
          INSERT INTO cleaners 
          (cleaner_id, work_date, name, lastname, role, active, ranking,
           counter_hours, counter_days, available, contract_type,
           preferred_customers, telegram_id, start_time, end_time,
           created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
        `, [
          cleaner.id,
          workDate,
          cleaner.name || '',
          cleaner.lastname || '',
          resolvedRole,
          cleaner.active !== false,
          cleaner.ranking || 0,
          cleaner.counter_hours || 0,
          cleaner.counter_days || 0,
          cleaner.available !== false,
          cleaner.contract_type || null,
          cleaner.preferred_customers || [],
          cleaner.telegram_id || null,
          cleaner.start_time ?? '10:00',
          cleaner.end_time ?? '20:00'
        ]);
      }

      // NON rimuovere da aliases in base alla data: gli alias sono permanenti e
      // indipendenti dalla data. Cancellarli quando si salvano le convocazioni per una
      // nuova data (dove compaiono solo i convocati) cancellerebbe gli alias di tutti
      // i cleaner non convocati in quella data.

      await client.query('COMMIT');
      console.log(`✅ PG: ${cleaners.length} cleaners salvati per ${workDate}`);
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ PG: Errore nel salvataggio cleaners:', error);
      return false;
    } finally {
      client.release();
    }
  }

  /**
   * Update a single cleaner's field (e.g., start_time)
   * NOTE: For alias updates, this also saves to aliases table
   */
  async updateCleanerField(cleanerId: number, workDate: string, field: string, value: any): Promise<boolean> {
    const allowedFields = ['start_time', 'end_time', 'available', 'active', 'ranking', 'counter_hours', 'counter_days', 'alias'];
    if (!allowedFields.includes(field)) {
      console.error(`❌ PG: Campo non consentito: ${field}`);
      return false;
    }

    try {
      // Alias: only update aliases (cleaners.alias no longer used)
      if (field === 'alias') {
        if (value) {
          let cleanerData = await query(
            'SELECT name, lastname FROM cleaners WHERE cleaner_id = $1 AND work_date = $2',
            [cleanerId, workDate]
          );
          if (!cleanerData.rows[0]) {
            cleanerData = await query(
              'SELECT name, lastname FROM lg_drivers WHERE driver_id = $1 AND work_date = $2',
              [cleanerId, workDate]
            );
          }
          const name = cleanerData.rows[0]?.name || null;
          const lastname = cleanerData.rows[0]?.lastname || null;
          await query(`
            INSERT INTO aliases (cleaner_id, alias, name, lastname, updated_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (cleaner_id) DO UPDATE SET alias = $2, updated_at = NOW()
          `, [cleanerId, value, name, lastname]);
          console.log(`✅ PG: Alias salvato in aliases per cleaner ${cleanerId}: ${value}`);
        } else {
          await query('DELETE FROM aliases WHERE cleaner_id = $1', [cleanerId]);
          console.log(`✅ PG: Alias rimosso da aliases per cleaner ${cleanerId}`);
        }
        return true;
      }
      
      // Other fields: update cleaners table
      await query(`
        UPDATE cleaners 
        SET ${field} = $1, updated_at = NOW()
        WHERE cleaner_id = $2 AND work_date = $3
      `, [value, cleanerId, workDate]);
      console.log(`✅ PG: Cleaner ${cleanerId} aggiornato: ${field} = ${value}`);
      return true;
    } catch (error) {
      console.error(`❌ PG: Errore nell'aggiornamento cleaner ${cleanerId}:`, error);
      return false;
    }
  }

  /**
   * Sync lock status to daily_containers table (for backward compat)
   * NOTE: La source of truth per i lock è ora daily_task_locks
   */
  async syncLockToContainers(taskId: string | number, workDate: string, locked: boolean, lockedReason?: string): Promise<boolean> {
    try {
      const result = await query(
        `UPDATE daily_containers 
         SET locked = $1, locked_reason = $2, updated_at = NOW() 
         WHERE work_date = $3 AND task_id = $4`,
        [locked, locked ? (lockedReason || null) : null, workDate, taskId]
      );
      
      if (result.rowCount === 0) {
        console.log(`⚠️ PG: Task ${taskId} non trovato in daily_containers per ${workDate}`);
        return false;
      }
      
      console.log(`✅ PG: Task ${taskId} ${locked ? 'bloccata' : 'sbloccata'} in daily_containers`);
      return true;
    } catch (error) {
      console.error(`❌ PG: Errore nell'aggiornamento lock status task ${taskId}:`, error);
      return false;
    }
  }

  // ==================== CLEANER ALIASES (PERMANENT) ====================

  /**
   * Get alias for a cleaner (from permanent aliases table)
   */
  async getCleanerAlias(cleanerId: number): Promise<string | null> {
    try {
      const result = await query(
        'SELECT alias FROM aliases WHERE cleaner_id = $1',
        [cleanerId]
      );
      return result.rows[0]?.alias || null;
    } catch (error) {
      console.error(`❌ PG: Errore nel caricamento alias per cleaner ${cleanerId}:`, error);
      return null;
    }
  }

  /**
   * Get all cleaner aliases
   */
  async getAllCleanerAliases(): Promise<Map<number, { alias: string; name?: string; lastname?: string }>> {
    try {
      const result = await query('SELECT cleaner_id, alias, name, lastname FROM aliases');
      const aliasMap = new Map();
      for (const row of result.rows) {
        aliasMap.set(row.cleaner_id, {
          alias: row.alias,
          name: row.name,
          lastname: row.lastname
        });
      }
      return aliasMap;
    } catch (error) {
      console.error('❌ PG: Errore nel caricamento aliases:', error);
      return new Map();
    }
  }

  /**
   * Save/update a cleaner alias (permanent, date-independent)
   */
  async saveCleanerAlias(cleanerId: number, alias: string, name?: string, lastname?: string): Promise<boolean> {
    try {
      await query(`
        INSERT INTO aliases (cleaner_id, alias, name, lastname, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (cleaner_id) 
        DO UPDATE SET alias = $2, name = COALESCE($3, aliases.name), 
                      lastname = COALESCE($4, aliases.lastname), updated_at = NOW()
      `, [cleanerId, alias, name || null, lastname || null]);
      console.log(`✅ PG: Alias salvato per cleaner ${cleanerId}: ${alias}`);
      return true;
    } catch (error) {
      console.error(`❌ PG: Errore nel salvataggio alias per cleaner ${cleanerId}:`, error);
      return false;
    }
  }

  /**
   * Delete a cleaner alias
   */
  async deleteCleanerAlias(cleanerId: number): Promise<boolean> {
    try {
      await query('DELETE FROM aliases WHERE cleaner_id = $1', [cleanerId]);
      console.log(`✅ PG: Alias rimosso per cleaner ${cleanerId}`);
      return true;
    } catch (error) {
      console.error(`❌ PG: Errore nella rimozione alias per cleaner ${cleanerId}:`, error);
      return false;
    }
  }


  /**
   * Import aliases from JSON format (for migration)
   */
  async importAliasesFromJson(aliasData: Record<string, { name: string; lastname: string; alias: string }>): Promise<number> {
    let imported = 0;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [cleanerIdStr, data] of Object.entries(aliasData)) {
        const cleanerId = parseInt(cleanerIdStr, 10);
        if (isNaN(cleanerId)) continue;
        
        await client.query(`
          INSERT INTO aliases (cleaner_id, alias, name, lastname, updated_at)
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (cleaner_id) 
          DO UPDATE SET alias = EXCLUDED.alias, name = EXCLUDED.name, 
                        lastname = EXCLUDED.lastname, updated_at = NOW()
        `, [cleanerId, data.alias, data.name, data.lastname]);
        imported++;
      }
      await client.query('COMMIT');
      console.log(`✅ PG: ${imported} aliases importati`);
      return imported;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ PG: Errore nell\'import aliases:', error);
      return 0;
    } finally {
      client.release();
    }
  }
}

export const pgDailyAssignmentsService = new PgDailyAssignmentsService();