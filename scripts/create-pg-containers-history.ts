import pool from '../shared/pg-db';

/**
 * Create containers history tables for undo/rollback functionality
 * 
 * Architecture (same pattern as daily_assignments):
 * - daily_containers_revisions: Metadata per revision (work_date, revision, task_count, etc.)
 * - daily_containers_history: Actual container data for each revision (1 row per task per revision)
 * - daily_containers: Current state (already exists)
 */
async function createContainersHistoryTables() {
  const client = await pool.connect();
  try {
    console.log('📝 Creating containers history tables in PostgreSQL...');
    
    // 1. Create revisions metadata table
    console.log('📝 Creating daily_containers_revisions table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_containers_revisions (
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
      CREATE INDEX IF NOT EXISTS idx_containers_revisions_work_date 
      ON daily_containers_revisions(work_date, revision DESC);
    `);
    
    console.log('✅ daily_containers_revisions created');
    
    // 2. Create history table (1 row per task per revision)
    console.log('📝 Creating daily_containers_history table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_containers_history (
        id SERIAL PRIMARY KEY,
        work_date DATE NOT NULL,
        revision INTEGER NOT NULL,
        priority VARCHAR(20) NOT NULL,
        
        -- Task fields (same as daily_containers)
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
        
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        created_by VARCHAR(100) DEFAULT 'system'
      );
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_containers_history_work_date_revision 
      ON daily_containers_history(work_date, revision DESC);
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_containers_history_task_id 
      ON daily_containers_history(task_id);
    `);
    
    console.log('✅ daily_containers_history created');
    
    // Verify structure
    console.log('\n📋 Verifying tables...');
    
    const revisionsResult = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'daily_containers_revisions' 
      ORDER BY ordinal_position;
    `);
    console.log('daily_containers_revisions columns:', 
      revisionsResult.rows.map(r => r.column_name).join(', '));
    
    const historyResult = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'daily_containers_history' 
      ORDER BY ordinal_position;
    `);
    console.log('daily_containers_history columns:', 
      historyResult.rows.map(r => r.column_name).join(', '));
    
    console.log('\n✅ All containers history tables created successfully!');
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

createContainersHistoryTables();
