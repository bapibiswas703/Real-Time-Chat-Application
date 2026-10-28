module.exports = {
  ...require('./jest.config.cjs'),
  testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
  testTimeout: 45000,
  maxWorkers: 1,
};
