import js from '@eslint/js';
import {defineConfig} from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default defineConfig(
  {ignores: ['dist*/**', 'node_modules/**']},
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: {globals: globals.node},
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.host.json', './tsconfig.webview.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/array-type': ['error', {default: 'array-simple'}],
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        {considerDefaultExhaustiveForUnions: true},
      ],
      'default-case': 'error',
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/no-floating-promises': [
        'error',
        {checkThenables: true},
      ],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {argsIgnorePattern: '^_', ignoreRestSiblings: true},
      ],
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      'prefer-arrow-callback': 'error',
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      // Node's runner owns top-level test registrations and reports their failures.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          checkThenables: true,
          allowForKnownSafeCalls: [
            {from: 'package', package: 'node:test', name: 'test'},
          ],
        },
      ],
    },
  },
  prettier,
  {rules: {curly: ['error', 'all']}},
);
