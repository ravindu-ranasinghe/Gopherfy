/**
 * Jest configuration for Gopherfy.
 *
 * CommonJS, Node test environment. Tests live in __tests__ folders next to
 * the source they cover; coverage is collected from src/ excluding tests.
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  collectCoverageFrom: ['src/**/*.js', '!src/**/__tests__/**'],
  coverageDirectory: 'coverage',
  clearMocks: true,
  restoreMocks: true,
  watchman: false,
};
