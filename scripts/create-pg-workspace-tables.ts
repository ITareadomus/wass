import pool from '../shared/pg-db';

async function createWorkspaceTables() {
  const client = await pool.connect();
  try {
    console.log('📝 Creating workspace tables in PostgreSQL...');
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_containers (
        id SERIAL PRIMARY KEY,
        work_date DATE NOT NULL,
        containers JSONB DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(work_date)
      );
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_selected_cleaners (
        id SERIAL PRIMARY KEY,
        work_date DATE NOT NULL,
        cleaners JSONB DEFAULT '[]',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(work_date)
      );
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_containers_work_date ON daily_containers(work_date);
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_selected_cleaners_work_date ON daily_selected_cleaners(work_date);
    `);
    
    console.log('✅ Tables created successfully');
    
    const result = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name LIKE 'daily_%'
      ORDER BY table_name;
    `);
    console.log('PostgreSQL tables:', result.rows.map(r => r.table_name).join(', '));
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

createWorkspaceTables();
