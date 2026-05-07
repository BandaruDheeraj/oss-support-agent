import type { Config } from '@jest/types';

const config: Config.InitialOptions = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/core', '<rootDir>/src', '<rootDir>/configs'],
  testMatch: ['**/*.test.ts'],
};

export default config;
