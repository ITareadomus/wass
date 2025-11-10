import * as fs from 'fs/promises';
import path from 'path';
import { storageService } from './storage-service';

/**
 * Workspace Files Helper
 * 
 * Centralizes read/write operations for timeline.json, containers.json, and selected_cleaners.json
 * Implements hybrid storage: filesystem (for local dev) + Object Storage (for production persistence)
 * 
 * Read strategy: Try filesystem first, fallback to Object Storage
 * Write strategy: Write to filesystem AND Object Storage (dual write for persistence)
 */

const PATHS = {
  timeline: path.join(process.cwd(), 'client/public/data/output/timeline.json'),
  containers: path.join(process.cwd(), 'client/public/data/output/containers.json'),
  selectedCleaners: path.join(process.cwd(), 'client/public/data/cleaners/selected_cleaners.json'),
};

/**
 * Atomically write JSON to file using tmp + rename pattern
 */
async function atomicWriteJson(filePath: string, data: any): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmpPath, filePath);
}

/**
 * Load timeline.json for a specific work date
 * Priority: filesystem → Object Storage → null
 */
export async function loadTimeline(workDate: string): Promise<any | null> {
  try {
    // Try filesystem first
    const data = await fs.readFile(PATHS.timeline, 'utf-8');
    const parsed = JSON.parse(data);
    
    // Accept file from filesystem if:
    // 1. It has matching metadata.date, OR
    // 2. It has NO metadata (legacy format), OR
    // 3. It has cleaners_assignments (valid timeline structure)
    const hasMatchingDate = parsed.metadata?.date === workDate;
    const hasNoMetadata = !parsed.metadata;
    const hasValidStructure = parsed.cleaners_assignments || parsed.assignments;
    
    if (hasMatchingDate || hasNoMetadata || hasValidStructure) {
      // Ensure metadata exists (migration for legacy files)
      if (!parsed.metadata) {
        parsed.metadata = {
          date: workDate,
          last_updated: new Date().toISOString()
        };
      } else if (!parsed.metadata.date) {
        parsed.metadata.date = workDate;
      }
      
      console.log(`✅ Timeline loaded from filesystem for ${workDate}`);
      return parsed;
    }
  } catch (err) {
    // Filesystem read failed, try Object Storage
  }

  // Fallback to Object Storage
  try {
    const storageData = await storageService.getWorkspaceTimeline(workDate);
    if (storageData) {
      console.log(`✅ Timeline loaded from Object Storage for ${workDate}`);
      // Write to filesystem for subsequent reads
      await atomicWriteJson(PATHS.timeline, storageData);
      return storageData;
    }
  } catch (err) {
    console.error(`Error loading timeline from Object Storage:`, err);
  }

  console.log(`ℹ️ No timeline found for ${workDate}`);
  return null;
}

/**
 * Save timeline.json for a specific work date
 * Writes to BOTH filesystem and Object Storage
 */
export async function saveTimeline(workDate: string, data: any): Promise<boolean> {
  try {
    // Ensure metadata contains the correct date
    data.metadata = data.metadata || {};
    data.metadata.date = workDate;
    data.metadata.last_updated = new Date().toISOString();

    // Write to filesystem (synchronous for API compatibility)
    await atomicWriteJson(PATHS.timeline, data);
    console.log(`✅ Timeline saved to filesystem for ${workDate}`);

    // Write to Object Storage (async, don't block on failure)
    storageService.saveWorkspaceTimeline(workDate, data)
      .then((success) => {
        if (success) {
          console.log(`✅ Timeline persisted to Object Storage for ${workDate}`);
        } else {
          console.warn(`⚠️ Failed to persist timeline to Object Storage for ${workDate}`);
        }
      })
      .catch((err) => {
        console.error(`❌ Error persisting timeline to Object Storage:`, err);
      });

    return true;
  } catch (err) {
    console.error(`Error saving timeline for ${workDate}:`, err);
    return false;
  }
}

/**
 * Load containers.json for a specific work date
 * Priority: filesystem → Object Storage → null
 */
