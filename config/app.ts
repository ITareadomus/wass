/**
 * Application Configuration
 * 
 * General application settings that vary by environment.
 * 
 * Environment variables:
 * - PORT: Server port (default: 5000)
 * - SESSION_SECRET: Session encryption secret
 * - API_BASE_URL: Base URL for API calls
 */

const env = process.env.NODE_ENV || 'development';

const appSettings = {
  development: {
    port: parseInt(process.env.PORT || '5000', 10),
    sessionSecret: process.env.SESSION_SECRET || 'dev-session-secret-change-in-prod',
    apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:5000',
    logLevel: 'debug',
    enableDebugLogs: true,
  },
  production: {
    port: parseInt(process.env.PORT || '5000', 10),
    sessionSecret: process.env.SESSION_SECRET || '',
    apiBaseUrl: process.env.API_BASE_URL || '',
    logLevel: 'info',
    enableDebugLogs: false,
  },
};

export const appConfig = {
  ...appSettings[env as keyof typeof appSettings] || appSettings.development,
  
  // Timezone for date operations
  timezone: 'Europe/Rome',
  
  // Feature flags
  features: {
    adamSync: env === 'production', // Enable ADAM sync only in production
    debugMode: env === 'development',
  },
};
