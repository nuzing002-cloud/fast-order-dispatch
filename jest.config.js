module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': '<rootDir>/jest.transformer.js'
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/types/**',
    '!src/openapi.ts'
  ],
  coverageThreshold: {
    global: {
      statements: 80,
      branches: 65,
      functions: 80,
      lines: 80
    }
  }
};
