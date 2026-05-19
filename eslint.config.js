// Flat ESLint config covering both packages from repo root.
// See https://eslint.org/docs/latest/use/configure/configuration-files

const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const reactHooks = require("eslint-plugin-react-hooks");
const globals = require("globals");
const prettierConfig = require("eslint-config-prettier");

module.exports = tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "packages/backend/dist/**",
      "packages/frontend/dist/**",
      ".claude/**",
      "data/**",
      "*.log",
      "*.db",
      "package-lock.json",
      "packages/*/package-lock.json",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // ts-node bootstrap and a handful of utility scripts intentionally use
      // CommonJS require(); enabling this rule project-wide would force ESM
      // migration in unrelated files without benefit.
      "@typescript-eslint/no-require-imports": "off",
      // Allow `_`-prefixed parameters and locals (standard convention for
      // intentionally-unused values, e.g. interface-required callback args).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // Frontend: browser globals + React-hooks rules
    files: ["packages/frontend/**/*.{ts,tsx,js,jsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    // Test files: vitest globals + relaxed `any` (used heavily for mocks).
    files: [
      "packages/*/src/**/*.test.{ts,tsx}",
      "packages/*/test/**/*.{ts,tsx}",
      "packages/*/src/**/__tests__/**/*.{ts,tsx}",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Mock fixtures and partial-shape stubs commonly rely on `any`; the
      // alternative (full type declarations for every mock) yields no real
      // safety in a test context and would dwarf the assertions themselves.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  prettierConfig,
);
