import dotenv from 'dotenv';
import path from 'path';

// Carica .env.local in development PRIMA di importare pool
if (process.env.NODE_ENV !== 'production') {
  const envPath = path.resolve(process.cwd(), '.env.local');
  dotenv.config({ path: envPath, override: true });
}

async function addTaskCollaborators() {
  // Import dinamico dopo che dotenv ha caricato le variabili
  const { default: pool } = await import('../shared/pg-db');
  
  console.log('🔄 Connessione a PostgreSQL...');
  
  const client = await pool.connect();
  
  try {
    console.log('✅ Connessione stabilita!');
    
    // === 1. Crea tabella task_collaborators ===
    const checkTable = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'task_collaborators'
      );
    `);
    
    if (checkTable.rows[0].exists) {
      console.log('⚠️ La tabella task_collaborators esiste già');
    } else {
      console.log('📝 Creazione tabella task_collaborators...');
      
      await client.query(`
        CREATE TABLE task_collaborators (
          work_date      DATE        NOT NULL,
          task_id        INTEGER     NOT NULL,
          cleaner_id     INTEGER     NOT NULL,
          is_primary     BOOLEAN     NOT NULL DEFAULT false,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          
          PRIMARY KEY (work_date, task_id, cleaner_id)
        );
      `);
      
      console.log('✅ Tabella task_collaborators creata!');
      
      // Indici per query frequenti
      await client.query(`
        CREATE INDEX idx_task_collaborators_task 
        ON task_collaborators (work_date, task_id);
      `);
      
      await client.query(`
        CREATE INDEX idx_task_collaborators_cleaner 
        ON task_collaborators (work_date, cleaner_id);
      `);
      
      // Indice parziale per garantire un solo primary per task/data
      await client.query(`
        CREATE UNIQUE INDEX idx_task_collaborators_single_primary 
        ON task_collaborators (work_date, task_id) 
        WHERE is_primary = true;
      `);
      
      console.log('✅ Indici creati!');
    }
    
    // === 2. Aggiungi colonna base_cleaning_time a daily_assignments_current ===
    const checkColumn = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns 
        WHERE table_name = 'daily_assignments_current' 
        AND column_name = 'base_cleaning_time'
      );
    `);
    
    if (checkColumn.rows[0].exists) {
      console.log('⚠️ La colonna base_cleaning_time esiste già');
    } else {
      console.log('📝 Aggiunta colonna base_cleaning_time a daily_assignments_current...');
      
      await client.query(`
        ALTER TABLE daily_assignments_current 
        ADD COLUMN base_cleaning_time INTEGER;
      `);
      
      // Popola base_cleaning_time con il valore attuale di cleaning_time per i record esistenti
      await client.query(`
        UPDATE daily_assignments_current 
        SET base_cleaning_time = cleaning_time 
        WHERE base_cleaning_time IS NULL;
      `);
      
      console.log('✅ Colonna base_cleaning_time aggiunta e popolata!');
    }
    
    // Mostra struttura finale
    console.log('\n📋 Struttura tabella task_collaborators:');
    const cols = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'task_collaborators'
      ORDER BY ordinal_position;
    `);
    cols.rows.forEach((col: any) => {
      console.log(`   - ${col.column_name}: ${col.data_type} (${col.is_nullable === 'YES' ? 'nullable' : 'not null'})`);
    });
    
  } finally {
    client.release();
    await pool.end();
  }
}

addTaskCollaborators()
  .then(() => console.log('\n✨ Migrazione completata!'))
  .catch(err => {
    console.error('❌ Errore:', err);
    process.exit(1);
  });
