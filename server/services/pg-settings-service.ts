import { query } from '../../shared/pg-db';

export class PgSettingsService {

  async ensureTables(): Promise<void> {
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
      console.log('✅ PG: Tabella app_settings verificata/creata');
    } catch (error) {
      console.error('❌ PG: Errore nella creazione tabella app_settings:', error);
    }
  }

  async getSettings(key: string): Promise<any | null> {
    try {
      const result = await query('SELECT value FROM app_settings WHERE key = $1', [key]);
      return result.rows[0]?.value || null;
    } catch (error) {
      console.error(`❌ PG: Errore nel caricamento settings ${key}:`, error);
      return null;
    }
  }

  async saveSettings(key: string, value: any): Promise<boolean> {
    try {
      await query(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
      `, [key, JSON.stringify(value)]);
      console.log(`✅ PG: Settings ${key} salvate`);
      return true;
    } catch (error) {
      console.error(`❌ PG: Errore nel salvataggio settings ${key}:`, error);
      return false;
    }
  }

  async getAllSettings(): Promise<Record<string, any>> {
    try {
      const result = await query('SELECT key, value FROM app_settings');
      const settings: Record<string, any> = {};
      for (const row of result.rows) {
        settings[row.key] = row.value;
      }
      return settings;
    } catch (error) {
      console.error('❌ PG: Errore nel caricamento di tutte le settings:', error);
      return {};
    }
  }
}

export const pgSettingsService = new PgSettingsService();
