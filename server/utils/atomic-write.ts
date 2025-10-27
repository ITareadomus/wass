
import fs from 'fs/promises';
import path from 'path';

/**
 * Scrive un file in modo atomico usando write-temp-rename
 */
export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  const dir = path.dirname(filePath);
  
  // Assicurati che la directory esista
  await fs.mkdir(dir, { recursive: true });
  
  try {
    // Scrivi nel file temporaneo
    await fs.writeFile(tmpPath, data, 'utf8');
    
    // Rinomina atomicamente
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    // Pulisci il file temporaneo in caso di errore
    try {
      await fs.unlink(tmpPath);
    } catch {}
    throw error;
  }
}

/**
 * Legge e parsa un file JSON in modo sicuro
 */
export async function readJsonFile<T>(filePath: string, defaultValue: T): Promise<T> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    return defaultValue;
  }
}

/**
 * Scrive un oggetto come JSON in modo atomico
 */
export async function writeJsonFileAtomic(filePath: string, data: any): Promise<void> {
  const content = JSON.stringify(data, null, 2);
  await writeFileAtomic(filePath, content);
}
