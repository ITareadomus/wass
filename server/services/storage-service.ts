import { Client } from "@replit/object-storage";

const BUCKET = "wass_assignments";

export interface WorkspaceFile {
  timeline?: any;
  containers?: any;
  selectedCleaners?: any;
}

/**
 * StorageService - Wraps Replit Object Storage for workspace and confirmed assignments
 * 
 * Directory structure:
 * - workspace/YYYY-MM-DD/timeline.json - Current work in progress
 * - workspace/YYYY-MM-DD/containers.json - Unassigned tasks
 * - workspace/YYYY-MM-DD/selected_cleaners.json - Selected cleaners for the day
 * - confirmed/DD-MM-YYYY/assignments_DDMMYY.json - Confirmed assignments (existing)
 */
export class StorageService {
  private client: Client;

  constructor() {
    this.client = new Client();
  }

  /**
   * Build workspace key for a given date and file type
   * @param workDate ISO date string (YYYY-MM-DD)
   * @param fileType timeline | containers | selected_cleaners
   */
  private buildWorkspaceKey(workDate: string, fileType: 'timeline' | 'containers' | 'selected_cleaners'): string {
    return `workspace/${workDate}/${fileType}.json`;
  }

  /**
   * Build confirmed key (backward compatible with existing structure)
   * @param workDate ISO date string (YYYY-MM-DD)
   */
  private buildConfirmedKey(workDate: string): string {
    const d = new Date(workDate);
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const fullYear = String(d.getFullYear());
    const year = fullYear.slice(-2);
    const folder = `${day}-${month}-${fullYear}`;
    const filename = `assignments_${day}${month}${year}.json`;
    return `${folder}/${filename}`;
  }

  /**
   * Get workspace timeline for a specific date
   */
  async getWorkspaceTimeline(workDate: string): Promise<any | null> {
    try {
      const key = this.buildWorkspaceKey(workDate, 'timeline');
      const result = await this.client.downloadAsText(key);
      
      if (!result.ok) {
        return null;
      }

      return JSON.parse(result.value);
    } catch (error) {
      console.error(`Error getting workspace timeline for ${workDate}:`, error);
      return null;
    }
  }

  /**
   * Save workspace timeline for a specific date
   */
  async saveWorkspaceTimeline(workDate: string, data: any): Promise<boolean> {
    try {
      const key = this.buildWorkspaceKey(workDate, 'timeline');
      const jsonContent = JSON.stringify(data, null, 2);
      const result = await this.client.uploadFromText(key, jsonContent);
      
      if (!result.ok) {
        console.error(`Failed to save workspace timeline: ${result.error}`);
        return false;
      }

      return true;
    } catch (error) {
      console.error(`Error saving workspace timeline for ${workDate}:`, error);
      return false;
    }
  }

  /**
   * Get workspace containers for a specific date
   */
  async getWorkspaceContainers(workDate: string): Promise<any | null> {
    try {
      const key = this.buildWorkspaceKey(workDate, 'containers');
      const result = await this.client.downloadAsText(key);
      
      if (!result.ok) {
        return null;
      }

      return JSON.parse(result.value);
    } catch (error) {
      console.error(`Error getting workspace containers for ${workDate}:`, error);
      return null;
    }
  }

  /**
   * Save workspace containers for a specific date
   */
  async saveWorkspaceContainers(workDate: string, data: any): Promise<boolean> {
    try {
      const key = this.buildWorkspaceKey(workDate, 'containers');
      const jsonContent = JSON.stringify(data, null, 2);
      const result = await this.client.uploadFromText(key, jsonContent);
      
      if (!result.ok) {
        console.error(`Failed to save workspace containers: ${result.error}`);
        return false;
      }

      return true;
    } catch (error) {
      console.error(`Error saving workspace containers for ${workDate}:`, error);
      return false;
    }
  }

  /**
   * Get selected cleaners for a specific date
   */
  async getWorkspaceSelectedCleaners(workDate: string): Promise<any | null> {
    try {
      const key = this.buildWorkspaceKey(workDate, 'selected_cleaners');
      const result = await this.client.downloadAsText(key);
      
      if (!result.ok) {
        return null;
      }

      return JSON.parse(result.value);
    } catch (error) {
      console.error(`Error getting workspace selected cleaners for ${workDate}:`, error);
      return null;
    }
  }

  /**
   * Save selected cleaners for a specific date
   */
  async saveWorkspaceSelectedCleaners(workDate: string, data: any): Promise<boolean> {
    try {
      const key = this.buildWorkspaceKey(workDate, 'selected_cleaners');
      const jsonContent = JSON.stringify(data, null, 2);
      const result = await this.client.uploadFromText(key, jsonContent);
      
      if (!result.ok) {
        console.error(`Failed to save workspace selected cleaners: ${result.error}`);
        return false;
      }

      return true;
    } catch (error) {
      console.error(`Error saving workspace selected cleaners for ${workDate}:`, error);
      return false;
    }
  }

  /**
   * Check if confirmed assignments exist for a date
   */
  async hasConfirmedAssignments(workDate: string): Promise<boolean> {
    try {
      const key = this.buildConfirmedKey(workDate);
      const result = await this.client.downloadAsText(key);
      return result.ok;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get confirmed assignments (backward compatible)
   */
  async getConfirmedAssignments(workDate: string): Promise<any | null> {
    try {
      const key = this.buildConfirmedKey(workDate);
      const result = await this.client.downloadAsText(key);
      
      if (!result.ok) {
        return null;
      }

      return JSON.parse(result.value);
    } catch (error) {
      console.error(`Error getting confirmed assignments for ${workDate}:`, error);
      return null;
    }
  }

  /**
   * Save confirmed assignments (backward compatible)
   */
  async saveConfirmedAssignments(workDate: string, timelineData: any, selectedCleanersData: any): Promise<{success: boolean, key?: string, error?: string}> {
    try {
      const key = this.buildConfirmedKey(workDate);
      const jsonContent = JSON.stringify(timelineData, null, 2);
      const result = await this.client.uploadFromText(key, jsonContent);
      
      if (!result.ok) {
        return { success: false, error: String(result.error || 'Unknown error') };
      }

      // Also save selected_cleaners for the same date
      const d = new Date(workDate);
      const day = String(d.getDate()).padStart(2, "0");
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const fullYear = String(d.getFullYear());
      const year = fullYear.slice(-2);
      const folderPath = `${day}-${month}-${fullYear}`;
      const scKey = `${folderPath}/selected_cleaners_${day}${month}${year}.json`;

      const scJson = JSON.stringify(selectedCleanersData, null, 2);
      const scResult = await this.client.uploadFromText(scKey, scJson);
      
      if (!scResult.ok) {
        return { success: false, error: String(scResult.error || 'Error saving selected_cleaners') };
      }

      return { success: true, key };
    } catch (error: any) {
      console.error(`Error saving confirmed assignments for ${workDate}:`, error);
      return { success: false, error: error.message };
    }
  }
}

// Singleton instance
export const storageService = new StorageService();
