import pool, { query } from '../../shared/pg-db';

export interface PgDailyAssignmentRow {
  id?: number;
  work_date: string;
  cleaner_id: number;
  cleaner_name?: string | null;
  cleaner_lastname?: string | null;
  cleaner_role?: string | null;
  cleaner_premium?: boolean | null;
  cleaner_start_time?: string | null;
  task_id: number;
  logistic_code: number;
  client_id?: number | null;
  premium: boolean;
  address: string;
  lat?: number | null;
  lng?: number | null;
  cleaning_time: number;
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
  reasons: string[];
  priority?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  followup?: boolean | null;
  sequence: number;
  travel_time: number;
  created_at?: Date;
  updated_at?: Date;
}

export class PgDailyAssignmentsService {

  /**
   * Ensure cleaners table has alias column (migration)
   * NOTE: cleaners_history è stata rimossa - gli alias sono ora in cleaner_aliases
   */
  async ensureAliasColumn(): Promise<void> {
    try {
      // Ensure alias column exists on cleaners table (legacy, per backward compat)
      await query(`
        ALTER TABLE cleaners ADD COLUMN IF NOT EXISTS alias TEXT DEFAULT NULL
      `);
      // Create cleaner_aliases table if not exists
      await query(`
        CREATE TABLE IF NOT EXISTS cleaner_aliases (
          cleaner_id INTEGER PRIMARY KEY,
          alias VARCHAR(100) NOT NULL,
          name VARCHAR(255),
          lastname VARCHAR(255),
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
      // Create selected_cleaners_revisions table if not exists
      await query(`
        CREATE TABLE IF NOT EXISTS selected_cleaners_revisions (
          id SERIAL PRIMARY KEY,
          selected_cleaners_id INTEGER NOT NULL,
          work_date DATE NOT NULL,
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
      // Drop deprecated cleaners_history table (no longer needed)
      await query(`DROP TABLE IF EXISTS cleaners_history CASCADE`);
      console.log('✅ PG: Tabelle cleaner_aliases e selected_cleaners_revisions verificate, cleaners_history rimossa');
    } catch (error) {
      console.warn('⚠️ PG: Errore (ignorabile) nella migrazione:', error);
    }
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
          // Task data
          task_id: Number(task.task_id),
          logistic_code: Number(task.logistic_code || 0),
          client_id: task.client_id ? Number(task.client_id) : null,
          premium: Boolean(task.premium),
          address: String(task.address || ''),
          lat: task.lat ? parseFloat(String(task.lat)) : null,
          lng: task.lng ? parseFloat(String(task.lng)) : null,
          cleaning_time: Number(task.cleaning_time || 0),
          checkin_date: task.checkin_date || null,
          checkout_date: task.checkout_date || null,
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
          reasons: Array.isArray(task.reasons) ? task.reasons : [],
          priority: task.priority || null,
          start_time: task.start_time || null,
          end_time: task.end_time || null,
          followup: task.followup != null ? Boolean(task.followup) : null,
          sequence: Number(task.sequence || 0),
          travel_time: Number(task.travel_time || 0),
        };

        rows.push(row);
      }
    }

