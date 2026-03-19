import dotenv from 'dotenv';
import { resolve } from 'path';

/** Stesso caricamento env del server (server/index.ts) prima di importare pg-db */
if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: resolve(process.cwd(), '.env.local') });
}

/**
 * WASS Logistics: mirror of daily_containers + history + revisions (housekeeping stack).
 * Run dalla root del repo: npx tsx scripts/create-pg-logistics-containers.ts
 */
async function createLogisticsContainersTables() {
  const { default: pool } = await import('../shared/pg-db');
  const client = await pool.connect();
  try {
    console.log('📝 Creating daily_logistics_containers tables...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_logistics_containers (
        id SERIAL PRIMARY KEY,
        work_date DATE NOT NULL,
        priority VARCHAR(20) NOT NULL,
        task_id INTEGER NOT NULL,
        logistic_code INTEGER NOT NULL,
        client_id INTEGER,
        premium BOOLEAN DEFAULT FALSE,
        address TEXT,
        lat VARCHAR(20),
        lng VARCHAR(20),
        cleaning_time INTEGER DEFAULT 0,
        checkin_date DATE,
        checkout_date DATE,
        checkin_time VARCHAR(10),
        checkout_time VARCHAR(10),
        pax_in INTEGER,
        pax_out INTEGER,
        small_equipment BOOLEAN DEFAULT FALSE,
        operation_id INTEGER,
        confirmed_operation BOOLEAN DEFAULT FALSE,
        straordinaria BOOLEAN DEFAULT FALSE,
        type_apt VARCHAR(10),
        alias VARCHAR(50),
        customer_name VARCHAR(255),
        reasons TEXT[] DEFAULT '{}',
        customer_reference TEXT,
        locked BOOLEAN DEFAULT FALSE,
        locked_reason TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(work_date, task_id)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_logistics_containers_work_date_priority
      ON daily_logistics_containers(work_date, priority);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_logistics_containers_task_id
      ON daily_logistics_containers(task_id);
    `);

    console.log('📝 Creating daily_logistics_containers_revisions...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_logistics_containers_revisions (
        id SERIAL PRIMARY KEY,
        work_date DATE NOT NULL,
        revision INTEGER NOT NULL,
        task_count INTEGER DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        created_by VARCHAR(100) DEFAULT 'system',
        modification_type VARCHAR(50) DEFAULT 'manual',
        UNIQUE(work_date, revision)
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_logistics_containers_revisions_work_date
      ON daily_logistics_containers_revisions(work_date, revision DESC);
    `);

    console.log('📝 Creating daily_logistics_containers_history...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_logistics_containers_history (
        id SERIAL PRIMARY KEY,
        work_date DATE NOT NULL,
        revision INTEGER NOT NULL,
        priority VARCHAR(20) NOT NULL,
        task_id INTEGER NOT NULL,
        logistic_code INTEGER NOT NULL,
        client_id INTEGER,
        premium BOOLEAN DEFAULT FALSE,
        address TEXT,
        lat VARCHAR(20),
        lng VARCHAR(20),
        cleaning_time INTEGER DEFAULT 0,
        checkin_date DATE,
        checkout_date DATE,
        checkin_time VARCHAR(10),
        checkout_time VARCHAR(10),
        pax_in INTEGER,
        pax_out INTEGER,
        small_equipment BOOLEAN DEFAULT FALSE,
        operation_id INTEGER,
        confirmed_operation BOOLEAN DEFAULT FALSE,
        straordinaria BOOLEAN DEFAULT FALSE,
        type_apt VARCHAR(10),
        alias VARCHAR(50),
        customer_name VARCHAR(255),
        reasons TEXT[] DEFAULT '{}',
        customer_reference TEXT,
        locked BOOLEAN DEFAULT FALSE,
        locked_reason TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        created_by VARCHAR(100) DEFAULT 'system'
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_logistics_containers_history_work_rev
      ON daily_logistics_containers_history(work_date, revision DESC);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_logistics_containers_history_task_id
      ON daily_logistics_containers_history(task_id);
    `);

    console.log('✅ Logistics containers tables created successfully');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

createLogisticsContainersTables();
