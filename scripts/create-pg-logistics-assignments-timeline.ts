import dotenv from 'dotenv';
import { resolve } from 'path';

/** Stesso caricamento env del server (server/index.ts) prima di importare pg-db */
if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: resolve(process.cwd(), '.env.local') });
}

/**
 * WASS Logistics: timeline parallela a daily_assignments_* (current + history + revisions).
 * Colonne `driver_*` al posto di `cleaner_*` / `cleaner_id`, stessa semantica degli INSERT in
 * server/services/pg-daily-assignments-service.ts (saveTimeline / saveToHistory).
 *
 * Run dalla root del repo: npx tsx scripts/create-pg-logistics-assignments-timeline.ts
 */
async function createLogisticsAssignmentsTimelineTables() {
  const { default: pool } = await import('../shared/pg-db');
  const client = await pool.connect();
  try {
    console.log('📝 Creating lg_timeline_revision...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS lg_timeline_revision (
        id SERIAL PRIMARY KEY,
        work_date DATE NOT NULL,
        revision INTEGER NOT NULL,
        task_count INTEGER DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        created_by VARCHAR(100) DEFAULT 'system',
        modification_type VARCHAR(100),
        edited_fields TEXT[] DEFAULT '{}',
        old_values TEXT[] DEFAULT '{}',
        new_values TEXT[] DEFAULT '{}',
        UNIQUE(work_date, revision)
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lg_timeline_revision_work_date
      ON lg_timeline_revision(work_date, revision DESC);
    `);

    console.log('📝 Creating lg_timeline...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS lg_timeline (
        id BIGSERIAL PRIMARY KEY,
        work_date DATE NOT NULL,
        driver_id INTEGER NOT NULL,
        driver_name VARCHAR(255),
        driver_lastname VARCHAR(255),
        driver_role VARCHAR(100),
        driver_premium BOOLEAN DEFAULT FALSE,
        driver_start_time VARCHAR(10) DEFAULT '10:00',
        driver_end_time VARCHAR(10) DEFAULT '20:00',
        task_id INTEGER NOT NULL,
        logistic_code INTEGER NOT NULL,
        client_id INTEGER,
        premium BOOLEAN NOT NULL DEFAULT FALSE,
        address TEXT NOT NULL DEFAULT '',
        lat NUMERIC(9, 6),
        lng NUMERIC(9, 6),
        cleaning_time INTEGER NOT NULL DEFAULT 0,
        base_cleaning_time INTEGER,
        checkin_date DATE,
        checkout_date DATE,
        checkin_time VARCHAR(10),
        checkout_time VARCHAR(10),
        pax_in INTEGER,
        pax_out INTEGER,
        small_equipment BOOLEAN,
        operation_id INTEGER,
        confirmed_operation BOOLEAN,
        straordinaria BOOLEAN,
        type_apt VARCHAR(100),
        alias VARCHAR(255),
        customer_name VARCHAR(255),
        customer_reference TEXT,
        reasons TEXT[] NOT NULL DEFAULT '{}',
        manually_moved BOOLEAN NOT NULL DEFAULT FALSE,
        priority VARCHAR(50),
        start_time VARCHAR(10),
        end_time VARCHAR(10),
        followup BOOLEAN,
        sequence INTEGER NOT NULL DEFAULT 0,
        travel_time INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lg_timeline_work_date
      ON lg_timeline(work_date);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lg_timeline_driver_date
      ON lg_timeline(driver_id, work_date);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lg_timeline_task
      ON lg_timeline(task_id);
    `);

    console.log('📝 Creating lg_timeline_history...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS lg_timeline_history (
        id SERIAL PRIMARY KEY,
        work_date DATE NOT NULL,
        revision INTEGER NOT NULL,
        driver_id INTEGER NOT NULL,
        driver_name VARCHAR(255),
        driver_lastname VARCHAR(255),
        driver_role VARCHAR(100),
        driver_premium BOOLEAN DEFAULT FALSE,
        driver_start_time VARCHAR(10) DEFAULT '10:00',
        driver_end_time VARCHAR(10) DEFAULT '20:00',
        task_id INTEGER NOT NULL,
        logistic_code INTEGER NOT NULL,
        client_id INTEGER,
        premium BOOLEAN NOT NULL DEFAULT FALSE,
        address TEXT NOT NULL DEFAULT '',
        lat NUMERIC(9, 6),
        lng NUMERIC(9, 6),
        cleaning_time INTEGER NOT NULL DEFAULT 0,
        base_cleaning_time INTEGER,
        checkin_date DATE,
        checkout_date DATE,
        checkin_time VARCHAR(10),
        checkout_time VARCHAR(10),
        pax_in INTEGER,
        pax_out INTEGER,
        small_equipment BOOLEAN,
        operation_id INTEGER,
        confirmed_operation BOOLEAN,
        straordinaria BOOLEAN,
        type_apt VARCHAR(100),
        alias VARCHAR(255),
        customer_name VARCHAR(255),
        customer_reference TEXT,
        reasons TEXT[] NOT NULL DEFAULT '{}',
        manually_moved BOOLEAN NOT NULL DEFAULT FALSE,
        priority VARCHAR(50),
        start_time VARCHAR(10),
        end_time VARCHAR(10),
        followup BOOLEAN,
        sequence INTEGER NOT NULL DEFAULT 0,
        travel_time INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        created_by VARCHAR(100) DEFAULT 'system'
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_lg_timeline_history_work_rev
      ON lg_timeline_history(work_date, revision DESC);
    `);

    console.log('✅ Logistics assignments timeline tables created successfully');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

createLogisticsAssignmentsTimelineTables();
