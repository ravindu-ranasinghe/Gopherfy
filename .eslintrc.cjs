/**
 * ESLint configuration for Gopherfy. CommonJS-flavored Node 20 + Jest.
 *
 * The no-console rule is intentionally an error: every log path goes through
 * src/lib/logger.js (Pino, with PII redaction). Direct console.* usage is a
 * regression.
 */
module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
    jest: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'script',
  },
  extends: [
    'eslint:recommended',
    'plugin:security/recommended-legacy',
    'plugin:n/recommended',
    'prettier',
  ],
  plugins: ['security', 'n'],
  rules: {
    'no-console': 'error',
    'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'n/no-missing-require': 'off',
    'n/no-unpublished-require': 'off',
    'n/no-extraneous-require': 'off',
    'n/no-process-exit': 'off',
    'n/no-unsupported-features/node-builtins': [
      'error',
      {
        ignores: ['fetch'],
      },
    ],
    'security/detect-object-injection': 'off',
    'security/detect-non-literal-fs-filename': 'off',
  },
  overrides: [
    {
      files: ['**/__tests__/**/*.js', '**/*.test.js'],
      rules: {
        'security/detect-non-literal-regexp': 'off',
        'security/detect-non-literal-require': 'off',
      },
    },
  ],
};
