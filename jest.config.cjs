module.exports = {
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/common/(.*)$': '<rootDir>/src/common/$1',
    '^@/config/(.*)$': '<rootDir>/src/config/$1',
    '^@/shared/(.*)$': '<rootDir>/src/shared/$1',
  },
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      { tsconfig: 'tsconfig.jest.json', useESM: true },
    ],
    '^.+\\.js$': [
      'babel-jest',
      {
        babelrc: false,
        configFile: false,
        plugins: ['@babel/plugin-transform-modules-commonjs'],
      },
    ],
  },
  // Firebase Admin's CommonJS dependency loads jose's ESM entry. Transform only
  // that package for Node 22's Jest loader; application dependencies are intact.
  transformIgnorePatterns: ['[/\\\\]node_modules[/\\\\](?!jose[/\\\\])'],
  setupFilesAfterEnv: ['<rootDir>/test/jest.setup.cjs'],
  testMatch: [
    '<rootDir>/test/unit/**/*.spec.ts',
    '<rootDir>/test/e2e/**/*.spec.ts',
  ],
  clearMocks: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts'],
};
