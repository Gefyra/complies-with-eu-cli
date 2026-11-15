import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      '.tools/**',
      'workdir/**',
      'coverage/**',
      'pk_*/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        // nodeBuiltin, not node: flags CommonJS leftovers (require, module, __dirname) in ESM files.
        ...globals.nodeBuiltin,
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
];