    return rows;
  }

  /**
   * Save timeline to PostgreSQL (replaces all rows for workDate)
   */
  async saveTimeline(workDate: string, timeline: any): Promise<number> {
    const client = await pool.connect();

    try {
      const rows = this.timelineToRows(workDate, timeline);

      console.log(`📝 PG: Salvando ${rows.length} righe per ${workDate}...`);

      await client.query('BEGIN');

      // Delete existing rows for this work_date
      await client.query(
        'DELETE FROM daily_assignments_current WHERE work_date = $1',
        [workDate]
      );

      if (rows.length === 0) {
        await client.query('COMMIT');
        console.log(`✅ PG: Nessuna assegnazione da salvare per ${workDate}`);
        return 0;
      }

      // Insert new rows (includes cleaner data for full reconstruction)
      for (const row of rows) {
        await client.query(`
          INSERT INTO daily_assignments_current (
            work_date, cleaner_id, cleaner_name, cleaner_lastname, cleaner_role, cleaner_premium, cleaner_start_time,
            task_id, logistic_code, client_id,
            premium, address, lat, lng, cleaning_time,
            checkin_date, checkout_date, checkin_time, checkout_time,
            pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
            type_apt, alias, customer_name, customer_reference, reasons, priority,
            start_time, end_time, followup, sequence, travel_time
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10,
            $11, $12, $13, $14, $15,
            $16, $17, $18, $19,
            $20, $21, $22, $23, $24, $25,
            $26, $27, $28, $29, $30, $31,
            $32, $33, $34, $35, $36
          )
        `, [
          row.work_date,
          row.cleaner_id,
          row.cleaner_name,
          row.cleaner_lastname,
          row.cleaner_role,
          row.cleaner_premium,
          row.cleaner_start_time,
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
          row.reasons,
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
  async getAssignments(workDate: string): Promise<PgDailyAssignmentRow[]> {
    try {
      const result = await query(
        'SELECT * FROM daily_assignments_current WHERE work_date = $1 ORDER BY cleaner_id, sequence',
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
  async loadTimeline(workDate: string): Promise<any | null> {
    try {
      const rows = await this.getAssignments(workDate);

      if (rows.length === 0) {
        console.log(`📖 PG: Nessuna assegnazione trovata per ${workDate}`);
        return null;
      }

      // Group rows by cleaner_id
      const cleanerMap = new Map<number, { cleaner: any; tasks: any[] }>();

      for (const row of rows) {
        if (!cleanerMap.has(row.cleaner_id)) {
          // Build cleaner object from stored data
          const cleaner: any = { id: row.cleaner_id };
          if (row.cleaner_name) cleaner.name = row.cleaner_name;
          if (row.cleaner_lastname) cleaner.lastname = row.cleaner_lastname;
          if (row.cleaner_role) cleaner.role = row.cleaner_role;
          if (row.cleaner_premium !== null) cleaner.premium = row.cleaner_premium;
          cleaner.start_time = row.cleaner_start_time ?? '10:00';

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
        if (row.cleaning_time) task.cleaning_time = row.cleaning_time;
        if (row.checkin_date) task.checkin_date = row.checkin_date;
        if (row.checkout_date) task.checkout_date = row.checkout_date;
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
        if (row.reasons && row.reasons.length > 0) task.reasons = row.reasons;
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
  async countAssignments(workDate: string): Promise<number> {
    try {
      const result = await query(
        'SELECT COUNT(*) as count FROM daily_assignments_current WHERE work_date = $1',
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
    newValues: string[] = []
  ): Promise<number> {
    const client = await pool.connect();

    try {
      const rows = this.timelineToRows(workDate, timeline);

      await client.query('BEGIN');

      // Lock the revisions table for this work_date to prevent race conditions
      // Use a separate SELECT FOR UPDATE on the table itself, then calculate MAX
      await client.query(
        'SELECT 1 FROM daily_assignments_revisions WHERE work_date = $1 FOR UPDATE',
        [workDate]
      );

      // Now safely get the next revision number
      const revResult = await client.query(
        'SELECT COALESCE(MAX(revision), 0) + 1 as next_revision FROM daily_assignments_revisions WHERE work_date = $1',
        [workDate]
      );
      const revision = parseInt(revResult.rows[0]?.next_revision || '1');

      console.log(`📜 PG History: Salvando revisione ${revision} con ${rows.length} righe per ${workDate}...`);

      // ALWAYS create revision metadata entry (even for empty timelines)
      // This ensures revision numbers advance reliably
      // Includes change tracking: edited_fields, old_values, new_values
      await client.query(`
        INSERT INTO daily_assignments_revisions (work_date, revision, task_count, created_by, modification_type, edited_fields, old_values, new_values)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [workDate, revision, rows.length, createdBy, modificationType, editedFields, oldValues, newValues]);

      // Insert task rows if any (includes cleaner data for full reconstruction)
      for (const row of rows) {
        await client.query(`
          INSERT INTO daily_assignments_history (
            work_date, revision, cleaner_id, cleaner_name, cleaner_lastname, cleaner_role, cleaner_premium, cleaner_start_time,
            task_id, logistic_code, client_id,
            premium, address, lat, lng, cleaning_time,
            checkin_date, checkout_date, checkin_time, checkout_time,
            pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
            type_apt, alias, customer_name, customer_reference, reasons, priority,
            start_time, end_time, followup, sequence, travel_time, created_by
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11,
            $12, $13, $14, $15, $16,
            $17, $18, $19, $20,
            $21, $22, $23, $24, $25, $26,
            $27, $28, $29, $30, $31, $32,
            $33, $34, $35, $36, $37, $38
          )
        `, [
          row.work_date,
          revision,
          row.cleaner_id,
          row.cleaner_name,
          row.cleaner_lastname,
          row.cleaner_role,
          row.cleaner_premium,
          row.cleaner_start_time,
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
          row.customer_reference,
          row.reasons,
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
  async getHistoryRevisions(workDate: string): Promise<{ 
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
      const result = await query(`
        SELECT revision, created_at, created_by, task_count, modification_type, 
               edited_fields, old_values, new_values
        FROM daily_assignments_revisions 
        WHERE work_date = $1
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
  async getHistoryByRevision(workDate: string, revision: number): Promise<PgDailyAssignmentRow[]> {
    try {
      const result = await query(
        'SELECT * FROM daily_assignments_history WHERE work_date = $1 AND revision = $2 ORDER BY cleaner_id, sequence',
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
  async getLastRevisionUser(workDate: string): Promise<string | null> {
    try {
      const result = await query(`
        SELECT created_by 
        FROM daily_assignments_revisions 
        WHERE work_date = $1
        ORDER BY revision DESC
        LIMIT 1
      `, [workDate]);
      return result.rows[0]?.created_by || null;
    } catch (error) {
      console.error('❌ PG History: Errore nel recupero ultimo utente:', error);
      return null;
    }
  }

  // ==================== CONTAINERS (FLAT STRUCTURE) ====================

  /**
   * Load containers for a work_date
   * Reconstructs JSON structure from flat PostgreSQL rows
   * Returns same structure as create_containers.py:
   * { containers: { early_out: { tasks: [...], count: N }, high_priority: {...}, low_priority: {...} } }
   */
  async loadContainers(workDate: string): Promise<any | null> {
    try {
      const result = await query(
        'SELECT * FROM daily_containers WHERE work_date = $1 ORDER BY priority, task_id',
        [workDate]
      );

      if (result.rows.length === 0) {
        console.log(`📖 PG: Nessun container trovato per ${workDate}`);
        return null;
      }

      // Group rows by priority (using frontend naming: high_priority, low_priority)
      const tasksByPriority: { [key: string]: any[] } = {
        early_out: [],
        high_priority: [],
        low_priority: []
      };

      // Map DB priority names to frontend names
      const priorityMap: { [key: string]: string } = {
        'early_out': 'early_out',
        'high': 'high_priority',
        'high_priority': 'high_priority',
        'low': 'low_priority',
        'low_priority': 'low_priority'
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
        if (row.checkin_date) task.checkin_date = row.checkin_date;
        if (row.checkout_date) task.checkout_date = row.checkout_date;
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
        if (row.reasons && row.reasons.length > 0) task.reasons = row.reasons;
        if (row.customer_reference) task.customer_reference = row.customer_reference;

        // Add to appropriate priority bucket (map DB names to frontend names)
        const dbPriority = row.priority || 'low';
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
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME
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

  /**
   * Save containers for a work_date
   * Converts JSON structure to flat PostgreSQL rows
   * Accepts both formats:
   * - create_containers.py: { containers: { early_out: { tasks: [...] }, high_priority: {...}, low_priority: {...} } }
   * - simplified: { containers: { early_out: [...], high: [...], low: [...] } }
   */
  async saveContainers(workDate: string, containersData: any): Promise<boolean> {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Delete existing containers for this date
      await client.query('DELETE FROM daily_containers WHERE work_date = $1', [workDate]);

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
              work_date, priority,
              task_id, logistic_code, client_id, premium, address, lat, lng,
              cleaning_time, checkin_date, checkout_date, checkin_time, checkout_time,
              pax_in, pax_out, small_equipment, operation_id, confirmed_operation,
              straordinaria, type_apt, alias, customer_name, reasons, customer_reference
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9,
              $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
              $20, $21, $22, $23, $24, $25
            )
          `, [
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
            task.reasons || [],
            task.customer_reference || null
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
          straordinaria, type_apt, alias, customer_name, reasons, customer_reference
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
          $20, $21, $22, $23, $24, $25
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
        task.reasons || [],
        task.customer_reference || null
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
            straordinaria, type_apt, alias, customer_name, reasons, created_by
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
            $21, $22, $23, $24, $25, $26
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
          row.reasons || [],
          createdBy
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
          reasons: row.reasons || []
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
            straordinaria, type_apt, alias, customer_name, reasons
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9,
            $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
            $20, $21, $22, $23, $24
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
          row.reasons || []
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

  // ==================== SELECTED CLEANERS ====================

  /**
   * Load selected cleaner IDs for a work_date
   * Returns array of cleaner IDs (integers)
   */
  async loadSelectedCleaners(workDate: string): Promise<number[] | null> {
    try {
      const result = await query(
        'SELECT cleaners FROM daily_selected_cleaners WHERE work_date = $1',
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
    performedBy: string = 'system'
  ): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Load current state (before)
      const currentResult = await client.query(
        'SELECT id, cleaners FROM daily_selected_cleaners WHERE work_date = $1',
        [workDate]
      );
      const cleanersBefore: number[] = currentResult.rows[0]?.cleaners || [];
      let selectedCleanersId = currentResult.rows[0]?.id;

      // 2. Insert/update the main record
      if (selectedCleanersId) {
        await client.query(`
          UPDATE daily_selected_cleaners 
          SET cleaners = $2::integer[], updated_at = NOW()
          WHERE id = $1
        `, [selectedCleanersId, cleanerIds]);
      } else {
        const insertResult = await client.query(`
          INSERT INTO daily_selected_cleaners (work_date, cleaners, updated_at)
          VALUES ($1, $2::integer[], NOW())
          RETURNING id
        `, [workDate, cleanerIds]);
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
          WHERE selected_cleaners_id = $1
        `, [selectedCleanersId]);
        const revisionNumber = revResult.rows[0].next_rev;

        await client.query(`
          INSERT INTO selected_cleaners_revisions 
          (selected_cleaners_id, work_date, revision_number, cleaners_before, cleaners_after, action_type, action_payload, performed_by)
          VALUES ($1, $2, $3, $4::integer[], $5::integer[], $6, $7, $8)
        `, [
          selectedCleanersId,
          workDate,
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
  async rollbackSelectedCleaners(workDate: string, toRevisionNumber: number, performedBy: string = 'system'): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get the revision to rollback to
      const revResult = await client.query(`
        SELECT cleaners_before, selected_cleaners_id 
        FROM selected_cleaners_revisions 
        WHERE work_date = $1 AND revision_number = $2
      `, [workDate, toRevisionNumber]);

      if (revResult.rows.length === 0) {
        console.error(`❌ PG: Revision ${toRevisionNumber} non trovata per ${workDate}`);
        await client.query('ROLLBACK');
        return false;
      }

      const cleanersToRestore = revResult.rows[0].cleaners_before;
      const selectedCleanersId = revResult.rows[0].selected_cleaners_id;

      // Get current state for the new revision record
      const currentResult = await client.query(
        'SELECT cleaners FROM daily_selected_cleaners WHERE work_date = $1',
        [workDate]
      );
      const cleanersBefore = currentResult.rows[0]?.cleaners || [];

      // Update selected_cleaners
      await client.query(`
        UPDATE daily_selected_cleaners 
        SET cleaners = $1::integer[], updated_at = NOW()
        WHERE work_date = $2
      `, [cleanersToRestore, workDate]);

      // Create a new revision with ROLLBACK action
      const nextRevResult = await client.query(`
        SELECT COALESCE(MAX(revision_number), 0) + 1 as next_rev
        FROM selected_cleaners_revisions
        WHERE selected_cleaners_id = $1
      `, [selectedCleanersId]);

      await client.query(`
        INSERT INTO selected_cleaners_revisions 
        (selected_cleaners_id, work_date, revision_number, cleaners_before, cleaners_after, action_type, action_payload, performed_by)
        VALUES ($1, $2, $3, $4::integer[], $5::integer[], 'ROLLBACK', $6, $7)
      `, [
        selectedCleanersId,
        workDate,
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
  async getSelectedCleanersRevisions(workDate: string): Promise<any[]> {
    try {
      const result = await query(`
        SELECT 
          revision_number, cleaners_before, cleaners_after, 
          action_type, action_payload, performed_by, created_at
        FROM selected_cleaners_revisions 
        WHERE work_date = $1
        ORDER BY revision_number DESC
      `, [workDate]);
      return result.rows;
    } catch (error) {
      console.error('❌ PG: Errore nel caricamento revisions:', error);
      return [];
    }
  }

  // ==================== CLEANERS (ANAGRAFICA) ====================

  /**
   * Load all cleaners for a work_date from PostgreSQL
   */
  async loadCleanersForDate(workDate: string): Promise<any[] | null> {
    try {
      const result = await query(`
        SELECT 
          cleaner_id as id, name, lastname, role, active, ranking,
          counter_hours, counter_days, available, contract_type,
          preferred_customers, telegram_id, start_time, can_do_straordinaria, alias
        FROM cleaners 
        WHERE work_date = $1 AND active = true
        ORDER BY counter_hours DESC
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
   * Load a single cleaner by ID and date
   */
  async loadCleanerById(cleanerId: number, workDate: string): Promise<any | null> {
    try {
      const result = await query(`
        SELECT 
          cleaner_id as id, name, lastname, role, active, ranking,
          counter_hours, counter_days, available, contract_type,
          preferred_customers, telegram_id, start_time, can_do_straordinaria, alias
        FROM cleaners 
        WHERE cleaner_id = $1 AND work_date = $2
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
   * Load multiple cleaners by IDs for a specific date
   */
  async loadCleanersByIds(cleanerIds: number[], workDate: string): Promise<any[]> {
    if (!cleanerIds || cleanerIds.length === 0) return [];

    try {
      const result = await query(`
        SELECT 
          cleaner_id as id, name, lastname, role, active, ranking,
          counter_hours, counter_days, available, contract_type,
          preferred_customers, telegram_id, start_time, can_do_straordinaria, alias
        FROM cleaners 
        WHERE cleaner_id = ANY($1) AND work_date = $2
      `, [cleanerIds, workDate]);

      console.log(`✅ PG: ${result.rows.length} cleaners caricati per IDs ${cleanerIds.join(',')}`);
      return result.rows;
    } catch (error) {
      console.error('❌ PG: Errore nel caricamento cleaners per IDs:', error);
      return [];
    }
  }

  /**
   * Save/upsert cleaners for a work_date (bulk insert)
   * Replaces all cleaners for the date
   * NOTE: Aliases are now stored in cleaner_aliases table (permanent, date-independent)
   */
  async saveCleanersForDate(workDate: string, cleaners: any[], snapshotReason?: string): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Load permanent aliases from cleaner_aliases table
      const permanentAliases = await client.query(`
        SELECT cleaner_id, alias, name, lastname FROM cleaner_aliases
      `);
      const aliasMap = new Map(permanentAliases.rows.map((r: any) => [r.cleaner_id, r.alias]));

      // Delete existing cleaners for this date
      await client.query('DELETE FROM cleaners WHERE work_date = $1', [workDate]);

      // Insert new cleaners (alias column kept for backward compat, but read from cleaner_aliases)
      for (const cleaner of cleaners) {
        // Use alias from cleaner_aliases if exists, otherwise from cleaner object
        const alias = aliasMap.get(cleaner.id) || cleaner.alias || null;
        
        // If cleaner has a new alias, save it to cleaner_aliases (permanent)
        if (cleaner.alias && !aliasMap.has(cleaner.id)) {
          await client.query(`
            INSERT INTO cleaner_aliases (cleaner_id, alias, name, lastname, updated_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (cleaner_id) DO UPDATE SET alias = $2, updated_at = NOW()
          `, [cleaner.id, cleaner.alias, cleaner.name, cleaner.lastname]);
        }
        
        await client.query(`
          INSERT INTO cleaners 
          (cleaner_id, work_date, name, lastname, role, active, ranking,
           counter_hours, counter_days, available, contract_type,
           preferred_customers, telegram_id, start_time, can_do_straordinaria, alias,
           created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW())
        `, [
          cleaner.id,
          workDate,
          cleaner.name || '',
          cleaner.lastname || '',
          cleaner.role || 'Standard',
          cleaner.active !== false,
          cleaner.ranking || 0,
          cleaner.counter_hours || 0,
          cleaner.counter_days || 0,
          cleaner.available !== false,
          cleaner.contract_type || null,
          cleaner.preferred_customers || [],
          cleaner.telegram_id || null,
          cleaner.start_time ?? '10:00',
          cleaner.can_do_straordinaria || false,
          alias // Still write to cleaners.alias for backward compat
        ]);
      }

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
   * NOTE: For alias updates, this also saves to cleaner_aliases table
   */
  async updateCleanerField(cleanerId: number, workDate: string, field: string, value: any): Promise<boolean> {
    const allowedFields = ['start_time', 'available', 'active', 'ranking', 'counter_hours', 'counter_days', 'alias'];
    if (!allowedFields.includes(field)) {
      console.error(`❌ PG: Campo non consentito: ${field}`);
      return false;
    }

    try {
      // For alias updates, also save to permanent cleaner_aliases table
      if (field === 'alias' && value) {
        // Get cleaner name/lastname for the alias record
        const cleanerData = await query(
          'SELECT name, lastname FROM cleaners WHERE cleaner_id = $1 AND work_date = $2',
          [cleanerId, workDate]
        );
        const name = cleanerData.rows[0]?.name || null;
        const lastname = cleanerData.rows[0]?.lastname || null;
        
        await query(`
          INSERT INTO cleaner_aliases (cleaner_id, alias, name, lastname, updated_at)
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (cleaner_id) DO UPDATE SET alias = $2, updated_at = NOW()
        `, [cleanerId, value, name, lastname]);
        console.log(`✅ PG: Alias permanente salvato per cleaner ${cleanerId}: ${value}`);
      }
      
      // Also update the cleaners table (for backward compat)
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

  // ==================== CLEANER ALIASES (PERMANENT) ====================

  /**
   * Get alias for a cleaner (from permanent cleaner_aliases table)
   */
  async getCleanerAlias(cleanerId: number): Promise<string | null> {
    try {
      const result = await query(
        'SELECT alias FROM cleaner_aliases WHERE cleaner_id = $1',
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
      const result = await query('SELECT cleaner_id, alias, name, lastname FROM cleaner_aliases');
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
        INSERT INTO cleaner_aliases (cleaner_id, alias, name, lastname, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (cleaner_id) 
        DO UPDATE SET alias = $2, name = COALESCE($3, cleaner_aliases.name), 
                      lastname = COALESCE($4, cleaner_aliases.lastname), updated_at = NOW()
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
      await query('DELETE FROM cleaner_aliases WHERE cleaner_id = $1', [cleanerId]);
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
          INSERT INTO cleaner_aliases (cleaner_id, alias, name, lastname, updated_at)
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