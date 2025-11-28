import { mysqlDb } from "../../shared/mysql-db";
import { RowDataPacket } from "mysql2";

export interface DailyAssignmentRevision {
  id: number;
  work_date: string;
  revision: number;
  selected_cleaners: any;
  timeline: any;
  created_at: Date;
}

export class DailyAssignmentRevisionsService {
  async getLatestRevision(workDate: string): Promise<DailyAssignmentRevision | null> {
    try {
      const [rows] = await mysqlDb.execute<RowDataPacket[]>(
        `SELECT * FROM daily_assignment_revisions 
         WHERE work_date = ? 
         ORDER BY revision DESC 
         LIMIT 1`,
        [workDate]
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
        created_at: row.created_at
      };
    } catch (error) {
      console.error("Error getting latest revision:", error);
      return null;
    }
  }

  async getAllRevisions(workDate: string): Promise<DailyAssignmentRevision[]> {
    try {
      const [rows] = await mysqlDb.execute<RowDataPacket[]>(
        `SELECT * FROM daily_assignment_revisions 
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
        created_at: row.created_at
      }));
    } catch (error) {
      console.error("Error getting all revisions:", error);
      return [];
    }
  }

  async getRevisionByNumber(workDate: string, revisionNumber: number): Promise<DailyAssignmentRevision | null> {
    try {
      const [rows] = await mysqlDb.execute<RowDataPacket[]>(
        `SELECT * FROM daily_assignment_revisions 
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
        created_at: row.created_at
      };
    } catch (error) {
      console.error("Error getting revision by number:", error);
      return null;
    }
  }

  async createRevision(
    workDate: string, 
    timeline: any, 
    selectedCleaners: any
  ): Promise<number> {
    try {
      const latest = await this.getLatestRevision(workDate);
      const nextRevision = latest ? latest.revision + 1 : 1;

      const timelineJson = JSON.stringify(timeline || {});
      const selectedCleanersJson = JSON.stringify(selectedCleaners || []);

      await mysqlDb.execute(
        `INSERT INTO daily_assignment_revisions 
         (work_date, revision, timeline, selected_cleaners) 
         VALUES (?, ?, ?, ?)`,
        [workDate, nextRevision, timelineJson, selectedCleanersJson]
      );

      console.log(`✅ Created revision ${nextRevision} for ${workDate}`);
      return nextRevision;
    } catch (error) {
      console.error("Error creating revision:", error);
      throw error;
    }
  }

  async deleteOldRevisions(workDate: string, keepLast: number = 10): Promise<number> {
    try {
      const [result] = await mysqlDb.execute<any>(
        `DELETE FROM daily_assignment_revisions 
         WHERE work_date = ? 
         AND revision NOT IN (
           SELECT revision FROM (
             SELECT revision FROM daily_assignment_revisions 
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
}

export const dailyAssignmentRevisionsService = new DailyAssignmentRevisionsService();
