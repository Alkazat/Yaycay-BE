import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'packages/*/dist/**',
      'supabase/functions/**', // Deno runtime; linted separately by deno lint
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Node-side build/validation scripts.
    files: ['**/*.mjs', '**/scripts/**'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
);
