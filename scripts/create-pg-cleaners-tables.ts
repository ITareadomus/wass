/**
 * Script per creare le tabelle cleaners e cleaners_history su PostgreSQL (DigitalOcean)
 * 
 * Struttura:
 * - cleaners: Tabella corrente con i dati dei cleaners per data
 * - cleaners_history: Storico per audit/rollback
 * 
 * Eseguire con: npx tsx scripts/create-pg-cleaners-tables.ts
 */

import { query, pool } from '../shared/pg-db';

async function createCleanersTables() {
  console.log('🔧 Creazione tabelle cleaners su PostgreSQL...\n');

  try {
    // ==================== CLEANERS (CORRENTE) ====================
    console.log('📋 Creazione tabella cleaners...');
    
    await query(`
      CREATE TABLE IF NOT EXISTS cleaners (
        id SERIAL PRIMARY KEY,
        cleaner_id INTEGER NOT NULL,
        work_date DATE NOT NULL,
        name VARCHAR(255) NOT NULL,
        lastname VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'Standard',
        active BOOLEAN DEFAULT true,
        ranking INTEGER DEFAULT 0,
        counter_hours DECIMAL(6,2) DEFAULT 0,
        counter_days INTEGER DEFAULT 0,
        available BOOLEAN DEFAULT true,
        contract_type VARCHAR(50),
        preferred_customers INTEGER[] DEFAULT '{}',
        telegram_id BIGINT,
        start_time VARCHAR(10) DEFAULT '09:00',
        can_do_straordinaria BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(cleaner_id, work_date)
      )
    `);
    console.log('✅ Tabella cleaners creata');

    // Indici per performance
    await query(`CREATE INDEX IF NOT EXISTS idx_cleaners_work_date ON cleaners(work_date)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_cleaners_cleaner_id ON cleaners(cleaner_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_cleaners_active ON cleaners(active)`);
    console.log('✅ Indici cleaners creati');

    // ==================== CLEANERS_HISTORY ====================
    console.log('\n📜 Creazione tabella cleaners_history...');
    
    await query(`
      CREATE TABLE IF NOT EXISTS cleaners_history (
        id SERIAL PRIMARY KEY,
        cleaner_id INTEGER NOT NULL,
        work_date DATE NOT NULL,
        name VARCHAR(255) NOT NULL,
        lastname VARCHAR(255) NOT NULL,
        role VARCHAR(50),
        active BOOLEAN,
        ranking INTEGER,
        counter_hours DECIMAL(6,2),
        counter_days INTEGER,
        available BOOLEAN,
        contract_type VARCHAR(50),
        preferred_customers INTEGER[],
        telegram_id BIGINT,
        start_time VARCHAR(10),
        can_do_straordinaria BOOLEAN,
        snapshot_at TIMESTAMP DEFAULT NOW(),
        snapshot_reason VARCHAR(100)
      )
    `);
    console.log('✅ Tabella cleaners_history creata');

    // Indici per history
    await query(`CREATE INDEX IF NOT EXISTS idx_cleaners_history_work_date ON cleaners_history(work_date)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_cleaners_history_cleaner_id ON cleaners_history(cleaner_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_cleaners_history_snapshot_at ON cleaners_history(snapshot_at)`);
    console.log('✅ Indici cleaners_history creati');

    // ==================== DAILY_SELECTED_CLEANERS (AGGIORNA STRUTTURA) ====================
    console.log('\n📋 Aggiornamento tabella daily_selected_cleaners...');
    
    // Verifica se la tabella esiste
    const tableCheck = await query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'daily_selected_cleaners'
      )
    `);
    
    if (!tableCheck.rows[0].exists) {
      // Crea la tabella con cleaners come INTEGER[]
      await query(`
        CREATE TABLE daily_selected_cleaners (
          id SERIAL PRIMARY KEY,
          work_date DATE NOT NULL UNIQUE,
          cleaners INTEGER[] DEFAULT '{}',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
      console.log('✅ Tabella daily_selected_cleaners creata con cleaners INTEGER[]');
    } else {
      // Verifica il tipo della colonna cleaners
      const columnCheck = await query(`
        SELECT data_type, udt_name 
        FROM information_schema.columns 
        WHERE table_name = 'daily_selected_cleaners' AND column_name = 'cleaners'
      `);
      
      if (columnCheck.rows.length > 0) {
        const dataType = columnCheck.rows[0].udt_name;
        if (dataType === 'jsonb' || dataType === 'json') {
          console.log(`⚠️ Colonna cleaners è ${dataType}, migrazione a INTEGER[]...`);
          
          // Backup dei dati esistenti
          await query(`ALTER TABLE daily_selected_cleaners RENAME COLUMN cleaners TO cleaners_old`);
          await query(`ALTER TABLE daily_selected_cleaners ADD COLUMN cleaners INTEGER[] DEFAULT '{}'`);
          
          // Migra i dati (estrae gli ID dal JSON)
          await query(`
            UPDATE daily_selected_cleaners 
            SET cleaners = (
              SELECT ARRAY_AGG((elem->>'id')::integer)
              FROM jsonb_array_elements(cleaners_old::jsonb) AS elem
            )
            WHERE cleaners_old IS NOT NULL AND cleaners_old::text != '[]'
          `);
          
          await query(`ALTER TABLE daily_selected_cleaners DROP COLUMN cleaners_old`);
          console.log('✅ Migrazione cleaners da JSON a INTEGER[] completata');
        } else if (dataType === '_int4') {
          console.log('✅ Colonna cleaners è già INTEGER[]');
        } else {
          console.log(`ℹ️ Colonna cleaners ha tipo: ${dataType}`);
        }
      }
    }

    await query(`CREATE INDEX IF NOT EXISTS idx_daily_selected_cleaners_work_date ON daily_selected_cleaners(work_date)`);
    console.log('✅ Indice daily_selected_cleaners creato');

    // ==================== VERIFICA FINALE ====================
    console.log('\n📊 Verifica struttura tabelle...');
    
    const tables = ['cleaners', 'cleaners_history', 'daily_selected_cleaners'];
    for (const table of tables) {
      const result = await query(`
        SELECT column_name, data_type, udt_name
        FROM information_schema.columns 
        WHERE table_name = $1
        ORDER BY ordinal_position
      `, [table]);
      
      console.log(`\n📋 ${table}:`);
      result.rows.forEach((row: any) => {
        console.log(`   - ${row.column_name}: ${row.data_type} (${row.udt_name})`);
      });
    }

    console.log('\n✅ Tutte le tabelle cleaners create con successo!');

  } catch (error) {
    console.error('❌ Errore nella creazione delle tabelle:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

createCleanersTables();
