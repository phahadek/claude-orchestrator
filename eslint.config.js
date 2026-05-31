const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const reactHooks = require('eslint-plugin-react-hooks');
const reactRefresh = require('eslint-plugin-react-refresh').default;
const globals = require('globals');

// Inline rule: reject relative imports ending in .js in backend runtime files.
// The backend runs under ts-node + CommonJS which resolves './foo.ts' but crashes on './foo.js'.
const noJsExtensionImports = {
  meta: {
    type: 'problem',
    messages: {
      noJsExt:
        "Use extension-less imports (e.g. from './foo' not './foo.js'). " +
        'The backend runs under ts-node + CommonJS which cannot resolve .js-extension imports to their .ts source files.',
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (/^\.{1,2}\/.*\.js$/.test(node.source.value)) {
          context.report({ node: node.source, messageId: 'noJsExt' });
        }
      },
    };
  },
};

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

  // Backend runtime: no .js-extension relative imports (ts-node + CommonJS cannot resolve them)
  {
    files: ['packages/backend/src/**/*.ts'],
    ignores: ['packages/backend/src/**/__tests__/**'],
    plugins: {
      local: { rules: { 'no-js-extension-imports': noJsExtensionImports } },
    },
    rules: {
      'local/no-js-extension-imports': 'error',
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