export async function loadContainers(workDate: string): Promise<any | null> {
  try {
    // Try filesystem first
    const data = await fs.readFile(PATHS.containers, 'utf-8');
    const parsed = JSON.parse(data);
    
    // Containers might not have metadata date, so just return if valid
    if (parsed.containers) {
      console.log(`✅ Containers loaded from filesystem for ${workDate}`);
      return parsed;
    }
  } catch (err) {
    // Filesystem read failed, try Object Storage
  }

  // Fallback to Object Storage
  try {
    const storageData = await storageService.getWorkspaceContainers(workDate);
    if (storageData) {
      console.log(`✅ Containers loaded from Object Storage for ${workDate}`);
      // Write to filesystem for subsequent reads
      await atomicWriteJson(PATHS.containers, storageData);
      return storageData;
    }
  } catch (err) {
    console.error(`Error loading containers from Object Storage:`, err);
  }

  console.log(`ℹ️ No containers found for ${workDate}`);
  return null;
}

/**
 * Save containers.json for a specific work date
 * Writes to BOTH filesystem and Object Storage
 */
export async function saveContainers(workDate: string, data: any): Promise<boolean> {
  try {
    // Write to filesystem (synchronous for API compatibility)
    await atomicWriteJson(PATHS.containers, data);
    console.log(`✅ Containers saved to filesystem for ${workDate}`);

    // Write to Object Storage (async, don't block on failure)
    storageService.saveWorkspaceContainers(workDate, data)
      .then((success) => {
        if (success) {
          console.log(`✅ Containers persisted to Object Storage for ${workDate}`);
        } else {
          console.warn(`⚠️ Failed to persist containers to Object Storage for ${workDate}`);
        }
      })
      .catch((err) => {
        console.error(`❌ Error persisting containers to Object Storage:`, err);
      });

    return true;
  } catch (err) {
    console.error(`Error saving containers for ${workDate}:`, err);
    return false;
  }
}

/**
 * Load selected_cleaners.json for a specific work date
 * Priority: filesystem → Object Storage → null
 */
export async function loadSelectedCleaners(workDate: string): Promise<any | null> {
  try {
    // Try filesystem first
    const data = await fs.readFile(PATHS.selectedCleaners, 'utf-8');
    const parsed = JSON.parse(data);
    
    // Verify the date matches if metadata exists
    if (!parsed.metadata?.date || parsed.metadata.date === workDate) {
      console.log(`✅ Selected cleaners loaded from filesystem for ${workDate}`);
      return parsed;
    }
  } catch (err) {
    // Filesystem read failed, try Object Storage
  }

  // Fallback to Object Storage
  try {
    const storageData = await storageService.getWorkspaceSelectedCleaners(workDate);
    if (storageData) {
      console.log(`✅ Selected cleaners loaded from Object Storage for ${workDate}`);
      // Write to filesystem for subsequent reads
      await atomicWriteJson(PATHS.selectedCleaners, storageData);
      return storageData;
    }
  } catch (err) {
    console.error(`Error loading selected cleaners from Object Storage:`, err);
  }

  console.log(`ℹ️ No selected cleaners found for ${workDate}`);
  return null;
}

/**
 * Save selected_cleaners.json for a specific work date
 * Writes to BOTH filesystem and Object Storage
 */
export async function saveSelectedCleaners(workDate: string, data: any): Promise<boolean> {
  try {
    // Ensure metadata contains the correct date
    data.metadata = data.metadata || {};
    data.metadata.date = workDate;
    data.metadata.last_updated = new Date().toISOString();

    // Write to filesystem (synchronous for API compatibility)
    await atomicWriteJson(PATHS.selectedCleaners, data);
    console.log(`✅ Selected cleaners saved to filesystem for ${workDate}`);

    // Write to Object Storage (async, don't block on failure)
    storageService.saveWorkspaceSelectedCleaners(workDate, data)
      .then((success) => {
        if (success) {
          console.log(`✅ Selected cleaners persisted to Object Storage for ${workDate}`);
        } else {
          console.warn(`⚠️ Failed to persist selected cleaners to Object Storage for ${workDate}`);
        }
      })
      .catch((err) => {
        console.error(`❌ Error persisting selected cleaners to Object Storage:`, err);
      });

    return true;
  } catch (err) {
    console.error(`Error saving selected cleaners for ${workDate}:`, err);
    return false;
  }
}

/**
 * Get raw file paths (for backward compatibility with existing code)
 */
export function getFilePaths() {
  return { ...PATHS };
}
