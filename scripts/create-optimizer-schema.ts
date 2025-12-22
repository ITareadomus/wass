import pg from 'pg';

const { Pool } = pg;

async function createOptimizerSchema() {
  const pool = new Pool({
    host: process.env.PG_HOST,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
    port: parseInt(process.env.PG_PORT || '25060'),
    ssl: {
      rejectUnauthorized: false
    }
  });

  try {
    console.log('🚀 Creazione schema optimizer...');

    // 1) Schema dedicato
    await pool.query(`CREATE SCHEMA IF NOT EXISTS optimizer;`);
    console.log('✅ Schema "optimizer" creato');

    // 2) Tabella optimizer_run
    await pool.query(`
      CREATE TABLE IF NOT EXISTS optimizer.optimizer_run (
        run_id uuid PRIMARY KEY,
        work_date date NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        algorithm_version text NOT NULL,
        params jsonb NOT NULL,
        status text NOT NULL CHECK (status IN ('success','partial','failed')),
        summary jsonb
      );
    `);
    console.log('✅ Tabella optimizer.optimizer_run creata');

    // 3) Tabella optimizer_decision
    await pool.query(`
      CREATE TABLE IF NOT EXISTS optimizer.optimizer_decision (
        id bigserial PRIMARY KEY,
        run_id uuid NOT NULL REFERENCES optimizer.optimizer_run(run_id) ON DELETE CASCADE,
        phase smallint NOT NULL,
        event_type text NOT NULL,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    console.log('✅ Tabella optimizer.optimizer_decision creata');

    // 4) Tabella optimizer_assignment
    await pool.query(`
      CREATE TABLE IF NOT EXISTS optimizer.optimizer_assignment (
        run_id uuid NOT NULL REFERENCES optimizer.optimizer_run(run_id) ON DELETE CASCADE,
        cleaner_id integer NOT NULL,
        task_id integer NOT NULL,
        sequence smallint NOT NULL,
        start_time timestamptz,
        end_time timestamptz,
        travel_minutes_from_prev integer,
        reasons text[],
        PRIMARY KEY (run_id, task_id)
      );
    `);
    console.log('✅ Tabella optimizer.optimizer_assignment creata');

    // 5) Tabella optimizer_unassigned
    await pool.query(`
      CREATE TABLE IF NOT EXISTS optimizer.optimizer_unassigned (
        run_id uuid NOT NULL REFERENCES optimizer.optimizer_run(run_id) ON DELETE CASCADE,
        task_id integer NOT NULL,
        reason_code text NOT NULL,
        details jsonb,
        PRIMARY KEY (run_id, task_id)
      );
    `);
    console.log('✅ Tabella optimizer.optimizer_unassigned creata');

    // 6) Indici
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_optimizer_run_work_date
        ON optimizer.optimizer_run(work_date);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_optimizer_assignment_run_cleaner
        ON optimizer.optimizer_assignment(run_id, cleaner_id);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_optimizer_decision_run_phase
        ON optimizer.optimizer_decision(run_id, phase);
    `);
    console.log('✅ Indici creati');

    // 7) Verifica
    const result = await pool.query(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema = 'optimizer'
      ORDER BY table_name;
    `);
    
    console.log('\n📋 Tabelle nello schema optimizer:');
    result.rows.forEach(row => {
      console.log(`   - ${row.table_schema}.${row.table_name}`);
    });

    console.log('\n🎉 Schema optimizer creato con successo!');
  } catch (error) {
    console.error('❌ Errore durante la creazione dello schema:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

createOptimizerSchema();
