import pool from "../../../shared/pg-db";
import {
  defaultHkProfileLibrary,
  parseHkConstraintSettings,
  parseHkProfileLibrary,
  type HkConstraintSettings,
  type HkProfileLibrary,
} from "../../../shared/hk-constraint-settings";

async function readAppSettings(): Promise<Record<string, unknown> | null> {
  const result = await pool.query(`SELECT value FROM app_settings WHERE key = 'app_settings' LIMIT 1`);
  const value = result.rows[0]?.value;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export async function loadHkConstraintSettings(): Promise<HkConstraintSettings> {
  try {
    const value = await readAppSettings();
    return parseHkConstraintSettings(value?.hk_constraints);
  } catch (error) {
    console.warn("[hk-constraints] Impostazioni non lette, uso il profilo bilanciato:", error);
    return parseHkConstraintSettings(null);
  }
}

export async function loadHkProfileLibrary(): Promise<HkProfileLibrary> {
  try {
    const value = await readAppSettings();
    return parseHkProfileLibrary(value?.hk_profiles, value?.hk_constraints);
  } catch (error) {
    console.warn("[hk-constraints] Profili non letti, uso i tre profili di base:", error);
    return defaultHkProfileLibrary();
  }
}
