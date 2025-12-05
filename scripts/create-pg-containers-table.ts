import pool from '../shared/pg-db';

async function createContainersTable() {
  const client = await pool.connect();
  try {
    console.log('📝 Creating daily_containers table in PostgreSQL...');
    
    // Drop old JSONB-based table first
    console.log('🗑️ Dropping old daily_containers table (if exists)...');
    await client.query(`DROP TABLE IF EXISTS daily_containers;`);
    
    console.log('📝 Creating new structured daily_containers table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_containers (
        id SERIAL PRIMARY KEY,
        work_date DATE NOT NULL,
        priority VARCHAR(20) NOT NULL,
        bucket_rank INTEGER DEFAULT 0,
        
        -- Task fields (same as daily_assignments_current)
        task_id INTEGER NOT NULL,
        logistic_code INTEGER NOT NULL,
        client_id INTEGER,
        premium BOOLEAN DEFAULT FALSE,
        address TEXT,
        lat NUMERIC(10,7),
        lng NUMERIC(10,7),
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
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        
        UNIQUE(work_date, task_id)
      );
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_containers_work_date_priority 
      ON daily_containers(work_date, priority, bucket_rank);
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_containers_task_id 
      ON daily_containers(task_id);
    `);
    
    console.log('✅ Table daily_containers created successfully');
    
    // Drop old JSONB-based table if exists
    await client.query(`DROP TABLE IF EXISTS daily_containers_old;`);
    
    // Verify structure
    const result = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'daily_containers' 
      ORDER BY ordinal_position;
    `);
    console.log('Columns:', result.rows.map(r => `${r.column_name} (${r.data_type})`).join(', '));
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

createContainersTable();
