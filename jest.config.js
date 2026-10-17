module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
    '^.+\\.mjs$': '<rootDir>/test/support/mjs-transformer.cjs',
  },
  transformIgnorePatterns: ['/node_modules/(?!.*stage-contracts)'],
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
};
