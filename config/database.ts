/**
 * Database Configuration
 * 
 * Configurazione centralizzata per PostgreSQL e MySQL.
 * Le credenziali sono lette da variabili d'ambiente.
 * 
 * In sviluppo (Replit): carica da .env.local via dotenv
 * In produzione (DO App Platform): variabili impostate nel pannello
 * 
 * Variabili PostgreSQL: PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DATABASE, PG_SSLMODE
 * Variabili MySQL: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
 */

function getEnv() {
  return process.env.NODE_ENV || 'development';
}

function getPostgresConfig() {
  return {
    username: process.env.PG_USER || '',
    password: process.env.PG_PASSWORD || '',
    host: process.env.PG_HOST || '',
    port: parseInt(process.env.PG_PORT || '25060', 10),
    database: process.env.PG_DATABASE || '',
    sslmode: process.env.PG_SSLMODE || 'require',
    get connectionString() {
      return `postgresql://${this.username}:${this.password}@${this.host}:${this.port}/${this.database}?sslmode=${this.sslmode}`;
    },
  };
}

function getMysqlConfig() {
  return {
    host: process.env.DB_HOST || '',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || '',
  };
}

export const databaseConfig = {
  get env() {
    return getEnv();
  },
  get postgres() {
    return getPostgresConfig();
  },
  get mysql() {
    return getMysqlConfig();
  },
  
  isMysqlConfigured(): boolean {
    const mysql = this.mysql;
    return !!(mysql.host && mysql.database && mysql.user && mysql.password);
  },
  
  isPostgresConfigured(): boolean {
    const pg = this.postgres;
    return !!(pg.host && pg.username && pg.password && pg.database);
  },
  
  logConfig(): void {
    console.log(`📊 Database config loaded for environment: ${this.env}`);
    console.log(`   PostgreSQL: ${this.postgres.host}:${this.postgres.port}/${this.postgres.database}`);
    console.log(`   MySQL: ${this.mysql.host}:${this.mysql.port}/${this.mysql.database}`);
  }
};
