import pool from '../shared/pg-db';

async function createHistoryTable() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_assignments_history (
        id SERIAL PRIMARY KEY,
        work_date DATE NOT NULL,
        revision INTEGER NOT NULL,
        cleaner_id INTEGER NOT NULL,
        task_id INTEGER NOT NULL,
        logistic_code INTEGER NOT NULL,
        client_id INTEGER,
        premium BOOLEAN DEFAULT false,
        address TEXT NOT NULL,
        lat DECIMAL(10, 7),
        lng DECIMAL(10, 7),
        cleaning_time INTEGER NOT NULL,
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
        reasons TEXT[] DEFAULT '{}',
        priority VARCHAR(50),
        start_time VARCHAR(10),
        end_time VARCHAR(10),
        followup BOOLEAN,
        sequence INTEGER DEFAULT 0,
        travel_time INTEGER DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        created_by VARCHAR(100) DEFAULT 'system'
      );
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_history_work_date_revision 
      ON daily_assignments_history(work_date, revision DESC);
    `);
    
    console.log('✅ Table daily_assignments_history created successfully');
    
    const result = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'daily_assignments_history' 
      ORDER BY ordinal_position;
    `);
    console.log('Columns:', result.rows.length);
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

createHistoryTable();
