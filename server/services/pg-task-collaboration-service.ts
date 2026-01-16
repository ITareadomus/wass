import { query } from '../../shared/pg-db';
import pool from '../../shared/pg-db';

export interface CollaborationInfo {
  cleanerIds: number[];
  primaryCleanerId: number | null;
  count: number;
}

export interface CollaboratorRow {
  work_date: string;
  task_id: number;
  cleaner_id: number;
  is_primary: boolean;
  created_at: Date;
}

export class PgTaskCollaborationService {

  /**
   * Get collaboration info for a specific task
   */
  async getCollaboration(workDate: string, taskId: number): Promise<CollaborationInfo> {
    const result = await query(
      `SELECT cleaner_id, is_primary 
       FROM task_collaborators 
       WHERE work_date = $1 AND task_id = $2
       ORDER BY is_primary DESC, cleaner_id`,
      [workDate, taskId]
    );

    const cleanerIds = result.rows.map((r: any) => r.cleaner_id);
    const primaryRow = result.rows.find((r: any) => r.is_primary);

    return {
      cleanerIds,
      primaryCleanerId: primaryRow?.cleaner_id ?? null,
      count: cleanerIds.length
    };
  }

  /**
   * Get all collaborations for a work_date as a Map (task_id -> CollaborationInfo)
   * Optimized single query for timeline loading
   */
  async getCollaborationsMap(workDate: string): Promise<Map<number, CollaborationInfo>> {
    const result = await query(
      `SELECT task_id, cleaner_id, is_primary 
       FROM task_collaborators 
       WHERE work_date = $1
       ORDER BY task_id, is_primary DESC, cleaner_id`,
      [workDate]
    );

    const map = new Map<number, CollaborationInfo>();

    for (const row of result.rows) {
      if (!map.has(row.task_id)) {
        map.set(row.task_id, {
          cleanerIds: [],
          primaryCleanerId: null,
          count: 0
        });
      }

      const info = map.get(row.task_id)!;
      info.cleanerIds.push(row.cleaner_id);
      info.count++;
      if (row.is_primary) {
        info.primaryCleanerId = row.cleaner_id;
      }
    }

    return map;
  }

  /**
   * Set collaborators for a task (replace all existing)
   * @param cleanerIds Array of cleaner IDs that will work on this task
   * @param primaryCleanerId ID of the primary cleaner (must be in cleanerIds)
   */
  async setCollaborators(
    workDate: string,
    taskId: number,
    cleanerIds: number[],
    primaryCleanerId?: number | null
  ): Promise<void> {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Delete existing collaborators
      await client.query(
        'DELETE FROM task_collaborators WHERE work_date = $1 AND task_id = $2',
        [workDate, taskId]
      );

      // Insert new collaborators
      for (const cleanerId of cleanerIds) {
        const isPrimary = primaryCleanerId === cleanerId;
        await client.query(
          `INSERT INTO task_collaborators (work_date, task_id, cleaner_id, is_primary)
           VALUES ($1, $2, $3, $4)`,
          [workDate, taskId, cleanerId, isPrimary]
        );
      }

      await client.query('COMMIT');
      console.log(`✅ Collaboration: Set ${cleanerIds.length} collaborators for task ${taskId} on ${workDate}`);

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Collaboration: Error setting collaborators:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Add a collaborator to a task
   * @param makePrimary If true, this cleaner becomes primary (removes primary from others)
   */
  async addCollaborator(
    workDate: string,
    taskId: number,
    cleanerId: number,
    makePrimary: boolean = false
  ): Promise<void> {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // If making this cleaner primary, remove primary from others first
      if (makePrimary) {
        await client.query(
          `UPDATE task_collaborators 
           SET is_primary = false 
           WHERE work_date = $1 AND task_id = $2`,
          [workDate, taskId]
        );
      }

      // Insert or update the collaborator
      await client.query(
        `INSERT INTO task_collaborators (work_date, task_id, cleaner_id, is_primary)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (work_date, task_id, cleaner_id)
         DO UPDATE SET is_primary = EXCLUDED.is_primary`,
        [workDate, taskId, cleanerId, makePrimary]
      );

      await client.query('COMMIT');
      console.log(`✅ Collaboration: Added cleaner ${cleanerId} to task ${taskId} (primary: ${makePrimary})`);

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Collaboration: Error adding collaborator:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Remove a collaborator from a task
   * If the removed cleaner was primary, no new primary is auto-assigned
   */
  async removeCollaborator(
    workDate: string,
    taskId: number,
    cleanerId: number
  ): Promise<void> {
    await query(
      'DELETE FROM task_collaborators WHERE work_date = $1 AND task_id = $2 AND cleaner_id = $3',
      [workDate, taskId, cleanerId]
    );
    console.log(`✅ Collaboration: Removed cleaner ${cleanerId} from task ${taskId}`);
  }

  /**
   * Clear all collaborators for a task
   */
  async clearCollaborators(workDate: string, taskId: number): Promise<void> {
    await query(
      'DELETE FROM task_collaborators WHERE work_date = $1 AND task_id = $2',
      [workDate, taskId]
    );
    console.log(`✅ Collaboration: Cleared all collaborators for task ${taskId}`);
  }

  /**
   * Check if a task has collaboration (more than 1 cleaner)
   */
  async hasCollaboration(workDate: string, taskId: number): Promise<boolean> {
    const result = await query(
      'SELECT COUNT(*) as count FROM task_collaborators WHERE work_date = $1 AND task_id = $2',
      [workDate, taskId]
    );
    return parseInt(result.rows[0]?.count || '0') > 1;
  }

  /**
   * Set primary cleaner for a task (must already be a collaborator)
   */
  async setPrimaryCollaborator(
    workDate: string,
    taskId: number,
    cleanerId: number
  ): Promise<boolean> {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Check if the cleaner is already a collaborator
      const checkResult = await client.query(
        `SELECT 1 FROM task_collaborators 
         WHERE work_date = $1 AND task_id = $2 AND cleaner_id = $3`,
        [workDate, taskId, cleanerId]
      );

      if (checkResult.rows.length === 0) {
        await client.query('ROLLBACK');
        console.warn(`⚠️ Collaboration: Cleaner ${cleanerId} is not a collaborator on task ${taskId}`);
        return false;
      }

      // Remove primary from all collaborators
      await client.query(
        `UPDATE task_collaborators 
         SET is_primary = false 
         WHERE work_date = $1 AND task_id = $2`,
        [workDate, taskId]
      );

      // Set new primary
      await client.query(
        `UPDATE task_collaborators 
         SET is_primary = true 
         WHERE work_date = $1 AND task_id = $2 AND cleaner_id = $3`,
        [workDate, taskId, cleanerId]
      );

      await client.query('COMMIT');
      console.log(`✅ Collaboration: Set cleaner ${cleanerId} as primary for task ${taskId}`);
      return true;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Collaboration: Error setting primary:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Calculate effective cleaning time based on collaborator count
   * Formula: ceil(baseTime / collaboratorCount)
   */
  calculateEffectiveCleaningTime(baseCleaningTime: number, collaboratorCount: number): number {
    if (collaboratorCount <= 1) {
      return baseCleaningTime;
    }
    return Math.ceil(baseCleaningTime / collaboratorCount);
  }
}

export const taskCollaborationService = new PgTaskCollaborationService();
