import dotenv from 'dotenv';
import { resolve } from 'path';

if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: resolve(process.cwd(), '.env.local') });
}

/**
 * Tabelle convocati driver logistica (separate da housekeeping).
 * Run: npx tsx scripts/create-pg-lg-selected-drivers.ts
 */
async function main() {
  const { default: pool } = await import('../shared/pg-db');
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS lg_selected_drivers (
        id SERIAL PRIMARY KEY,
        work_date DATE NOT NULL UNIQUE,
        drivers INTEGER[] NOT NULL DEFAULT '{}',
        vehicle_assignments JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      ALTER TABLE lg_selected_drivers
      ADD COLUMN IF NOT EXISTS vehicle_assignments JSONB NOT NULL DEFAULT '{}'::jsonb;
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lg_selected_drivers_work_date ON lg_selected_drivers(work_date);
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS lg_selected_drivers_revision (
        id SERIAL PRIMARY KEY,
        selected_drivers_id INTEGER NOT NULL REFERENCES lg_selected_drivers(id) ON DELETE CASCADE,
        work_date DATE NOT NULL,
        revision_number INTEGER NOT NULL,
        drivers_before INTEGER[] NOT NULL DEFAULT '{}',
        drivers_after INTEGER[] NOT NULL DEFAULT '{}',
        vehicle_assignments_before JSONB NOT NULL DEFAULT '{}'::jsonb,
        vehicle_assignments_after JSONB NOT NULL DEFAULT '{}'::jsonb,
        action_type VARCHAR(30) NOT NULL,
        action_payload JSONB,
        performed_by VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (selected_drivers_id, revision_number)
      );
    `);
    await client.query(`
      ALTER TABLE lg_selected_drivers_revision
      ADD COLUMN IF NOT EXISTS vehicle_assignments_before JSONB NOT NULL DEFAULT '{}'::jsonb;
    `);
    await client.query(`
      ALTER TABLE lg_selected_drivers_revision
      ADD COLUMN IF NOT EXISTS vehicle_assignments_after JSONB NOT NULL DEFAULT '{}'::jsonb;
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lg_sel_drivers_rev_work_date
      ON lg_selected_drivers_revision(work_date);
    `);
    console.log('✅ lg_selected_drivers + lg_selected_drivers_revision OK');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
