import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  {
    files: ['src/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // Express identifies an error handler by its four parameters, so `_next` must stay.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // A forgotten await silently drops an error, which matters most around Temporal and Redis calls.
      '@typescript-eslint/no-floating-promises': 'error',
      // Express 5 forwards a rejected async route handler to the error handler, so async callbacks are fine there.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }]
    }
  },
  {
    files: ['test/**/*.cjs'],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: 'commonjs', globals: globals.node }
  }
);
