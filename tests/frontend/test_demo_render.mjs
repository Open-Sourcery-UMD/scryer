import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rendered = (name) => readFileSync(path.join(root, "frontend/.next/server/app", name), "utf8")
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
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

test("refund and bank stages link to separate visible source and approval records", () => {
  const html = rendered("demo.html");
  for (const [id, source, review] of [
    ["observation-refund", "refund-a · page:1", "review-issued-refund"],
    ["observation-bank", "bank-a · row:1", "review-bank-credit"],
  ]) {
    assert.ok(html.includes(`href="#${id}"`), `Missing link to ${id}`);
    const card = html.match(new RegExp(`<article[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/article>`));
    assert.ok(card, `Missing visible ${id} card`);
    assert.ok(card[1].includes(source), `Wrong source in ${id}`);
    assert.ok(card[1].includes(review), `Wrong review in ${id}`);
  }
});

test("a corrected amount shows both original and revised provenance", () => {
  const html = rendered("demo.html");
  const grant = html.match(/<details[^>]*id="fact-grant"[^>]*>([\s\S]*?)<\/details>/);
  assert.ok(grant, "Missing corrected grant fact");
  assert.match(grant[0], /\bopen=""/);
  for (const phrase of [
    "Original source",
    "aid-a · row:1",
    "review-grant",
    "Revised source",
    "aid-a · row:1-revised",
    "review-grant-correction",
    "Artifact",
  ]) {
    assert.ok(grant[1].includes(phrase), `Missing corrected grant provenance: ${phrase}`);
  }
});
