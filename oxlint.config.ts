import { defineConfig } from "oxlint";

// Fast pre-flight linter. Every package's `lint` script runs
// `oxlint --type-aware --deny-warnings . && eslint .`; this config
// mirrors the non-type-aware rules configured in `eslint.config.ts`
// so the two linters agree. `--type-aware` (tsgo-backed via
// oxlint-tsgolint) additionally enables the type-aware rules in the
// enabled categories (e.g. typescript/no-floating-promises);
// typescript-eslint's strictTypeChecked remains the second opinion on
// the ESLint side.
export default defineConfig({
  plugins: ["typescript", "unicorn", "oxc", "import", "promise"],
  categories: {
    correctness: "error",
  },
  env: {
    builtin: true,
    node: true,
    es2024: true,
  },
  ignorePatterns: [
    "**/dist/**",
    "**/coverage/**",
    "**/.turbo/**",
    "**/node_modules/**",
    ".claude/**",
    "**/*.md",
  ],
  rules: {
    eqeqeq: ["error", "always"],
    "typescript/consistent-type-imports": [
      "error",
      { prefer: "type-imports", fixStyle: "inline-type-imports" },
    ],
    "typescript/no-import-type-side-effects": "error",
    "promise/always-return": ["error", { ignoreLastCallback: true }],
    "import/no-cycle": "error",
    "no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
      },
    ],
    "unicorn/filename-case": ["error", { cases: { kebabCase: true } }],
    "unicorn/no-null": "off",
    "unicorn/no-negated-condition": "off",
    "unicorn/catch-error-name": "off",
    "unicorn/no-useless-undefined": "off",
    "unicorn/switch-case-braces": "off",
  },
  overrides: [
    {
      files: ["**/*.test.ts", "**/*.spec.ts"],
      plugins: ["typescript", "unicorn", "oxc", "import", "promise", "vitest"],
      env: {
        node: true,
      },
      rules: {
        "vitest/require-mock-type-parameters": "off",
        "vitest/no-conditional-expect": "off",
        "vitest/valid-title": "off",
        "typescript/no-empty-function": "off",
        "typescript/no-non-null-assertion": "off",
        "typescript/no-dynamic-delete": "off",
        "unicorn/consistent-function-scoping": "off",
        "unicorn/no-await-expression-member": "off",
      },
    },
    {
      files: ["**/scripts/**/*.{mjs,js,ts}", "**/bin.ts", "**/dev.ts"],
      rules: {
        "unicorn/no-process-exit": "off",
      },
    },
  ],
});
