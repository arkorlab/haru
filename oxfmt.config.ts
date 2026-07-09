import { defineConfig } from "oxfmt";

// oxfmt owns formatting (whitespace, wrapping, quotes, trailing
// commas). `sortPackageJson` / `sortImports` stay disabled so
// package.json key order stays as authored and import ordering stays
// owned by ESLint's `import-x/order`. Markdown and YAML are excluded:
// prose and workflow files are hand-managed.
export default defineConfig({
  printWidth: 80,
  tabWidth: 2,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  sortPackageJson: false,
  sortImports: false,
  ignorePatterns: [".claude/**", "**/*.md", "**/*.yaml", "**/*.yml"],
});
