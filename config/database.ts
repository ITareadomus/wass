/**
 * Database Configuration
 * 
 * Configurazione centralizzata per PostgreSQL e MySQL.
 * Usa NODE_ENV per selezionare l'ambiente corretto.
 * Le credenziali sono lette da variabili d'ambiente (.env.local)
 * 
 * DEVELOPMENT (Replit): NODE_ENV=development o non impostato
 * PRODUCTION (GitHub): NODE_ENV=production
 */

const env = process.env.NODE_ENV || 'development';

// ============================================================================
// POSTGRESQL CONFIGURATION
// ============================================================================

const postgresConfig = {
  development: {
    username: process.env.PG_USERNAME_DEV || '',
    password: process.env.PG_PASSWORD_DEV || '',
    host: process.env.PG_HOST_DEV || '',
    port: parseInt(process.env.PG_PORT_DEV || '25060', 10),
    database: process.env.PG_DATABASE_DEV || '',
    sslmode: process.env.PG_SSLMODE_DEV || 'require',
    get connectionString() {
      return `postgresql://${this.username}:${this.password}@${this.host}:${this.port}/${this.database}?sslmode=${this.sslmode}`;
    },
  },
  production: {
    username: process.env.PG_USERNAME_PROD || '',
    password: process.env.PG_PASSWORD_PROD || '',
    host: process.env.PG_HOST_PROD || '',
    port: parseInt(process.env.PG_PORT_PROD || '25060', 10),
    database: process.env.PG_DATABASE_PROD || '',
    sslmode: process.env.PG_SSLMODE_PROD || 'require',
    get connectionString() {
      return `postgresql://${this.username}:${this.password}@${this.host}:${this.port}/${this.database}?sslmode=${this.sslmode}`;
    },
  },
};

// ============================================================================
// MYSQL CONFIGURATION (ADAM)
// ============================================================================

const mysqlConfig = {
  development: {
    host: process.env.MYSQL_HOST_DEV || '',
    port: parseInt(process.env.MYSQL_PORT_DEV || '3306', 10),
    user: process.env.MYSQL_USER_DEV || '',
    password: process.env.MYSQL_PASSWORD_DEV || '',
    database: process.env.MYSQL_DATABASE_DEV || '',
  },
  production: {
    host: process.env.MYSQL_HOST_PROD || '',
    port: parseInt(process.env.MYSQL_PORT_PROD || '3306', 10),
    user: process.env.MYSQL_USER_PROD || '',
    password: process.env.MYSQL_PASSWORD_PROD || '',
    database: process.env.MYSQL_DATABASE_PROD || '',
  },
};

// ============================================================================
// EXPORT CONFIGURATION
// ============================================================================

export const databaseConfig = {
  env,
  postgres: postgresConfig[env as keyof typeof postgresConfig] || postgresConfig.development,
  mysql: mysqlConfig[env as keyof typeof mysqlConfig] || mysqlConfig.development,
  
  // Helper per verificare se MySQL è configurato correttamente
  isMysqlConfigured(): boolean {
    const mysql = this.mysql;
    return !!(mysql.host && mysql.database && mysql.user && mysql.password);
  },
  
  // Helper per verificare se PostgreSQL è configurato correttamente  
  isPostgresConfigured(): boolean {
    const pg = this.postgres;
    return !!(pg.host && pg.username && pg.password && pg.database);
  },
};

// Log ambiente corrente all'avvio
console.log(`📊 Database config loaded for environment: ${env}`);
console.log(`   PostgreSQL: ${databaseConfig.postgres.host}:${databaseConfig.postgres.port}/${databaseConfig.postgres.database}`);
console.log(`   MySQL: ${databaseConfig.mysql.host}:${databaseConfig.mysql.port}/${databaseConfig.mysql.database}`);
