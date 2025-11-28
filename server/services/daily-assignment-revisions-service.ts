import { mysqlDb } from "../../shared/mysql-db";
import { RowDataPacket } from "mysql2";

export interface DailyAssignmentCurrent {
  work_date: string;
  timeline: any;
  selected_cleaners: any;
  last_revision: number;
  updated_at: Date;
}

export interface DailyAssignmentRevision {
  id: number;
  work_date: string;
  revision: number;
  selected_cleaners: any;
  timeline: any;
  created_at: Date;
  created_by?: string;
}

/**
 * Two-table architecture service:
 * - daily_assignments_current: Fast access to current state (1 row per work_date)
 * - daily_assignments_history: All revisions for audit/rollback
 */
export class DailyAssignmentRevisionsService {
  
  /**
   * Get current state for a work_date (fast, no ORDER BY needed)
   */
  async getCurrent(workDate: string): Promise<DailyAssignmentCurrent | null> {
    try {
      const [rows] = await mysqlDb.execute<RowDataPacket[]>(
        `SELECT * FROM daily_assignments_current WHERE work_date = ?`,
        [workDate]
      );

      if (rows.length === 0) {
        return null;
      }

      const row = rows[0];
      return {
        work_date: row.work_date,
        timeline: typeof row.timeline === 'string' 
          ? JSON.parse(row.timeline) 
          : row.timeline,
        selected_cleaners: typeof row.selected_cleaners === 'string' 
          ? JSON.parse(row.selected_cleaners) 
          : row.selected_cleaners,
        last_revision: row.last_revision,
        updated_at: row.updated_at
      };
    } catch (error) {
      console.error("Error getting current state:", error);
      return null;
    }
  }

  /**
   * Alias for backward compatibility
   */
  async getLatestRevision(workDate: string): Promise<DailyAssignmentRevision | null> {
    const current = await this.getCurrent(workDate);
    if (!current) return null;
    
    return {
      id: 0,
      work_date: current.work_date,
      revision: current.last_revision,
      timeline: current.timeline,
      selected_cleaners: current.selected_cleaners,
      created_at: current.updated_at
    };
  }

  /**
   * Get all revisions for a work_date (for history/rollback)
   */
  async getAllRevisions(workDate: string): Promise<DailyAssignmentRevision[]> {
    try {
      const [rows] = await mysqlDb.execute<RowDataPacket[]>(
        `SELECT * FROM daily_assignments_history 
         WHERE work_date = ? 
         ORDER BY revision DESC`,
        [workDate]
      );

      return rows.map(row => ({
        id: row.id,
        work_date: row.work_date,
        revision: row.revision,
        selected_cleaners: typeof row.selected_cleaners === 'string' 
          ? JSON.parse(row.selected_cleaners) 
          : row.selected_cleaners,
        timeline: typeof row.timeline === 'string' 
          ? JSON.parse(row.timeline) 
          : row.timeline,
        created_at: row.created_at,
        created_by: row.created_by
      }));
    } catch (error) {
      console.error("Error getting all revisions:", error);
      return [];
    }
  }

  /**
   * Get a specific revision by number (for rollback)
   */
  async getRevisionByNumber(workDate: string, revisionNumber: number): Promise<DailyAssignmentRevision | null> {
    try {
      const [rows] = await mysqlDb.execute<RowDataPacket[]>(
        `SELECT * FROM daily_assignments_history 
         WHERE work_date = ? AND revision = ?`,
        [workDate, revisionNumber]
      );

      if (rows.length === 0) {
        return null;
      }

      const row = rows[0];
      return {
        id: row.id,
        work_date: row.work_date,
        revision: row.revision,
        selected_cleaners: typeof row.selected_cleaners === 'string' 
          ? JSON.parse(row.selected_cleaners) 
          : row.selected_cleaners,
        timeline: typeof row.timeline === 'string' 
          ? JSON.parse(row.timeline) 
          : row.timeline,
        created_at: row.created_at,
        created_by: row.created_by
      };
    } catch (error) {
      console.error("Error getting revision by number:", error);
      return null;
    }
  }

