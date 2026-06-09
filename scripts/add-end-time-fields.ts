import pool from "../shared/pg-db";

const DEFAULT_END_TIME = "20:00";

async function tableExists(client: Awaited<ReturnType<typeof pool.connect>>, tableName: string): Promise<boolean> {
  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
      LIMIT 1
    `,
    [tableName]
  );
  return (result.rows?.length ?? 0) > 0;
}

async function addColumnIfTableExists(
  client: Awaited<ReturnType<typeof pool.connect>>,
  tableName: string,
  alterSql: string
): Promise<boolean> {
  if (!(await tableExists(client, tableName))) {
    console.log(`⏭️  Skip ${tableName}: tabella non presente nel DB`);
    return false;
  }
  await client.query(alterSql);
  console.log(`✅ ${tableName}: colonna end_time applicata`);
  return true;
}

async function backfillIfTableExists(
  client: Awaited<ReturnType<typeof pool.connect>>,
  tableName: string,
  columnName: string
): Promise<void> {
  if (!(await tableExists(client, tableName))) return;
  await client.query(
    `UPDATE ${tableName} SET ${columnName} = $1 WHERE ${columnName} IS NULL`,
    [DEFAULT_END_TIME]
  );
}

async function addEndTimeFields() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Roster fields (cleaners_history non esiste nel DB attuale: vedi db.sql / ensureCleanerAliasesAndRevisionsTables)
    await addColumnIfTableExists(
      client,
      "cleaners",
      `ALTER TABLE cleaners ADD COLUMN IF NOT EXISTS end_time VARCHAR(10) NOT NULL DEFAULT '20:00'`
    );
    await addColumnIfTableExists(
      client,
      "cleaners_history",
      `ALTER TABLE cleaners_history ADD COLUMN IF NOT EXISTS end_time VARCHAR(10)`
    );
    await addColumnIfTableExists(
      client,
      "lg_drivers",
      `ALTER TABLE lg_drivers ADD COLUMN IF NOT EXISTS end_time VARCHAR(10) NOT NULL DEFAULT '20:00'`
    );

    // Denormalized timeline fields
    await addColumnIfTableExists(
      client,
      "daily_assignments_current",
      `ALTER TABLE daily_assignments_current ADD COLUMN IF NOT EXISTS cleaner_end_time VARCHAR(10) DEFAULT '20:00'`
    );
    await addColumnIfTableExists(
      client,
      "daily_assignments_history",
      `ALTER TABLE daily_assignments_history ADD COLUMN IF NOT EXISTS cleaner_end_time VARCHAR(10) DEFAULT '20:00'`
    );
    await addColumnIfTableExists(
      client,
      "lg_timeline",
      `ALTER TABLE lg_timeline ADD COLUMN IF NOT EXISTS driver_end_time VARCHAR(10) DEFAULT '20:00'`
    );
    await addColumnIfTableExists(
      client,
      "lg_timeline_history",
      `ALTER TABLE lg_timeline_history ADD COLUMN IF NOT EXISTS driver_end_time VARCHAR(10) DEFAULT '20:00'`
    );

    // Backfill NULL values only on tables that exist
    await backfillIfTableExists(client, "cleaners", "end_time");
    await backfillIfTableExists(client, "lg_drivers", "end_time");
    await backfillIfTableExists(client, "daily_assignments_current", "cleaner_end_time");
    await backfillIfTableExists(client, "daily_assignments_history", "cleaner_end_time");
    await backfillIfTableExists(client, "lg_timeline", "driver_end_time");
    await backfillIfTableExists(client, "lg_timeline_history", "driver_end_time");

    await client.query("COMMIT");
    console.log("✅ End-time fields migration completed");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ End-time migration failed:", error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

addEndTimeFields();
