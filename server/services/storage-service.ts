/**
 * StorageService - DEPRECATED
 * 
 * This service has been replaced by MySQL storage via daily-assignment-revisions-service.ts
 * Keeping stubs for backward compatibility with any remaining imports.
 * All actual storage is now handled by MySQL.
 */

export interface WorkspaceFile {
  timeline?: any;
  containers?: any;
  selectedCleaners?: any;
}

export class StorageService {
  async getWorkspaceTimeline(workDate: string): Promise<any | null> {
    console.log(`[DEPRECATED] storageService.getWorkspaceTimeline called - use MySQL instead`);
    return null;
  }

  async saveWorkspaceTimeline(workDate: string, data: any): Promise<boolean> {
    console.log(`[DEPRECATED] storageService.saveWorkspaceTimeline called - use MySQL instead`);
    return true;
  }

  async getWorkspaceContainers(workDate: string): Promise<any | null> {
    console.log(`[DEPRECATED] storageService.getWorkspaceContainers called - use MySQL instead`);
    return null;
  }

  async saveWorkspaceContainers(workDate: string, data: any): Promise<boolean> {
    console.log(`[DEPRECATED] storageService.saveWorkspaceContainers called - use MySQL instead`);
    return true;
  }

  async getWorkspaceSelectedCleaners(workDate: string): Promise<any | null> {
    console.log(`[DEPRECATED] storageService.getWorkspaceSelectedCleaners called - use MySQL instead`);
    return null;
  }

  async saveWorkspaceSelectedCleaners(workDate: string, data: any): Promise<boolean> {
    console.log(`[DEPRECATED] storageService.saveWorkspaceSelectedCleaners called - use MySQL instead`);
    return true;
  }

  async hasConfirmedAssignments(workDate: string): Promise<boolean> {
    return false;
  }

  async deleteWorkspaceFiles(workDate: string): Promise<{success: boolean, deletedFiles: string[], errors: string[]}> {
    return { success: true, deletedFiles: [], errors: [] };
  }

  async listWorkspaceDates(): Promise<string[]> {
    return [];
  }

  async getConfirmedAssignments(workDate: string): Promise<any | null> {
    return null;
  }

  async saveConfirmedAssignments(workDate: string, timelineData: any, selectedCleanersData: any): Promise<{success: boolean, key?: string, error?: string}> {
    return { success: true };
  }

  async getData(workDate: string): Promise<any | null> {
    return null;
  }

  async saveData(workDate: string, data: any): Promise<boolean> {
    return true;
  }

  async hasAssignments(workDate: string): Promise<boolean> {
    return false;
  }
}

export const storageService = new StorageService();
