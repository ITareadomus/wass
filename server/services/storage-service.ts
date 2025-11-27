import { Client } from "@replit/object-storage";

/**
 * StorageService - Simplified storage using single assignments_data.json
 * 
 * Directory structure:
 * - DD-MM-YYYY/assignments_data.json - Contains { selected_cleaners: [...], timeline: {...} }
 * 
 * Every modification saves immediately to Object Storage.
 */
export class StorageService {
  private client: Client;

  constructor() {
    this.client = new Client();
  }

  /**
   * Build key for a given date: DD-MM-YYYY/assignments_data.json
   */
  private buildKey(workDate: string): string {
    const d = new Date(workDate);
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const fullYear = String(d.getFullYear());
    const folder = `${day}-${month}-${fullYear}`;
    return `${folder}/assignments_data.json`;
  }

  /**
   * Get complete data for a specific date
   */
  async getData(workDate: string): Promise<{ selected_cleaners: any[], timeline: any } | null> {
    try {
      const key = this.buildKey(workDate);
      const result = await this.client.downloadAsText(key);
      
      if (!result.ok) {
        console.log(`ℹ️ No data found for ${workDate} at ${key}`);
        return null;
      }

      const data = JSON.parse(result.value);
      console.log(`✅ Data loaded from Object Storage: ${key}`);
      return data;
    } catch (error) {
      console.error(`Error getting data for ${workDate}:`, error);
      return null;
    }
  }

  /**
   * Save complete data for a specific date
   */
  async saveData(workDate: string, data: { selected_cleaners: any[], timeline: any }): Promise<boolean> {
    try {
      const key = this.buildKey(workDate);
      
      // Add metadata
      data.timeline = data.timeline || {};
      data.timeline.metadata = data.timeline.metadata || {};
      data.timeline.metadata.date = workDate;
      data.timeline.metadata.last_updated = new Date().toISOString();
      
      const jsonContent = JSON.stringify(data, null, 2);
      const result = await this.client.uploadFromText(key, jsonContent);
      
      if (!result.ok) {
        console.error(`Failed to save data: ${result.error}`);
        return false;
      }

      console.log(`✅ Data saved to Object Storage: ${key}`);
      return true;
    } catch (error) {
      console.error(`Error saving data for ${workDate}:`, error);
      return false;
    }
  }

  /**
   * Get only selected_cleaners for a specific date
   */
  async getSelectedCleaners(workDate: string): Promise<any[] | null> {
    const data = await this.getData(workDate);
    return data?.selected_cleaners || null;
  }

  /**
   * Save selected_cleaners - merges with existing timeline
   */
  async saveSelectedCleaners(workDate: string, selectedCleaners: any[]): Promise<boolean> {
    const existing = await this.getData(workDate);
    const data = {
      selected_cleaners: selectedCleaners,
      timeline: existing?.timeline || {
        metadata: { date: workDate, last_updated: new Date().toISOString() },
        cleaners_assignments: [],
        meta: { total_cleaners: 0, used_cleaners: 0, assigned_tasks: 0 }
      }
    };
    return this.saveData(workDate, data);
  }

  /**
   * Get only timeline for a specific date
   */
  async getTimeline(workDate: string): Promise<any | null> {
    const data = await this.getData(workDate);
    return data?.timeline || null;
  }

  /**
   * Save timeline - merges with existing selected_cleaners
   */
  async saveTimeline(workDate: string, timeline: any): Promise<boolean> {
    const existing = await this.getData(workDate);
    const data = {
      selected_cleaners: existing?.selected_cleaners || [],
      timeline: timeline
    };
    return this.saveData(workDate, data);
  }

  /**
   * Reset timeline only (keep selected_cleaners)
   */
  async resetTimeline(workDate: string): Promise<boolean> {
    const existing = await this.getData(workDate);
    const emptyTimeline = {
      metadata: { date: workDate, last_updated: new Date().toISOString(), created_by: 'system' },
      cleaners_assignments: [],
      meta: { total_cleaners: 0, used_cleaners: 0, assigned_tasks: 0 }
    };
    const data = {
      selected_cleaners: existing?.selected_cleaners || [],
      timeline: emptyTimeline
    };
    return this.saveData(workDate, data);
  }

  /**
   * Check if any data exists for a date
   */
  async hasData(workDate: string): Promise<boolean> {
    const data = await this.getData(workDate);
    return data !== null;
  }

  /**
   * Check if timeline has assignments
   */
  async hasAssignments(workDate: string): Promise<boolean> {
    const data = await this.getData(workDate);
    if (!data?.timeline?.cleaners_assignments) return false;
    return data.timeline.cleaners_assignments.some((c: any) => c.tasks && c.tasks.length > 0);
  }

  /**
   * Delete all data for a specific date
   */
  async deleteData(workDate: string): Promise<boolean> {
    try {
      const key = this.buildKey(workDate);
      const result = await this.client.delete(key);
      
      if (result.ok) {
        console.log(`✅ Data deleted: ${key}`);
        return true;
      }
      
      console.log(`ℹ️ Data not found or already deleted: ${key}`);
      return true;
    } catch (error) {
      console.error(`Error deleting data for ${workDate}:`, error);
      return false;
    }
  }

  /**
   * List all dates that have data
   */
  async listDates(): Promise<string[]> {
    try {
      const result = await this.client.list();
      
      if (!result.ok) {
        return [];
      }
      
      const dates = new Set<string>();
      for (const key of result.value) {
        // Extract date from DD-MM-YYYY/assignments_data.json
        const match = key.match(/^(\d{2})-(\d{2})-(\d{4})\/assignments_data\.json$/);
        if (match) {
          // Convert DD-MM-YYYY to YYYY-MM-DD
          const isoDate = `${match[3]}-${match[2]}-${match[1]}`;
          dates.add(isoDate);
        }
      }
      
      return Array.from(dates).sort();
    } catch (error) {
      console.error('Error listing dates:', error);
      return [];
    }
  }
}

// Singleton instance
export const storageService = new StorageService();
