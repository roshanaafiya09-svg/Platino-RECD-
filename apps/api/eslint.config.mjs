// ESLint 9 "flat" configuration for the API (apps/api). Run with `npm run lint` (eslint src).
// ESLint's recommended rules + typescript-eslint's recommended rules (syntax-level, no type-aware linting, so it stays fast and needs
// no tsconfig wiring). Type correctness is already enforced by `tsc` (npm run build). Nothing is switched off to make existing code pass.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Never lint build output, installed packages or generated code.
    ignores: ["dist/**", "node_modules/**", "**/generated/**", "prisma/migrations/**", ".vercel/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      // A leading underscore marks a parameter that is deliberately unused (Express handlers like (_req, res) and error handlers).
      // ignoreRestSiblings: `const { passwordHash, ...safeUser } = user` is the standard way to leave fields OUT of a response.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  {
    // googleapis is loaded on first use on purpose (it is large and slows every cold start); see the comment in that file.
    files: ["src/lib/googleDrive.ts"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // Plain Node scripts (CommonJS) are allowed to use require().
    files: ["**/*.js", "**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { require: "readonly", module: "writable", process: "readonly", console: "readonly", __dirname: "readonly" } },
  },
);
