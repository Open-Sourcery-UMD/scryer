import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rendered = (name) => readFileSync(path.join(root, "frontend/.next/server/app", name), "utf8")
  .replace(/<!--[\s\S]*?-->/g, "");

test("public landing page explains Scryer's evidence-tracing purpose", () => {
  const html = rendered("index.html");
  assert.match(html, /Trace financial aid from promise to deposit/);
  assert.match(html, /Try the synthetic case/);
  assert.match(html, /reviewed evidence/);
});

test("sample page shows engine-derived change and keeps evidence stages distinct", () => {
  const html = rendered("demo.html");
  for (const phrase of [
    "Synthetic case",
    "$1,500.00",
    "$900.00",
    "-$600.00",
    "Why did the surplus change?",
    "Revised grant",
    "New school charge",
    "Source and calculation inspector",
    "review-grant-correction",
    "Issued refund",
    "Observed bank credit",
    "not a confirmed match",
    "Not an eligibility or entitlement decision",
    "lowers the calculated surplus by $300.00",
    "Supported by sample records",
  ]) {
    assert.ok(html.includes(phrase), `Missing rendered demo content: ${phrase}`);
  }
  assert.equal(html.includes("proposal-unreviewed"), false);
});
