import pool from '../shared/pg-db';

async function addChangeTrackingColumns() {
  const client = await pool.connect();
  try {
    console.log('📝 Adding change tracking columns to daily_assignments_revisions...');
    
    await client.query(`
      ALTER TABLE daily_assignments_revisions 
      ADD COLUMN IF NOT EXISTS edited_fields TEXT[] DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS old_values TEXT[] DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS new_values TEXT[] DEFAULT '{}';
    `);
    
    console.log('✅ Columns added successfully');
    
    const result = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'daily_assignments_revisions' 
      ORDER BY ordinal_position;
    `);
    console.log('Current columns:', result.rows.map(r => `${r.column_name} (${r.data_type})`).join(', '));
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

addChangeTrackingColumns();
