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
    // Vendored, minified third-party code served as-is: the Draco mesh
    // decoder that unpacks the hand model (copied from three/examples).
    "public/draco/**",
    // The standalone extension has its own parser and behavior checks in verify-report.cjs.
    "extension/**",
    "public/encoder/**",
    "public/coi-serviceworker.js",
    "artifacts/**",
  ]),
  { files: ["scripts/verify-report.cjs"], rules: { "@typescript-eslint/no-require-imports": "off" } },
]);

export default eslintConfig;
