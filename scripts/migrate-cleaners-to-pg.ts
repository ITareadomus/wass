import * as fs from 'fs/promises';
import path from 'path';
import pool, { query } from '../shared/pg-db';

async function migrateCleanersToPg() {
  console.log('🔄 Migrating cleaners from JSON to PostgreSQL...');
  
  const cleanersPath = path.join(process.cwd(), 'client/public/data/cleaners/cleaners.json');
  
  try {
    const cleanersData = JSON.parse(await fs.readFile(cleanersPath, 'utf-8'));
    
    if (!cleanersData.dates) {
      console.log('⚠️ No dates found in cleaners.json');
      return;
    }

    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      let totalMigrated = 0;
      
      for (const [workDate, dateData] of Object.entries(cleanersData.dates)) {
        const data = dateData as any;
        const cleaners = data.cleaners || [];
        
        if (cleaners.length === 0) continue;
        
        console.log(`📅 Processing ${workDate}: ${cleaners.length} cleaners`);
        
        for (const cleaner of cleaners) {
          await client.query(`
            INSERT INTO cleaners 
            (cleaner_id, work_date, name, lastname, role, active, ranking,
             counter_hours, counter_days, available, contract_type,
             preferred_customers, telegram_id, start_time, can_do_straordinaria,
             created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
            ON CONFLICT (cleaner_id, work_date) DO UPDATE SET
              name = EXCLUDED.name,
              lastname = EXCLUDED.lastname,
              role = EXCLUDED.role,
              active = EXCLUDED.active,
              ranking = EXCLUDED.ranking,
              counter_hours = EXCLUDED.counter_hours,
              counter_days = EXCLUDED.counter_days,
              available = EXCLUDED.available,
              contract_type = EXCLUDED.contract_type,
              preferred_customers = EXCLUDED.preferred_customers,
              telegram_id = EXCLUDED.telegram_id,
              start_time = EXCLUDED.start_time,
              can_do_straordinaria = EXCLUDED.can_do_straordinaria,
              updated_at = NOW()
          `, [
            cleaner.id,
            workDate,
            cleaner.name || '',
            cleaner.lastname || '',
            cleaner.role || 'Standard',
            cleaner.active !== false,
            cleaner.ranking || 0,
            cleaner.counter_hours || 0,
            cleaner.counter_days || 0,
            cleaner.available !== false,
            cleaner.contract_type || null,
            cleaner.preferred_customers || [],
            cleaner.telegram_id || null,
            cleaner.start_time || '09:00',
            cleaner.can_do_straordinaria || false
          ]);
          totalMigrated++;
        }
      }

      await client.query('COMMIT');
      console.log(`✅ Migration complete: ${totalMigrated} cleaner records migrated`);
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
  } finally {
    await pool.end();
  }
}

migrateCleanersToPg();
