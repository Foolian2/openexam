import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Sibling apps with their own toolchains, plus generated/build output.
    // Without these, `pnpm lint` walks the Tauri Rust target dir and fails on
    // binary artifacts, burying real findings under thousands of errors.
    "desktop/**",
    "design-preview/**",
    "openexam/**",
    "generated/**",
    "seb/**",
    "ws-backend/**",
    ".worktrees/**",
  ]),
]);

export default eslintConfig;
