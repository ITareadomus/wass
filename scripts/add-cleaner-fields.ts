import pool from '../shared/pg-db';

async function addCleanerFields() {
  const client = await pool.connect();
  try {
    // Add cleaner fields to daily_assignments_current
    await client.query(`
      ALTER TABLE daily_assignments_current 
      ADD COLUMN IF NOT EXISTS cleaner_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS cleaner_lastname VARCHAR(255),
      ADD COLUMN IF NOT EXISTS cleaner_role VARCHAR(100),
      ADD COLUMN IF NOT EXISTS cleaner_premium BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS cleaner_start_time VARCHAR(10) DEFAULT '10:00';
    `);
    
    // Add same fields to daily_assignments_history
    await client.query(`
      ALTER TABLE daily_assignments_history 
      ADD COLUMN IF NOT EXISTS cleaner_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS cleaner_lastname VARCHAR(255),
      ADD COLUMN IF NOT EXISTS cleaner_role VARCHAR(100),
      ADD COLUMN IF NOT EXISTS cleaner_premium BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS cleaner_start_time VARCHAR(10) DEFAULT '10:00';
    `);
    
    console.log('✅ Cleaner fields added to both tables');
    
    // Verify columns
    const result = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'daily_assignments_current' 
      AND column_name LIKE 'cleaner_%'
      ORDER BY ordinal_position;
    `);
    console.log('New cleaner columns:', result.rows.map(r => r.column_name).join(', '));
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

addCleanerFields();
