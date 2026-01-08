/**
 * Configuration Module
 * 
 * Centralizes all environment-specific configuration.
 * Uses NODE_ENV to determine which environment settings to use.
 * 
 * Usage:
 *   import { config } from '../config';
 *   console.log(config.database.postgres.host);
 */

import { databaseConfig } from './database';
import { appConfig } from './app';

export const config = {
  env: process.env.NODE_ENV || 'development',
  isDevelopment: (process.env.NODE_ENV || 'development') === 'development',
  isProduction: process.env.NODE_ENV === 'production',
  
  database: databaseConfig,
  app: appConfig,
};

export { databaseConfig } from './database';
export { appConfig } from './app';
