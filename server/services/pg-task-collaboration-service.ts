import { query } from '../../shared/pg-db';
import pool from '../../shared/pg-db';
import type { PoolClient } from 'pg';

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

    // Normalize cleaner_id to numbers for consistent comparisons
    const cleanerIds = result.rows.map((r: any) => Number(r.cleaner_id));
    const primaryRow = result.rows.find((r: any) => r.is_primary);

    return {
      cleanerIds,
      primaryCleanerId: primaryRow ? Number(primaryRow.cleaner_id) : null,
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
      const taskIdNum = Number(row.task_id);
      const cleanerIdNum = Number(row.cleaner_id);
      
      if (!map.has(taskIdNum)) {
        map.set(taskIdNum, {
          cleanerIds: [],
          primaryCleanerId: null,
          count: 0
        });
      }

      const info = map.get(taskIdNum)!;
      info.cleanerIds.push(cleanerIdNum);
      info.count++;
      if (row.is_primary) {
        info.primaryCleanerId = cleanerIdNum;
      }
    }

    return map;
  }

  /**
   * Reconcile task_collaborators from daily_assignments_current for a work_date.
   *
   * Goal: ensure the pivot table always matches the actual timeline assignments stored in DB.
   * - For task_ids assigned to >1 distinct cleaner_id in daily_assignments_current => ensure rows exist in task_collaborators
   * - For task_ids assigned to <=1 cleaner_id => ensure no rows exist in task_collaborators
   *
   * Primary selection:
   * - If an existing primary exists for the task and is still among collaborators, keep it
   * - Otherwise, pick the smallest cleaner_id deterministically
   *
   * Note: This intentionally favors correctness/consistency over preserving historical primary choices
   * in edge cases where the previous primary is no longer a collaborator.
   */
  async reconcileForWorkDate(workDate: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await this.reconcileForWorkDateTx(client, workDate);
      await client.query('COMMIT');
      console.log(`✅ Collaboration: Reconciled task_collaborators for ${workDate}`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Collaboration: Error reconciling collaborations:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Reconcile collaborators for a single task_id from assignments.
   * Useful to self-heal before applying collaboration-aware moves.
   */
  async reconcileTaskFromAssignments(workDate: string, taskId: number): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await this.reconcileTaskFromAssignmentsTx(client, workDate, taskId);
      await client.query('COMMIT');
      console.log(`✅ Collaboration: Reconciled task_collaborators for task ${taskId} on ${workDate}`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Collaboration: Error reconciling task collaboration:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  private async reconcileForWorkDateTx(client: PoolClient, workDate: string): Promise<void> {
    // Load existing primary per task (if any)
    const existingPrimary = await client.query(
      `SELECT task_id, cleaner_id
       FROM task_collaborators
       WHERE work_date = $1 AND is_primary = true`,
      [workDate]
    );
    const existingPrimaryMap = new Map<number, number>(
      existingPrimary.rows.map((r: any) => [Number(r.task_id), Number(r.cleaner_id)])
    );

    // Load collaborations from actual assignments in timeline DB
    const collabFromAssignments = await client.query(
      `SELECT task_id,
              array_agg(DISTINCT cleaner_id ORDER BY cleaner_id) AS cleaner_ids,
              COUNT(DISTINCT cleaner_id)::int AS collaborator_count
       FROM daily_assignments_current
       WHERE work_date = $1
       GROUP BY task_id
       HAVING COUNT(DISTINCT cleaner_id) > 1`,
      [workDate]
    );

    // Clear pivot for the date and rebuild from assignments
    await client.query('DELETE FROM task_collaborators WHERE work_date = $1', [workDate]);

    for (const row of collabFromAssignments.rows) {
      const taskIdNum = Number(row.task_id);
      const cleanerIds: number[] = (row.cleaner_ids || []).map((id: any) => Number(id));
      if (cleanerIds.length <= 1) continue;

      const existingPrimaryCleanerId = existingPrimaryMap.get(taskIdNum);
      const chosenPrimary =
        existingPrimaryCleanerId && cleanerIds.includes(existingPrimaryCleanerId)
          ? existingPrimaryCleanerId
          : cleanerIds[0];

      for (const cleanerId of cleanerIds) {
        await client.query(
          `INSERT INTO task_collaborators (work_date, task_id, cleaner_id, is_primary)
           VALUES ($1, $2, $3, $4)`,
          [workDate, taskIdNum, cleanerId, cleanerId === chosenPrimary]
        );
      }
    }
  }

  private async reconcileTaskFromAssignmentsTx(client: PoolClient, workDate: string, taskId: number): Promise<void> {
    // Existing primary for this task (if any)
    const existingPrimary = await client.query(
      `SELECT cleaner_id
       FROM task_collaborators
       WHERE work_date = $1 AND task_id = $2 AND is_primary = true
       LIMIT 1`,
      [workDate, taskId]
    );
    const existingPrimaryCleanerId =
      existingPrimary.rows.length > 0 ? Number(existingPrimary.rows[0].cleaner_id) : null;

    const fromAssignments = await client.query(
      `SELECT array_agg(DISTINCT cleaner_id ORDER BY cleaner_id) AS cleaner_ids,
              COUNT(DISTINCT cleaner_id)::int AS collaborator_count
       FROM daily_assignments_current
       WHERE work_date = $1 AND task_id = $2`,
      [workDate, taskId]
    );

    const cleanerIds: number[] = (fromAssignments.rows[0]?.cleaner_ids || []).map((id: any) => Number(id));
    const count: number = Number(fromAssignments.rows[0]?.collaborator_count || 0);

    // Remove any existing pivot for this task and rebuild only if collaborative
    await client.query(
      'DELETE FROM task_collaborators WHERE work_date = $1 AND task_id = $2',
      [workDate, taskId]
    );

    if (count <= 1 || cleanerIds.length <= 1) {
      return;
    }

    const chosenPrimary =
      existingPrimaryCleanerId && cleanerIds.includes(existingPrimaryCleanerId)
        ? existingPrimaryCleanerId
        : cleanerIds[0];

    for (const cleanerId of cleanerIds) {
      await client.query(
        `INSERT INTO task_collaborators (work_date, task_id, cleaner_id, is_primary)
         VALUES ($1, $2, $3, $4)`,
        [workDate, taskId, cleanerId, cleanerId === chosenPrimary]
      );
    }
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
   * Replace a collaborator with another cleaner (e.g., drag & drop to change collaborator)
   * If the old cleaner was primary, the new cleaner becomes primary.
   * Returns false if destCleanerId is already a collaborator (would create 3+ collaborators).
   */
  async replaceCollaborator(
    workDate: string,
    taskId: number,
    sourceCleanerId: number,
    destCleanerId: number
  ): Promise<{ success: boolean; error?: string }> {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Check if destCleanerId is already a collaborator
      const existsCheck = await client.query(
        `SELECT 1 FROM task_collaborators 
         WHERE work_date = $1 AND task_id = $2 AND cleaner_id = $3`,
        [workDate, taskId, destCleanerId]
      );

      if (existsCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        console.warn(`⚠️ Collaboration: Cleaner ${destCleanerId} is already a collaborator on task ${taskId}`);
        return { 
          success: false, 
          error: 'DEST_ALREADY_COLLABORATOR' 
        };
      }

      // Check if sourceCleanerId exists and was primary
      const sourceCheck = await client.query(
        `SELECT is_primary FROM task_collaborators 
         WHERE work_date = $1 AND task_id = $2 AND cleaner_id = $3`,
        [workDate, taskId, sourceCleanerId]
      );

      // Fail if source collaborator doesn't exist
      if (sourceCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        console.warn(`⚠️ Collaboration: Source cleaner ${sourceCleanerId} is not a collaborator on task ${taskId}`);
        return { 
          success: false, 
          error: 'SOURCE_NOT_COLLABORATOR' 
        };
      }

      const wasPrimary = sourceCheck.rows[0].is_primary;

      // Delete old collaborator
      await client.query(
        `DELETE FROM task_collaborators 
         WHERE work_date = $1 AND task_id = $2 AND cleaner_id = $3`,
        [workDate, taskId, sourceCleanerId]
      );

      // Insert new collaborator (inherits primary status)
      await client.query(
        `INSERT INTO task_collaborators (work_date, task_id, cleaner_id, is_primary)
         VALUES ($1, $2, $3, $4)`,
        [workDate, taskId, destCleanerId, wasPrimary]
      );

      // Aggiorna anche cleaner_id in daily_assignments_current per riflettere lo spostamento nella timeline
      const updateResult = await client.query(
        `UPDATE daily_assignments_current 
         SET cleaner_id = $1 
         WHERE work_date = $2 AND task_id = $3 AND cleaner_id = $4`,
        [destCleanerId, workDate, taskId, sourceCleanerId]
      );
      console.log(`📝 Collaboration: Updated ${updateResult.rowCount} row(s) in daily_assignments_current`);

      await client.query('COMMIT');
      console.log(`✅ Collaboration: Replaced cleaner ${sourceCleanerId} with ${destCleanerId} for task ${taskId} (primary: ${wasPrimary})`);
      return { success: true };

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Collaboration: Error replacing collaborator:', error);
      throw error;
    } finally {
      client.release();
    }
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
