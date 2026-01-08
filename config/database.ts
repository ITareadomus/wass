/**
 * Database Configuration
 * 
 * Configurazione centralizzata per PostgreSQL e MySQL.
 * Usa NODE_ENV per selezionare l'ambiente corretto.
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
    username: 'doadmin',
    password: 'REMOVED_AIVEN_PASSWORD',
    host: 'db-postgresql-fra1-32251-do-user-18568811-0.g.db.ondigitalocean.com',
    port: 25060,
    database: 'defaultdb_env',
    sslmode: 'require',
    get connectionString() {
      return `postgresql://${this.username}:${this.password}@${this.host}:${this.port}/${this.database}?sslmode=${this.sslmode}`;
    },
  },
  production: {
    username: 'doadmin',
    password: 'REMOVED_AIVEN_PASSWORD',
    host: 'db-postgresql-fra1-32251-do-user-18568811-0.g.db.ondigitalocean.com',
    port: 25060,
    database: 'defaultdb',
    sslmode: 'require',
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
    host: '139.59.132.41',
    port: 3306,
    user: 'wass_svil',
    password: 'REMOVED_PASSWORD',
    database: 'wass_sviluppo',
  },
  production: {
    host: '139.59.132.41',
    port: 3306,
    user: 'admin',
    password: 'REMOVED_MYSQL_PASSWORD',
    database: 'adamdb',
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
