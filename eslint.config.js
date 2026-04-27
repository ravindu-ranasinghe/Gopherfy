const js = require('@eslint/js');
const security = require('eslint-plugin-security');
const n = require('eslint-plugin-n');
const prettier = require('eslint-config-prettier');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/', 'coverage/', '*.db', '*.db-wal', '*.db-shm'],
  },
  js.configs.recommended,
  security.configs.recommended,
  n.configs['flat/recommended'],
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      'no-console': 'error',
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'n/no-missing-require': 'off',
      'n/no-unpublished-require': 'off',
      'n/no-extraneous-require': 'off',
      'n/no-process-exit': 'off',
      'n/no-unsupported-features/node-builtins': ['error', { ignores: ['fetch'] }],
      'security/detect-object-injection': 'off',
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
  {
    files: ['**/__tests__/**/*.js', '**/*.test.js'],
    rules: {
      'security/detect-non-literal-regexp': 'off',
      'security/detect-non-literal-require': 'off',
    },
  },
];
