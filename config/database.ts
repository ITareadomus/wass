/**
 * Database Configuration
 * 
 * PostgreSQL: Primary database (Neon)
 * MySQL: External ADAM database (read-only for sync)
 * 
 * Environment variables:
 * - DATABASE_URL: PostgreSQL connection string
 * - MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE: MySQL ADAM connection
 */

const env = process.env.NODE_ENV || 'development';

// PostgreSQL Configuration (Neon)
const postgresConfig = {
  development: {
    connectionString: process.env.DATABASE_URL || '',
    ssl: true,
  },
  production: {
    connectionString: process.env.DATABASE_URL || '',
    ssl: true,
  },
};

// MySQL Configuration (ADAM - external)
const mysqlConfig = {
  development: {
    host: process.env.MYSQL_HOST || 'pippo',
    user: process.env.MYSQL_USER || 'admin',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'pippo',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
  },
  production: {
    host: process.env.MYSQL_HOST || '',
    user: process.env.MYSQL_USER || '',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || '',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
  },
};

export const databaseConfig = {
  postgres: postgresConfig[env as keyof typeof postgresConfig] || postgresConfig.development,
  mysql: mysqlConfig[env as keyof typeof mysqlConfig] || mysqlConfig.development,
  
  // Helper to check if MySQL is configured
  isMysqlConfigured(): boolean {
    const mysql = this.mysql;
    return !!(mysql.host && mysql.host !== 'pippo' && mysql.database && mysql.database !== 'pippo');
  },
};
