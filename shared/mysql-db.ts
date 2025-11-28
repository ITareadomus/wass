import mysql from "mysql2/promise";

const pool = mysql.createPool({
  host: process.env.DB_HOST!,
  user: process.env.DB_USER!,
  password: process.env.DB_PASSWORD!,
  database: process.env.DB_NAME!,
  port: Number(process.env.DB_PORT ?? 3306),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

export const mysqlDb = pool;

/**
 * Initialize MySQL database with two-table architecture:
 * - daily_assignments_current: Current state (1 row per work_date)
 * - daily_assignments_history: All revisions for audit/rollback
 */
export async function initMySQLDatabase() {
  try {
    const connection = await pool.getConnection();
    
    // Check if tables exist
    const [currentTableRows] = await connection.execute(`
      SELECT COUNT(*) as count FROM information_schema.tables 
      WHERE table_schema = ? AND table_name = 'daily_assignments_current'
    `, [process.env.DB_NAME]);
    
    const [historyTableRows] = await connection.execute(`
      SELECT COUNT(*) as count FROM information_schema.tables 
      WHERE table_schema = ? AND table_name = 'daily_assignments_history'
    `, [process.env.DB_NAME]);
    
    const currentExists = (currentTableRows as any)[0].count > 0;
    const historyExists = (historyTableRows as any)[0].count > 0;
    
    // Create current table if not exists
    if (!currentExists) {
      await connection.execute(`
        CREATE TABLE daily_assignments_current (
          work_date DATE PRIMARY KEY,
          timeline JSON,
          selected_cleaners JSON,
          containers JSON,
          last_revision INT DEFAULT 0,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);
      console.log("✅ Created table: daily_assignments_current");
    } else {
      // Add containers column if it doesn't exist
      const [columns] = await connection.execute(`
        SELECT COLUMN_NAME FROM information_schema.columns 
        WHERE table_schema = ? AND table_name = 'daily_assignments_current' AND column_name = 'containers'
      `, [process.env.DB_NAME]);
      
      if ((columns as any[]).length === 0) {
        await connection.execute(`ALTER TABLE daily_assignments_current ADD COLUMN containers JSON`);
        console.log("✅ Added containers column to daily_assignments_current");
      }
    }
    
    // Create history table if not exists
    if (!historyExists) {
      await connection.execute(`
        CREATE TABLE daily_assignments_history (
          id INT AUTO_INCREMENT PRIMARY KEY,
          work_date DATE NOT NULL,
          revision INT NOT NULL,
          timeline JSON,
          selected_cleaners JSON,
          containers JSON,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          created_by VARCHAR(100) DEFAULT 'system',
          INDEX idx_work_date_revision (work_date, revision DESC)
        )
      `);
      console.log("✅ Created table: daily_assignments_history");
    } else {
      // Add containers column if it doesn't exist
      const [columns] = await connection.execute(`
        SELECT COLUMN_NAME FROM information_schema.columns 
        WHERE table_schema = ? AND table_name = 'daily_assignments_history' AND column_name = 'containers'
      `, [process.env.DB_NAME]);
      
      if ((columns as any[]).length === 0) {
        await connection.execute(`ALTER TABLE daily_assignments_history ADD COLUMN containers JSON`);
        console.log("✅ Added containers column to daily_assignments_history");
      }
    }
    
    // Migrate data from old table if exists
    const [oldTableRows] = await connection.execute(`
      SELECT COUNT(*) as count FROM information_schema.tables 
      WHERE table_schema = ? AND table_name = 'daily_assignment_revisions'
    `, [process.env.DB_NAME]);
    
    const oldTableExists = (oldTableRows as any)[0].count > 0;
    
    if (oldTableExists) {
      // Migrate old revisions to history table
      const [existingHistory] = await connection.execute(`
        SELECT COUNT(*) as count FROM daily_assignments_history
      `);
      
      if ((existingHistory as any)[0].count === 0) {
        console.log("🔄 Migrating data from daily_assignment_revisions to new tables...");
        
        // Copy all revisions to history
        await connection.execute(`
          INSERT INTO daily_assignments_history (work_date, revision, timeline, selected_cleaners, created_at)
          SELECT work_date, revision, timeline, selected_cleaners, created_at
          FROM daily_assignment_revisions
          ORDER BY work_date, revision
        `);
        
        // Populate current table with latest revision for each date
        await connection.execute(`
          INSERT INTO daily_assignments_current (work_date, timeline, selected_cleaners, last_revision, updated_at)
          SELECT r.work_date, r.timeline, r.selected_cleaners, r.revision, r.created_at
          FROM daily_assignment_revisions r
          INNER JOIN (
            SELECT work_date, MAX(revision) as max_revision
            FROM daily_assignment_revisions
            GROUP BY work_date
          ) latest ON r.work_date = latest.work_date AND r.revision = latest.max_revision
          ON DUPLICATE KEY UPDATE 
            timeline = VALUES(timeline),
            selected_cleaners = VALUES(selected_cleaners),
            last_revision = VALUES(last_revision),
            updated_at = VALUES(updated_at)
        `);
        
        console.log("✅ Migration completed - old data moved to new tables");
      }
    }
    
    connection.release();
    
    console.log("✅ MySQL connected - two-table architecture ready");
    console.log("   📋 daily_assignments_current: Current state per work_date");
    console.log("   📜 daily_assignments_history: All revisions for audit");
    return true;
  } catch (error) {
    console.error("❌ MySQL initialization error:", error);
    return false;
  }
}

export async function testMySQLConnection(): Promise<boolean> {
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    console.log("✅ MySQL connection successful");
    return true;
  } catch (error) {
    console.error("❌ MySQL connection failed:", error);
    return false;
  }
}
