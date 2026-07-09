import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import vitest from "@vitest/eslint-plugin";
import { defineConfig } from "eslint/config";
import { flatConfigs as importXConfigs } from "eslint-plugin-import-x";
import nodePlugin from "eslint-plugin-n";
import promise from "eslint-plugin-promise";
import * as regexp from "eslint-plugin-regexp";
import unicorn from "eslint-plugin-unicorn";
import globals from "globals";
import tseslint from "typescript-eslint";

const TS_FILES = ["**/*.ts", "**/*.mts", "**/*.cts"];
const JS_FILES = ["**/*.js", "**/*.mjs", "**/*.cjs"];
const TEST_FILES = ["**/*.test.ts", "**/*.spec.ts"];
const CONFIG_TS_FILES = [
  "**/vitest.config.ts",
  "**/drizzle.config.ts",
  "**/oxfmt.config.ts",
];

export default defineConfig(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/node_modules/**",
      ".claude/**",
      "**/*.md",
      // drizzle-kit generated migration metadata.
      "packages/db/drizzle/**",
    ],
  },

  // Baseline JS + TypeScript strict + stylistic (type-aware).
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  // Cross-cutting plugins (flat configs).
  unicorn.configs.recommended,
  importXConfigs.recommended,
  importXConfigs.typescript,
  // @ts-expect-error: @types/eslint-plugin-promise@7.3.0 still types
  // `languageOptions` against @types/eslint@9, which has a wider index
  // signature than @eslint/core's `LanguageOptions` (ESLint 10). Runtime
  // shape is correct; remove once upstream republishes against ESLint 10.
  promise.configs["flat/recommended"],
  // `n` ships both legacy and flat configs; only the `flat/` variants
  // are flat-config shaped.
  nodePlugin.configs["flat/recommended-module"],
  // RegExp safety: catches polynomial-backtracking shapes, bad
  // assertions, useless escapes, etc.
  regexp.configs["flat/recommended"],
  // Targeted stylistic rules only; oxfmt owns formatting, so keep the
  // overlap narrow and deliberate.
  {
    plugins: { "@stylistic": stylistic },
    rules: {
      "@stylistic/no-trailing-spaces": "error",
      "@stylistic/object-curly-spacing": ["error", "always"],
      "@stylistic/keyword-spacing": "error",
    },
  },

  // Pin `n`'s view of the target Node.js to the lowest version we
  // support at runtime instead of letting it read each package's
  // `engines.node` range (unbounded ranges cause false positives on
  // APIs stabilised mid-major). 24.10.0 is the floor where
  // `process.loadEnvFile` left experimental status.
  {
    settings: {
      n: {
        version: "24.10.0",
      },
    },
  },

  // Project-wide overrides of `unicorn.configs.recommended` defaults.
  {
    rules: {
      // Renames `req`/`params`/`err`/`fn` etc.; not worth the churn.
      "unicorn/prevent-abbreviations": "off",
      // `null` and `undefined` are not interchangeable here:
      // JSON-serialised API payloads and SQL NULL round-trips treat
      // them differently.
      "unicorn/no-null": "off",
      // Early-return guard clauses routinely read better negated.
      "unicorn/no-negated-condition": "off",
      "unicorn/catch-error-name": "off",
      // Prefer explicit `return undefined;` for clarity.
      "unicorn/no-useless-undefined": "off",
      // Concise expression-style `case "x": return foo;` stays legal.
      "unicorn/switch-case-braces": "off",
      "unicorn/filename-case": ["error", { cases: { kebabCase: true } }],
    },
  },

  // Type-aware parser options for all TS files. `projectService` lets
  // typescript-eslint discover the nearest tsconfig per file; the
  // `allowDefaultProject` glob covers loose config files that aren't
  // included in any package tsconfig.
  {
    files: TS_FILES,
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "eslint.config.ts",
            "*.config.ts",
            "*.config.mjs",
            "*.config.js",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node, ...globals.es2024 },
    },
    rules: {
      eqeqeq: ["error", "always"],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
      // `while (true)` is the idiomatic infinite-loop spelling for
      // poll/retry loops.
      "@typescript-eslint/no-unnecessary-condition": [
        "error",
        { allowConstantLoopConditions: true },
      ],
      // Don't require a `return` from the *last* `.then` in a chain.
      "promise/always-return": ["error", { ignoreLastCallback: true }],
      // Honor the `_`-prefix convention for intentionally unused
      // parameters and bindings.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      // Skip `||` on boolean primitives: `a || b` on booleans is
      // semantically boolean OR; rewriting to `??` would change
      // behaviour.
      "@typescript-eslint/prefer-nullish-coalescing": [
        "error",
        { ignorePrimitives: { boolean: true } },
      ],
      // Both `interface` and `type` are legitimate; leave the choice
      // to the author.
      "@typescript-eslint/consistent-type-definitions": "off",
      // Fires on the common fire-and-forget handler pattern
      // `() => doThing()` where the inner call returns void.
      "@typescript-eslint/no-confusing-void-expression": "off",
      // `number` is safe to interpolate (toString is unambiguous) and
      // pervasive in URLs, ports, and log lines. `null`/`undefined`/
      // `object`/`RegExp` interpolation stays an error.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
      "import-x/no-cycle": "error",
      // Relative imports use explicit `.js` extensions (nodenext);
      // `n`'s Node-perspective resolver can't map them back to the
      // `.ts` sources, so the typescript resolver from import-x owns
      // missing-import detection.
      "n/no-missing-import": "off",
      "import-x/order": [
        "error",
        {
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
          groups: [
            "builtin",
            "external",
            "internal",
            "parent",
            "sibling",
            "index",
            "object",
            "type",
          ],
        },
      ],
    },
  },

  // Plain JS / mjs files: turn off type-aware rules and use Node
  // script env.
  {
    files: JS_FILES,
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { ...globals.node, ...globals.es2024 },
    },
  },

  // Vitest tests.
  {
    files: TEST_FILES,
    plugins: { vitest },
    languageOptions: {
      globals: { ...vitest.environments.env.globals },
    },
    rules: {
      ...vitest.configs.recommended.rules,
      // vitest's `expect(actual, message)` two-argument form is used
      // in exhaustive table-driven loops so a failure names the exact
      // (from, to) pair.
      "vitest/valid-expect": ["error", { maxArgs: 2 }],
      // Test stubs and mock callbacks routinely use empty function
      // bodies.
      "@typescript-eslint/no-empty-function": "off",
      // Tests set up the data they assert on, so `!` typically encodes
      // an invariant the test itself just established.
      "@typescript-eslint/no-non-null-assertion": "off",
      // Mock/spy plumbing surfaces `any` everywhere; asserting the
      // right shape at each probe crushes test readability. These stay
      // on for production code.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // Helper closures inside `describe`/`it` keep setup next to the
      // assertions they support.
      "unicorn/consistent-function-scoping": "off",
      // `expect((await res.json()).error)` keeps arrange and assert
      // together.
      "unicorn/no-await-expression-member": "off",
      // Tests legitimately delete env vars by computed key during
      // cleanup.
      "@typescript-eslint/no-dynamic-delete": "off",
      // Conditional `expect()` inside try/finally is a normal pattern
      // for cleanup-after-assertion flows.
      "vitest/no-conditional-expect": "off",
      // Test titles often quote endpoint paths or flag names.
      "vitest/valid-title": "off",
      // Destructuring built-in module methods and snapshotting
      // prototypes for restoration are safe `this`-free uses.
      "@typescript-eslint/unbound-method": "off",
      // The vitest idiom `let db; beforeEach(() => { db = ... })` is
      // the documented way to share per-test fixtures; the rule would
      // force awkward per-test factories for no isolation gain.
      "unicorn/no-top-level-assignment-in-function": "off",
    },
  },

  // Config files: type-aware off, since they aren't part of any
  // package's narrow build tsconfig include.
  {
    files: [...CONFIG_TS_FILES, "eslint.config.ts", "oxlint.config.ts"],
    ...tseslint.configs.disableTypeChecked,
  },

  // eslint.config.ts itself: typescript-eslint and import-x
  // intentionally expose `configs` / `flatConfigs` as both default and
  // named exports, which trips `import-x/no-named-as-default-member`.
  {
    files: ["eslint.config.ts"],
    rules: {
      "import-x/no-named-as-default-member": "off",
      "n/no-unsupported-features/node-builtins": "off",
    },
  },

  // Service/CLI entry points: `process.exit()` is the standard way to
  // set the shell exit code at the process root.
  {
    files: [
      "**/src/dev.ts",
      "**/src/bin.ts",
      "**/src/seed.ts",
      "**/scripts/**/*.{mjs,js,ts}",
    ],
    rules: {
      "n/no-process-exit": "off",
      "unicorn/no-process-exit": "off",
      "n/hashbang": "off",
    },
  },
);
