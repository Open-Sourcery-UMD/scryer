import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const frontend = fileURLToPath(new URL("../../frontend/", import.meta.url));
const require = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { ESLint } = require("eslint");
const eslint = new ESLint({ cwd: frontend });

async function messages(source, file = "app/lint-policy-canary.tsx") {
  const [result] = await eslint.lintText(source, { filePath: path.join(frontend, file) });
  assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
  return result.messages;
}

test("anonymous default values are warned while named values and factory calls remain valid", async () => {
  for (const source of [
    "export default {};",
    "export default [];",
    "export default () => null;",
    "export default function () {}",
    "export default class {}",
    "export default new Date();",
    "export default 42;",
    "export default `literal`;",
  ]) {
    const diagnostics = await messages(source);
    assert.ok(diagnostics.some(({ ruleId, severity }) =>
      ruleId === "no-restricted-syntax" && severity === 1), source);
  }
  for (const source of [
    "const config = {}; export default config;",
    "export default function Named() { return null; }",
    "export default class Named {}",
    "function config() { return {}; } export default config();",
  ]) {
    assert.equal((await messages(source)).some(({ ruleId }) =>
      ruleId === "no-restricted-syntax"), false, source);
  }
});

test("React hooks and component keys remain linted", async () => {
  const hooks = await messages(`
    import { useState } from "react";
    export default function Component({ enabled }: { enabled: boolean }) {
      if (enabled) useState(0);
      return null;
    }
  `);
  assert.ok(hooks.some(({ ruleId, severity }) =>
    ruleId === "react-hooks/rules-of-hooks" && severity === 2));

  const keys = await messages(`
    export default function Component() {
      return ["one", "two"].map(value => <span>{value}</span>);
    }
  `);
  assert.ok(keys.some(({ ruleId, severity }) =>
    ruleId === "@eslint-react/no-missing-key" && severity === 2));
});

test("accessibility rules validate images, ARIA, and custom label component globs", async () => {
  const diagnostics = await messages(`
    import Image from "next/image";
    export default function Component() {
      return <div aria-invalid-prop="true"><img src="/image.png" /><Image src="/image.png" /></div>;
    }
  `);
  assert.equal(diagnostics.filter(({ ruleId }) => ruleId === "jsx-a11y-x/alt-text").length, 2);
  assert.ok(diagnostics.some(({ ruleId }) => ruleId === "jsx-a11y-x/aria-props"));

  // This option exercises the accessibility plugin's minimatch consumer.
  const labelLint = new ESLint({
    cwd: frontend,
    overrideConfig: {
      rules: {
        "jsx-a11y-x/label-has-associated-control": ["error", { labelComponents: ["Custom*"] }],
      },
    },
  });
  const [labels] = await labelLint.lintText(
    "export default function Component() { return <CustomLabel />; }",
    { filePath: path.join(frontend, "app/lint-policy-canary.tsx") },
  );
  assert.equal(labels.fatalErrorCount, 0, JSON.stringify(labels.messages));
  assert.ok(labels.messages.some(({ ruleId }) =>
    ruleId === "jsx-a11y-x/label-has-associated-control"));
});

test("Next Core Web Vitals and TypeScript checks remain active", async () => {
  const next = await messages(`
    export default function Component() { return <script src="/blocking.js" />; }
  `);
  assert.ok(next.some(({ ruleId, severity }) =>
    ruleId === "@next/next/no-sync-scripts" && severity === 2));

  const types = await messages("export const value: any = 1;");
  assert.ok(types.some(({ ruleId, severity }) =>
    ruleId === "@typescript-eslint/no-explicit-any" && severity === 2));
});

test("generated outputs remain ignored while application files remain included", async () => {
  for (const file of [".next/server/canary.js", "public/headless/canary.js", "out/canary.js", "build/canary.js", "next-env.d.ts"]) {
    assert.equal(await eslint.isPathIgnored(path.join(frontend, file)), true, file);
  }
  for (const file of ["app/lint-policy-canary.tsx", "components/ui/canary.tsx", "lib/canary.ts", "scripts/canary.mjs"]) {
    assert.equal(await eslint.isPathIgnored(path.join(frontend, file)), false, file);
  }
});

test("TypeScript project-service file matching works with the patched glob dependency", async () => {
  // allowDefaultProject exercises typescript-estree's named minimatch API,
  // while the policy/ignore tests exercise ESLint's Minimatch class API.
  const projectLint = new ESLint({
    cwd: frontend,
    overrideConfig: {
      languageOptions: {
        parserOptions: {
          projectService: { allowDefaultProject: ["lint-policy-project-service-canary.tsx"] },
          tsconfigRootDir: frontend,
        },
      },
    },
  });
  const [result] = await projectLint.lintText("export const amount: number = 1;", {
    filePath: path.join(frontend, "lint-policy-project-service-canary.tsx"),
  });
  assert.equal(result.errorCount, 0, JSON.stringify(result.messages));
  assert.equal(result.fatalErrorCount, 0);
});
