import { validateEnvironment } from '../../src/config/configuration';

describe('Environment validation', () => {
  const env = {
    DATABASE_URL: 'postgresql://a:b@localhost/chat',
    REDIS_URL: 'redis://:p@localhost:6379',
    FIREBASE_PROJECT_ID: 'demo-chat',
    CORS_ORIGINS: 'http://localhost:5173',
  };
  it('validates development settings and limits', () => {
    expect(validateEnvironment(env).port).toBe(3000);
    expect(() => validateEnvironment({ ...env, PORT: 'NaN' })).toThrow();
    expect(() =>
      validateEnvironment({ ...env, HTTP_RATE_LIMIT: '-1' }),
    ).toThrow();
  });
  it('rejects missing secrets, wildcard origins and emulator production use', () => {
    expect(() => validateEnvironment({})).toThrow('Missing');
    expect(() => validateEnvironment({ ...env, CORS_ORIGINS: '*' })).toThrow();
    expect(() =>
      validateEnvironment({
        ...env,
        NODE_ENV: 'production',
        FIRESTORE_EMULATOR_HOST: 'localhost:8080',
      }),
    ).toThrow('Emulators');
    expect(() =>
      validateEnvironment({ ...env, NODE_ENV: 'production' }),
    ).toThrow('Unsafe');
  });
});
