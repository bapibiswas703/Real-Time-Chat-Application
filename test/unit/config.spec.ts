import { validateEnvironment } from '@/config/configuration';

describe('Environment validation', () => {
  const env = {
    DATABASE_URL: 'postgresql://a:b@localhost/chat',
    REDIS_URL: 'redis://:p@localhost:6379',
    FIREBASE_PROJECT_ID: 'demo-chat',
    CORS_ORIGINS: 'http://localhost:5173',
  };
  it('validates development settings and limits', () => {
    expect(validateEnvironment(env).port).toBe(3000);
    expect(validateEnvironment(env)).toMatchObject({
      apiPrefix: 'api',
      apiVersion: '1',
    });
    expect(() => validateEnvironment({ ...env, PORT: 'NaN' })).toThrow();
    expect(() =>
      validateEnvironment({ ...env, HTTP_RATE_LIMIT: '-1' }),
    ).toThrow();
  });
  it('validates API path segments and positive major versions', () => {
    expect(
      validateEnvironment({ ...env, API_PREFIX: 'rest', API_VERSION: '2' }),
    ).toMatchObject({ apiPrefix: 'rest', apiVersion: '2' });
    for (const prefix of ['', '/api', 'api/v1', '../api', 'API'])
      expect(() => validateEnvironment({ ...env, API_PREFIX: prefix })).toThrow(
        'API_PREFIX',
      );
    for (const version of ['0', '-1', '1.1', 'latest', '1000'])
      expect(() =>
        validateEnvironment({ ...env, API_VERSION: version }),
      ).toThrow('API_VERSION');
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