  /**
   * Save current state and create new revision
   * Updates current table + inserts into history table
   */
  async createRevision(
    workDate: string, 
    timeline: any, 
    selectedCleaners: any,
    createdBy: string = 'system'
  ): Promise<number> {
    try {
      const timelineJson = JSON.stringify(timeline || {});
      const selectedCleanersJson = JSON.stringify(selectedCleaners || []);

      // Get current revision number
      const current = await this.getCurrent(workDate);
      const nextRevision = current ? current.last_revision + 1 : 1;

      // Update current table (UPSERT)
      await mysqlDb.execute(
        `INSERT INTO daily_assignments_current 
         (work_date, timeline, selected_cleaners, last_revision) 
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE 
           timeline = VALUES(timeline),
           selected_cleaners = VALUES(selected_cleaners),
           last_revision = VALUES(last_revision),
           updated_at = CURRENT_TIMESTAMP`,
        [workDate, timelineJson, selectedCleanersJson, nextRevision]
      );

      // Insert into history table
      await mysqlDb.execute(
        `INSERT INTO daily_assignments_history 
         (work_date, revision, timeline, selected_cleaners, created_by) 
         VALUES (?, ?, ?, ?, ?)`,
        [workDate, nextRevision, timelineJson, selectedCleanersJson, createdBy]
      );

      console.log(`✅ Saved revision ${nextRevision} for ${workDate} (current + history)`);
      return nextRevision;
    } catch (error) {
      console.error("Error creating revision:", error);
      throw error;
    }
  }

  /**
   * Delete old revisions from history, keeping the last N
   */
  async deleteOldRevisions(workDate: string, keepLast: number = 10): Promise<number> {
    try {
      const [result] = await mysqlDb.execute<any>(
        `DELETE FROM daily_assignments_history 
         WHERE work_date = ? 
         AND revision NOT IN (
           SELECT revision FROM (
             SELECT revision FROM daily_assignments_history 
             WHERE work_date = ? 
             ORDER BY revision DESC 
             LIMIT ?
           ) AS recent
         )`,
        [workDate, workDate, keepLast]
      );

      const deletedCount = result.affectedRows || 0;
      if (deletedCount > 0) {
        console.log(`🗑️ Deleted ${deletedCount} old revisions for ${workDate}`);
      }
      return deletedCount;
    } catch (error) {
      console.error("Error deleting old revisions:", error);
      return 0;
    }
  }

  /**
   * Delete ALL data for a specific work_date (both current and history)
   */
  async deleteAllRevisionsForDate(workDate: string): Promise<number> {
    try {
      // Delete from current
      await mysqlDb.execute(
        `DELETE FROM daily_assignments_current WHERE work_date = ?`,
        [workDate]
      );

      // Delete from history
      const [result] = await mysqlDb.execute<any>(
        `DELETE FROM daily_assignments_history WHERE work_date = ?`,
        [workDate]
      );

      const deletedCount = result.affectedRows || 0;
      console.log(`🗑️ Deleted ALL data for ${workDate} (current + ${deletedCount} history records)`);
      return deletedCount;
    } catch (error) {
      console.error("Error deleting all revisions for date:", error);
      return 0;
    }
  }

  /**
   * Rollback to a specific revision
   * Copies the revision data to current table
   */
  async rollbackToRevision(workDate: string, revisionNumber: number): Promise<boolean> {
    try {
      const revision = await this.getRevisionByNumber(workDate, revisionNumber);
      if (!revision) {
        console.error(`Revision ${revisionNumber} not found for ${workDate}`);
        return false;
      }

      // Create a new revision with the rolled-back data
      await this.createRevision(
        workDate, 
        revision.timeline, 
        revision.selected_cleaners,
        `rollback_to_${revisionNumber}`
      );

      console.log(`🔄 Rolled back ${workDate} to revision ${revisionNumber}`);
      return true;
    } catch (error) {
      console.error("Error rolling back to revision:", error);
      return false;
    }
  }

  /**
   * Check if a work_date has any saved data
   */
  async hasData(workDate: string): Promise<boolean> {
    const current = await this.getCurrent(workDate);
    return current !== null;
  }
}

export const dailyAssignmentRevisionsService = new DailyAssignmentRevisionsService();
