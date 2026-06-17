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
import dotenv from "dotenv";
import { existsSync } from "fs";
import { resolve } from "path";

function getEnv() {
  return process.env.NODE_ENV || 'development';
}

function loadLocalEnvIfNeeded(): void {
  if (getEnv() === "production") return;
  const envPath = resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  dotenv.config({ path: envPath, override: true });
}

loadLocalEnvIfNeeded();

function firstDefined(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function getPostgresConfig() {
  const username = firstDefined(process.env.PG_USER, process.env.PGUSER, undefined) || '';
  const password = firstDefined(process.env.PG_PASSWORD, process.env.PGPASSWORD, undefined) || '';
  const host = firstDefined(process.env.PG_HOST, process.env.PGHOST, undefined) || '';
  const portRaw = firstDefined(process.env.PG_PORT, process.env.PGPORT, undefined) || '25060';
  const database = firstDefined(process.env.PG_DATABASE, process.env.PGDATABASE, undefined) || '';
  const sslmode = firstDefined(process.env.PG_SSLMODE, process.env.PGSSLMODE, undefined) || 'require';

  return {
    username,
    password,
    host,
    port: parseInt(portRaw, 10),
    database,
    sslmode,
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

  getPostgresMissingKeys(): string[] {
    const pg = this.postgres;
    const missing: string[] = [];
    if (!pg.host) missing.push("host (PG_HOST/PGHOST)");
    if (!pg.username) missing.push("username (PG_USER/PGUSER)");
    if (!pg.password) missing.push("password (PG_PASSWORD/PGPASSWORD)");
    if (!pg.database) missing.push("database (PG_DATABASE/PGDATABASE)");
    return missing;
  },
  
  logConfig(): void {
    console.log(`📊 Database config loaded for environment: ${this.env}`);
    console.log(`   PostgreSQL: ${this.postgres.host}:${this.postgres.port}/${this.postgres.database}`);
    console.log(`   MySQL: ${this.mysql.host}:${this.mysql.port}/${this.mysql.database}`);
  }
};
