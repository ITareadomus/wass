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
    host: 'ep-aged-cherry-a2k34qxq.eu-central-1.aws.neon.tech',
    port: 5432,
    user: 'neondb_owner',
    password: 'npg_cg9HZdDrB1lk',
    database: 'neondb',
    ssl: true,
    // Connection string alternativa (usata da alcuni driver)
    get connectionString() {
      return `postgresql://${this.user}:${this.password}@${this.host}:${this.port}/${this.database}?sslmode=require`;
    },
  },
  production: {
    // ⚠️ DA COMPLETARE: Inserire credenziali PostgreSQL di produzione
    host: 'INSERIRE_HOST_PRODUZIONE',
    port: 5432,
    user: 'INSERIRE_USER_PRODUZIONE',
    password: 'INSERIRE_PASSWORD_PRODUZIONE',
    database: 'INSERIRE_DATABASE_PRODUZIONE',
    ssl: true,
    get connectionString() {
      return `postgresql://${this.user}:${this.password}@${this.host}:${this.port}/${this.database}?sslmode=require`;
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
    return !!(mysql.host && mysql.host !== 'pippo' && mysql.database && mysql.database !== 'pippo');
  },
  
  // Helper per verificare se PostgreSQL è configurato correttamente  
  isPostgresConfigured(): boolean {
    const pg = this.postgres;
    return !!(pg.host && !pg.host.includes('INSERIRE'));
  },
};

// Log ambiente corrente all'avvio
console.log(`📊 Database config loaded for environment: ${env}`);
console.log(`   PostgreSQL: ${databaseConfig.postgres.host}:${databaseConfig.postgres.port}/${databaseConfig.postgres.database}`);
console.log(`   MySQL: ${databaseConfig.mysql.host}:${databaseConfig.mysql.port}/${databaseConfig.mysql.database}`);
