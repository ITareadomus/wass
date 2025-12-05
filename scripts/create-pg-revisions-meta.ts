import pool from '../shared/pg-db';

async function createRevisionsMetaTable() {
  const client = await pool.connect();
  try {
    // Create a metadata table to track revisions reliably
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_assignments_revisions (
        id SERIAL PRIMARY KEY,
        work_date DATE NOT NULL,
        revision INTEGER NOT NULL,
        task_count INTEGER DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        created_by VARCHAR(100) DEFAULT 'system',
        modification_type VARCHAR(100),
        UNIQUE(work_date, revision)
      );
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_revisions_work_date 
      ON daily_assignments_revisions(work_date, revision DESC);
    `);
    
    console.log('✅ Table daily_assignments_revisions created successfully');
    
    // Verify
    const result = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'daily_assignments_revisions' 
      ORDER BY ordinal_position;
    `);
    console.log('Columns:', result.rows.map(r => r.column_name).join(', '));
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

createRevisionsMetaTable();
