// Flat ESLint configuration for the JAYA toolchain substrate (FND-001a).

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      // Deliberately non-conforming source. Linting it would report the very problems the
      // enforcement tests exist to assert.
      'tests/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // node:test registers each case with the runner; the returned promise is the runner's to
    // await, not ours. Requiring `void test(...)` on every case would add noise, not safety.
    files: ['tests/**/*.test.ts', 'tests/**/*.integration.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },
  {
    // Kernel modules keep their internal unit tests beside the source so the tests can reach
    // package-private exports. They are not in the tsconfig project, so type-checked linting is
    // disabled for them; ordinary syntax and recommended rules still apply.
    files: ['kernel/**/*.test.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },
  {
    // Documentation tooling: plain ESM JavaScript, no type information available.
    files: ['**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
  },
);
