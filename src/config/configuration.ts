import { Global, Module } from '@nestjs/common';

export interface AppConfig {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  projectId: string;
  corsOrigins: string[];
  httpRateLimit: number;
  socketRateLimit: number;
  typingRateLimit: number;
  swagger: boolean;
}

export function validateEnvironment(env: NodeJS.ProcessEnv): AppConfig {
  const required = (key: string): string => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Missing required configuration: ${key}`);
    return value;
  };
  const url = (value: string, key: string): URL => {
    try {
      return new URL(value);
    } catch {
      throw new Error(`Invalid configuration: ${key}`);
    }
  };
  const integer = (key: string, fallback: number, max = 100000): number => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(n) || n < 1 || n > max)
      throw new Error(`Invalid configuration: ${key}`);
    return n;
  };
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv))
    throw new Error('Invalid NODE_ENV');
  const databaseUrl = required('DATABASE_URL');
  const redisUrl = required('REDIS_URL');
  if (
    !['postgresql:', 'postgres:'].includes(
      url(databaseUrl, 'DATABASE_URL').protocol,
    )
  )
    throw new Error('Invalid DATABASE_URL protocol');
  if (!['redis:', 'rediss:'].includes(url(redisUrl, 'REDIS_URL').protocol))
    throw new Error('Invalid REDIS_URL protocol');
  const corsOrigins = required('CORS_ORIGINS')
    .split(',')
    .map((origin) => origin.trim());
  if (
    corsOrigins.some((origin) => url(origin, 'CORS_ORIGINS').origin !== origin)
  )
    throw new Error('CORS_ORIGINS must contain exact origins');
  const projectId = required('FIREBASE_PROJECT_ID');
  if (nodeEnv === 'production') {
    if (env.FIREBASE_AUTH_EMULATOR_HOST || env.FIRESTORE_EMULATOR_HOST)
      throw new Error('Emulators forbidden in production');
    if (
      projectId.startsWith('demo-') ||
      corsOrigins.some((o) => !o.startsWith('https://'))
    )
      throw new Error('Unsafe production configuration');
    if (
      !url(databaseUrl, 'DATABASE_URL').password ||
      !url(redisUrl, 'REDIS_URL').password
    )
      throw new Error('Production database and Redis credentials required');
  }
  return {
    nodeEnv,
    databaseUrl,
    redisUrl,
    projectId,
    corsOrigins,
    port: integer('PORT', 3000, 65535),
    httpRateLimit: integer('HTTP_RATE_LIMIT', 120),
    socketRateLimit: integer('SOCKET_RATE_LIMIT', 120),
    typingRateLimit: integer('TYPING_RATE_LIMIT', 10),
    swagger: env.SWAGGER_ENABLED === 'true' && nodeEnv !== 'production',
  };
}

export const CONFIG = Symbol('CONFIG');
@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: () => validateEnvironment(process.env) },
  ],
  exports: [CONFIG],
})
export class ConfigModule {}
