const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const reactHooks = require('eslint-plugin-react-hooks');
const reactRefresh = require('eslint-plugin-react-refresh').default;
const globals = require('globals');
const security = require('eslint-plugin-security');

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

  // Backend + frontend SAST: eslint-plugin-security recommended rules.
  // Two globally noisy rules are disabled here because they flag every bracket-access and fs
  // call regardless of whether user input is actually involved — ~100% false-positive rate in
  // this codebase. Real path-traversal and injection protections live at input boundaries.
  //   detect-non-literal-fs-filename: every fs call with a variable path triggers it; our fs
  //     paths are constructed from config/constants, not raw user input.
  //   detect-object-injection: every obj[key] access triggers it; bracket access is idiomatic
  //     TypeScript and the keys here come from typed enums/constants, not user-controlled input.
  {
    files: [
      'packages/backend/src/**/*.{ts,tsx}',
      'packages/frontend/src/**/*.{ts,tsx}',
    ],
    plugins: { security },
    rules: {
      ...security.configs.recommended.rules,
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-object-injection': 'off',
    },
  },

  // Test files: security rules disabled — tests legitimately exercise edge-case patterns
  // (fs paths, child_process, regex shapes, eval-like constructs) to verify guard code works.
  {
    files: [
      '**/__tests__/**/*.{ts,tsx}',
      '**/*.test.{ts,tsx}',
      '**/test/**/*.{ts,tsx}',
    ],
    rules: Object.fromEntries(
      Object.keys(security.configs.recommended.rules || {}).map((r) => [
        r,
        'off',
      ]),
    ),
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
