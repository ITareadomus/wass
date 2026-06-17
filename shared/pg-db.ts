import { Pool } from 'pg';
import { databaseConfig } from '../config/database';

const env = process.env.NODE_ENV || 'development';
const pgConfig = databaseConfig.postgres;
const missingPgKeys = databaseConfig.getPostgresMissingKeys();

if (missingPgKeys.length > 0) {
  throw new Error(
    `❌ PostgreSQL config missing: ${missingPgKeys.join(", ")}. ` +
    `Resolved host=${pgConfig.host || "<empty>"} port=${pgConfig.port} database=${pgConfig.database || "<empty>"}`
  );
}

if (env !== 'production' && pgConfig.database === 'defaultdb') {
  throw new Error(
    '❌ Refusing to connect to PostgreSQL production database (defaultdb) in non-production environment. ' +
    `Current NODE_ENV: "${env}". Check config/database.ts development.database.`
  );
}

console.log(`🔒 PostgreSQL database: ${pgConfig.database} (from config/database.ts, NODE_ENV=${env})`);

const pool = new Pool({
  host: pgConfig.host,
  user: pgConfig.username,
  password: pgConfig.password,
  database: pgConfig.database,
  port: pgConfig.port,
  ssl: {
    rejectUnauthorized: false
  }
});

console.log(`🐘 PostgreSQL pool initialized: ${pgConfig.database} @ ${pgConfig.host}:${pgConfig.port}`);

pool.on('error', (err) => {
  console.error('Unexpected error on PostgreSQL pool', err);
});

export async function query(text: string, params?: any[]) {
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

export async function getClient() {
  return await pool.connect();
}

export { pool };

export default pool;
