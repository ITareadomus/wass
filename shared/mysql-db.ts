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
    
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS daily_assignment_revisions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        work_date DATE NOT NULL,
        revision INT NOT NULL,
        selected_cleaners JSON NOT NULL,
        timeline JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_work_date (work_date),
        INDEX idx_work_date_revision (work_date, revision)
      )
    `);
    
    connection.release();
    console.log("✅ MySQL database initialized - daily_assignment_revisions table ready");
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
