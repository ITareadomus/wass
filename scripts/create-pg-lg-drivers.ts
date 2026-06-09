import dotenv from "dotenv";
import { resolve } from "path";

if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: resolve(process.cwd(), ".env.local") });
}

/**
 * Roster autisti logistica (ADAM user_role_id = 9) — tabella lg_drivers.
 * Run: npx tsx scripts/create-pg-lg-drivers.ts
 */
async function main() {
  const { default: pool } = await import("../shared/pg-db");
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS lg_drivers (
        id SERIAL PRIMARY KEY,
        driver_id INTEGER NOT NULL,
        work_date DATE NOT NULL,
        name VARCHAR(255) NOT NULL,
        lastname VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'Driver',
        active BOOLEAN DEFAULT true,
        ranking INTEGER DEFAULT 0,
        counter_hours DECIMAL(6,2) DEFAULT 0,
        counter_days INTEGER DEFAULT 0,
        available BOOLEAN DEFAULT true,
        contract_type VARCHAR(50),
        preferred_customers INTEGER[] DEFAULT '{}',
        telegram_id BIGINT,
        start_time VARCHAR(10) DEFAULT '10:00',
        end_time VARCHAR(10) NOT NULL DEFAULT '20:00',
        can_do_straordinaria BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(driver_id, work_date)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_lg_drivers_work_date ON lg_drivers(work_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_lg_drivers_driver_id ON lg_drivers(driver_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_lg_drivers_active ON lg_drivers(active)`);
    console.log("✅ lg_drivers OK");
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
