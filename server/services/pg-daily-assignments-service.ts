import pool, { query } from '../../shared/pg-db';

export interface PgDailyAssignmentRow {
  id?: number;
  work_date: string;
  cleaner_id: number;
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
          cleaner_id: Number(cleaner.id),
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

      // Insert new rows
      for (const row of rows) {
        await client.query(`
          INSERT INTO daily_assignments_current (
            work_date, cleaner_id, task_id, logistic_code, client_id,
            premium, address, lat, lng, cleaning_time,
            checkin_date, checkout_date, checkin_time, checkout_time,
            pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
            type_apt, alias, customer_name, reasons, priority,
            start_time, end_time, followup, sequence, travel_time
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10,
            $11, $12, $13, $14,
            $15, $16, $17, $18, $19, $20,
            $21, $22, $23, $24, $25,
            $26, $27, $28, $29, $30
          )
        `, [
          row.work_date,
          row.cleaner_id,
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
   * Get all assignments for a work_date
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
   * Get the next revision number for a work_date
   */
  async getNextRevision(workDate: string): Promise<number> {
    try {
      const result = await query(
        'SELECT COALESCE(MAX(revision), 0) + 1 as next_revision FROM daily_assignments_history WHERE work_date = $1',
        [workDate]
      );
      return parseInt(result.rows[0]?.next_revision || '1');
    } catch (error) {
      console.error('❌ PG: Errore nel calcolo revisione:', error);
      return 1;
    }
  }

  /**
   * Save timeline to history (audit/rollback purposes)
   * Direct write from memory - no JSON intermediate
   */
  async saveToHistory(workDate: string, timeline: any, createdBy: string = 'system'): Promise<number> {
    const client = await pool.connect();
    
    try {
      const rows = this.timelineToRows(workDate, timeline);
      const revision = await this.getNextRevision(workDate);
      
      console.log(`📜 PG History: Salvando revisione ${revision} con ${rows.length} righe per ${workDate}...`);

      await client.query('BEGIN');

      if (rows.length === 0) {
        await client.query('COMMIT');
        console.log(`✅ PG History: Nessuna assegnazione da salvare per ${workDate} (rev ${revision})`);
        return revision;
      }

      for (const row of rows) {
        await client.query(`
          INSERT INTO daily_assignments_history (
            work_date, revision, cleaner_id, task_id, logistic_code, client_id,
            premium, address, lat, lng, cleaning_time,
            checkin_date, checkout_date, checkin_time, checkout_time,
            pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
            type_apt, alias, customer_name, reasons, priority,
            start_time, end_time, followup, sequence, travel_time, created_by
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11,
            $12, $13, $14, $15,
            $16, $17, $18, $19, $20, $21,
            $22, $23, $24, $25, $26,
            $27, $28, $29, $30, $31, $32
          )
        `, [
          row.work_date,
          revision,
          row.cleaner_id,
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
   */
  async getHistoryRevisions(workDate: string): Promise<{ revision: number; created_at: Date; created_by: string; task_count: number }[]> {
    try {
      const result = await query(`
        SELECT revision, MIN(created_at) as created_at, MIN(created_by) as created_by, COUNT(*) as task_count
        FROM daily_assignments_history 
        WHERE work_date = $1
        GROUP BY revision
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
}

export const pgDailyAssignmentsService = new PgDailyAssignmentsService();
