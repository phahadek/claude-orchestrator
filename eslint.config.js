const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const reactHooks = require('eslint-plugin-react-hooks');
const reactRefresh = require('eslint-plugin-react-refresh').default;
const globals = require('globals');

module.exports = tseslint.config(
  { ignores: ['packages/backend/dist/**', 'packages/frontend/dist/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Backend: CommonJS module system — require() is idiomatic
  {
    files: ['packages/backend/**/*.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  {
    files: ['packages/frontend/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // useEffect+fetch is the standard data-loading pattern; Suspense migration is out of scope
      'react-hooks/set-state-in-effect': 'off',
    },
  },

  // Test files: mocks legitimately use `any` casts
  {
    files: [
      '**/__tests__/**/*.{ts,tsx}',
      '**/*.test.{ts,tsx}',
      '**/test/**/*.{ts,tsx}',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
