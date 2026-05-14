import type { Config } from '@jest/types';

const config: Config.InitialOptions = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/core', '<rootDir>/src', '<rootDir>/configs', '<rootDir>/scripts', '<rootDir>/bin'],
  testMatch: ['**/*.test.ts'],
  // Several suites do heavy I/O (git operations, ts-jest compilation, sandbox runs).
  // Cap workers and default timeout so they don't get starved when run together.
  maxWorkers: '50%',
  testTimeout: 60_000,
};

export default config;
