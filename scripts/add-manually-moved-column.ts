import dotenv from 'dotenv';
import path from 'path';

if (process.env.NODE_ENV !== 'production') {
  const envPath = path.resolve(process.cwd(), '.env.local');
  dotenv.config({ path: envPath, override: true });
}

async function addManuallyMovedColumn() {
  const { default: pool } = await import('../shared/pg-db');

  console.log('Connessione a PostgreSQL...');
  const client = await pool.connect();

  try {
    const checkColumn = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'daily_assignments_current'
          AND column_name = 'manually_moved'
      );
    `);

    if (!checkColumn.rows[0].exists) {
      console.log('Aggiunta colonna manually_moved a daily_assignments_current...');
      await client.query(`
        ALTER TABLE daily_assignments_current
        ADD COLUMN IF NOT EXISTS manually_moved BOOLEAN NOT NULL DEFAULT false;
      `);
      console.log('Colonna manually_moved aggiunta a daily_assignments_current.');
    } else {
      console.log('La colonna manually_moved esiste già in daily_assignments_current.');
    }

    const checkHistory = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'daily_assignments_history'
          AND column_name = 'manually_moved'
      );
    `);
    if (!checkHistory.rows[0].exists) {
      console.log('Aggiunta colonna manually_moved a daily_assignments_history...');
      await client.query(`
        ALTER TABLE daily_assignments_history
        ADD COLUMN IF NOT EXISTS manually_moved BOOLEAN NOT NULL DEFAULT false;
      `);
      console.log('Colonna manually_moved aggiunta a daily_assignments_history.');
    } else {
      console.log('La colonna manually_moved esiste già in daily_assignments_history.');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

addManuallyMovedColumn()
  .then(() => console.log('Migrazione completata.'))
  .catch((err) => {
    console.error('Errore:', err);
    process.exit(1);
  });
