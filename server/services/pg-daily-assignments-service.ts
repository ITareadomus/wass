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
          cleaner_start_time: cleaner.start_time || '10:00',
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
            type_apt, alias, customer_name, reasons, priority,
            start_time, end_time, followup, sequence, travel_time
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10,
            $11, $12, $13, $14, $15,
            $16, $17, $18, $19,
            $20, $21, $22, $23, $24, $25,
            $26, $27, $28, $29, $30,
            $31, $32, $33, $34, $35
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
          cleaner.start_time = row.cleaner_start_time || '10:00';
          
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
        if (row.checkin_time) task.checkin_time = row.checkin_time;
        if (row.checkout_time) task.checkout_time = row.checkout_time;
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

      const timeline = {
        cleaners_assignments,
        metadata: {
          date: workDate,
          last_updated: new Date().toISOString(),
          source: 'postgresql'
        }
      };

      console.log(`✅ PG: Timeline ricostruita per ${workDate} (${rows.length} task, ${cleaners_assignments.length} cleaners)`);
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
            type_apt, alias, customer_name, reasons, priority,
            start_time, end_time, followup, sequence, travel_time, created_by
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11,
            $12, $13, $14, $15, $16,
            $17, $18, $19, $20,
            $21, $22, $23, $24, $25, $26,
            $27, $28, $29, $30, $31,
            $32, $33, $34, $35, $36, $37
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

  // ==================== CONTAINERS (FLAT STRUCTURE) ====================

  /**
   * Load containers for a work_date
   * Reconstructs JSON structure from flat PostgreSQL rows
   * Returns: { containers: { early_out: [...], high: [...], low: [...] } }
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

      // Group rows by priority
      const containers: { [key: string]: any[] } = {
        early_out: [],
        high: [],
        low: []
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
        if (row.lat !== null) task.lat = parseFloat(String(row.lat));
        if (row.lng !== null) task.lng = parseFloat(String(row.lng));
        if (row.cleaning_time) task.cleaning_time = row.cleaning_time;
        if (row.checkin_date) task.checkin_date = row.checkin_date;
        if (row.checkout_date) task.checkout_date = row.checkout_date;
        if (row.checkin_time) task.checkin_time = row.checkin_time;
        if (row.checkout_time) task.checkout_time = row.checkout_time;
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

        // Add to appropriate priority bucket
        const priority = row.priority || 'low';
        if (!containers[priority]) containers[priority] = [];
        containers[priority].push(task);
      }

      console.log(`✅ PG: Containers caricati per ${workDate} (${result.rows.length} task)`);
      return { containers };
    } catch (error) {
      console.error('❌ PG: Errore nel caricamento containers:', error);
      return null;
    }
  }

  /**
   * Save containers for a work_date
   * Converts JSON structure to flat PostgreSQL rows
   * Input: { containers: { early_out: [...], high: [...], low: [...] } }
   */
  async saveContainers(workDate: string, containersData: any): Promise<boolean> {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Delete existing containers for this date
      await client.query('DELETE FROM daily_containers WHERE work_date = $1', [workDate]);
      
      const containers = containersData?.containers || {};
      let totalInserted = 0;
      
      // Insert tasks for each priority
      for (const priority of ['early_out', 'high', 'low']) {
        const tasks = containers[priority] || [];
        
        for (const task of tasks) {
          if (!task.task_id) continue;
          
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
            task.reasons || []
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
          straordinaria, type_apt, alias, customer_name, reasons
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
          $20, $21, $22, $23, $24
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
        task.reasons || []
      ]);
      
      console.log(`✅ PG: Task ${task.task_id} aggiunto ai containers (${priority}) per ${workDate}`);
      return true;
    } catch (error) {
      console.error('❌ PG: Errore nell\'aggiunta task a containers:', error);
      return false;
    }
  }

  // ==================== SELECTED CLEANERS ====================

  /**
   * Load selected cleaners for a work_date
   */
  async loadSelectedCleaners(workDate: string): Promise<any[] | null> {
    try {
      const result = await query(
        'SELECT cleaners FROM daily_selected_cleaners WHERE work_date = $1',
        [workDate]
      );
      if (result.rows.length > 0 && result.rows[0].cleaners) {
        console.log(`✅ PG: Selected cleaners caricati per ${workDate}`);
        return result.rows[0].cleaners;
      }
      return null;
    } catch (error) {
      console.error('❌ PG: Errore nel caricamento selected cleaners:', error);
      return null;
    }
  }

  /**
   * Save selected cleaners for a work_date (upsert)
   */
  async saveSelectedCleaners(workDate: string, cleaners: any[]): Promise<boolean> {
    try {
      await query(`
        INSERT INTO daily_selected_cleaners (work_date, cleaners, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (work_date) 
        DO UPDATE SET cleaners = $2, updated_at = NOW()
      `, [workDate, JSON.stringify(cleaners)]);
      console.log(`✅ PG: Selected cleaners salvati per ${workDate}`);
      return true;
    } catch (error) {
      console.error('❌ PG: Errore nel salvataggio selected cleaners:', error);
      return false;
    }
  }
}

export const pgDailyAssignmentsService = new PgDailyAssignmentsService();
