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

export async function initMySQLDatabase() {
  try {
    const connection = await pool.getConnection();
    
    // Verifica che la tabella esista (è già stata creata dall'utente)
    const [rows] = await connection.execute(`
      SELECT COUNT(*) as count FROM information_schema.tables 
      WHERE table_schema = ? AND table_name = 'daily_assignment_revisions'
    `, [process.env.DB_NAME]);
    
    connection.release();
    
    const tableExists = (rows as any)[0].count > 0;
    if (tableExists) {
      console.log("✅ MySQL connected - daily_assignment_revisions table found");
    } else {
      console.warn("⚠️ Table daily_assignment_revisions not found - please create it manually");
    }
    return tableExists;
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
