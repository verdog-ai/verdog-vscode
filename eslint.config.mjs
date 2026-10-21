// Written by `plumbcheck sync` from verdog-ai/standards; edit it there.
// Only settings that differ from ESLint's defaults, each with its reason.
import js from '@eslint/js';
import {defineConfig} from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default defineConfig(
  // Bundles and CMake output are generated (node_modules is ignored by default).
  {ignores: ['dist*/**', 'build/**']},
  // ESLint's recommended rules (default: none).
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    // Build scripts run in Node.
    languageOptions: {globals: globals.node},
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    // typescript-eslint's recommended rules, which also enable no-var and
    // prefer-const.
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        // Every tsconfig of the package; the first that includes a file wins.
        project: ['./tsconfig*.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    // Type-aware and stricter rules the recommended set leaves out.
    rules: {
      // `T[]` for simple types, `Array<T>` otherwise.
      '@typescript-eslint/array-type': ['error', {default: 'array-simple'}],
      // Every member of a union is handled, or a default is.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        {considerDefaultExhaustiveForUnions: true},
      ],
      // Every switch decides what happens to the other values.
      'default-case': 'error',
      // Object types are interfaces, which extend and merge.
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      // Every promise is awaited or handled, thenables too.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {checkThenables: true},
      ],
      // No promise where a plain value or void callback is expected.
      '@typescript-eslint/no-misused-promises': 'error',
      // No assertion the type checker already guarantees.
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      // `_`-prefixed arguments and rest siblings may stay unused.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {argsIgnorePattern: '^_', ignoreRestSiblings: true},
      ],
      // `===` and `!==` only.
      eqeqeq: ['error', 'always'],
      // Arrow functions as callbacks.
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
  // Prettier owns the layout: its config turns the formatting rules off.
  prettier,
  // Braces around every block, which Prettier's config turns off.
  {rules: {curly: ['error', 'all']}},
);
