import { defineConfig } from "oxfmt";

// oxfmt owns formatting (whitespace, wrapping, quotes, trailing
// commas). `sortPackageJson` / `sortImports` stay disabled so
// package.json key order stays as authored and import ordering stays
// owned by ESLint's `import-x/order`. Markdown and YAML are excluded:
// prose and workflow files are hand-managed. The generated config JSON
// Schemas are owned by their generator (JSON.stringify), so oxfmt must
// not reformat them or `schemas:generate` output would fail the gate.
export default defineConfig({
  printWidth: 80,
  tabWidth: 2,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  sortPackageJson: false,
  sortImports: false,
  ignorePatterns: [
    ".claude/**",
    "**/*.md",
    "**/*.yaml",
    "**/*.yml",
    "packages/protocol/schemas/**",
  ],
});
