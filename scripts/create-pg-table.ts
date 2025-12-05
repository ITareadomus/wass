import pool from '../shared/pg-db';

async function createTable() {
  console.log('🔄 Connessione a PostgreSQL DigitalOcean...');
  
  const client = await pool.connect();
  
  try {
    console.log('✅ Connessione stabilita!');
    
    // Verifica se la tabella esiste già
    const checkTable = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'daily_assignments_current'
      );
    `);
    
    if (checkTable.rows[0].exists) {
      console.log('⚠️ La tabella daily_assignments_current esiste già!');
      
      // Mostra la struttura attuale
      const columns = await client.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'daily_assignments_current'
        ORDER BY ordinal_position;
      `);
      
      console.log('\n📋 Struttura attuale della tabella:');
      columns.rows.forEach((col: any) => {
        console.log(`   - ${col.column_name}: ${col.data_type} (${col.is_nullable === 'YES' ? 'nullable' : 'not null'})`);
      });
      
      return;
    }
    
    console.log('📝 Creazione tabella daily_assignments_current...');
    
    // Crea la tabella
    await client.query(`
      CREATE TABLE daily_assignments_current (
          id                   BIGSERIAL PRIMARY KEY,

          -- giorno a cui si riferisce la timeline
          work_date            DATE        NOT NULL,

          -- riferimento al cleaner
          cleaner_id           INTEGER     NOT NULL,

          -- tutti i campi della TASK (copiati 1:1 dal JSON)
          task_id              BIGINT      NOT NULL,
          logistic_code        BIGINT      NOT NULL,
          client_id            BIGINT,

          premium              BOOLEAN     NOT NULL,

          address              TEXT        NOT NULL,
          lat                  NUMERIC(9,6),
          lng                  NUMERIC(9,6),

          cleaning_time        INTEGER     NOT NULL,

          checkin_date         DATE,
          checkout_date        DATE,
          checkin_time         TIME,
          checkout_time        TIME,

          pax_in               INTEGER,
          pax_out              INTEGER,

          small_equipment      BOOLEAN,
          operation_id         INTEGER,
          confirmed_operation  BOOLEAN,
          straordinaria        BOOLEAN,

          type_apt             TEXT,
          alias                TEXT,
          customer_name        TEXT,

          reasons              TEXT[]       NOT NULL DEFAULT '{}',

          priority             TEXT,

          start_time           TIME,
          end_time             TIME,
          followup             BOOLEAN,
          sequence             INTEGER      NOT NULL,
          travel_time          INTEGER      NOT NULL,

          created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
      );
    `);
    
    console.log('✅ Tabella creata!');
    
    // Crea gli indici
    console.log('📝 Creazione indici...');
    
    await client.query(`
      CREATE INDEX idx_daily_assignments_current_work_date
          ON daily_assignments_current (work_date);
    `);
    
    await client.query(`
      CREATE INDEX idx_daily_assignments_current_cleaner_date
          ON daily_assignments_current (cleaner_id, work_date);
    `);
    
    await client.query(`
      CREATE INDEX idx_daily_assignments_current_task
          ON daily_assignments_current (task_id);
    `);
    
    console.log('✅ Indici creati!');
    
    // Verifica la struttura
    const columns = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'daily_assignments_current'
      ORDER BY ordinal_position;
    `);
    
    console.log('\n📋 Struttura della tabella creata:');
    columns.rows.forEach((col: any) => {
      console.log(`   - ${col.column_name}: ${col.data_type} (${col.is_nullable === 'YES' ? 'nullable' : 'not null'})`);
    });
    
    console.log('\n🎉 Tabella daily_assignments_current creata con successo su PostgreSQL!');
    
  } catch (error) {
    console.error('❌ Errore:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

createTable();
