
import { Client } from '@replit/object-storage';

// Usa il bucket wass_assignments
const client = new Client();

export async function saveAssignmentToStorage(filename: string, data: any): Promise<void> {
  try {
    const jsonData = JSON.stringify(data, null, 2);
    await client.uploadFromText(filename, jsonData);
    console.log(`✅ Salvato ${filename} su Object Storage`);
  } catch (error: any) {
    console.error(`❌ Errore salvando ${filename} su Object Storage:`, error.message);
    throw error;
  }
}

export async function loadAssignmentFromStorage(filename: string): Promise<any> {
  try {
    const data = await client.downloadAsText(filename);
    return JSON.parse(data);
  } catch (error: any) {
    if (error.message?.includes('404') || error.message?.includes('not found')) {
      console.log(`ℹ️  File ${filename} non trovato su Object Storage`);
      return null;
    }
    console.error(`❌ Errore caricando ${filename} da Object Storage:`, error.message);
    throw error;
  }
}

export async function deleteAssignmentFromStorage(filename: string): Promise<void> {
  try {
    await client.delete(filename);
    console.log(`🗑️  Eliminato ${filename} da Object Storage`);
  } catch (error: any) {
    console.warn(`⚠️  Errore eliminando ${filename}:`, error.message);
  }
}
