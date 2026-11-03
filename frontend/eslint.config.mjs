import js from "@eslint/js";
import react from "@eslint-react/eslint-plugin";
import next from "@next/eslint-plugin-next";
import { defineConfig, globalIgnores } from "eslint/config";
import jsxA11y from "eslint-plugin-jsx-a11y-x";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const eslintConfig = defineConfig([
  // Direct plugins keep the ESLint 10 tree free of the legacy Next config's
  // incompatible peer ranges and minimatch function API dependencies.
  {
    files: ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"],
    extends: [
      js.configs.recommended,
      react.configs.recommended,
      reactHooks.configs.flat.recommended,
      next.configs["core-web-vitals"],
    ],
    plugins: { "jsx-a11y-x": jsxA11y },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // Preserve Next's six accessibility checks and Image component mapping.
      "jsx-a11y-x/alt-text": ["warn", { elements: ["img"], img: ["Image"] }],
      "jsx-a11y-x/aria-props": "warn",
      "jsx-a11y-x/aria-proptypes": "warn",
      "jsx-a11y-x/aria-unsupported-elements": "warn",
      "jsx-a11y-x/role-has-required-aria-props": "warn",
      "jsx-a11y-x/role-supports-aria-props": "warn",
      // The former import plugin enabled only no-anonymous-default-export.
      // Core selectors retain that check without its incompatible glob API.
      "no-restricted-syntax": [
        "warn",
        {
          selector: "ExportDefaultDeclaration > :matches(ArrayExpression, ArrowFunctionExpression, Literal, ObjectExpression, TemplateLiteral, NewExpression, ClassDeclaration[id=null], FunctionDeclaration[id=null])",
          message: "Assign the value to a named variable before exporting it as the module default.",
        },
      ],
    },
  },
  {
    files: ["**/*.{ts,mts,cts,tsx}"],
    extends: [tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-expressions": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "public/headless/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
