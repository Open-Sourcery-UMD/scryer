import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const snapshotPath = path.join(root, "frontend/data/demo-result.json");
const binary = path.join(root, "engine/build/scryer-native");

test("checked-in sample matches the native engine and its reviewed story", () => {
  const response = JSON.parse(
    execFileSync(binary, {
      cwd: root,
      input: JSON.stringify({ schemaVersion: "1", operation: "demo" }),
      encoding: "utf8",
    }),
  );
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));

  assert.deepEqual(snapshot, response);
  assert.equal(snapshot.schemaVersion, "1");
  assert.equal(snapshot.operation, "demo");
  assert.equal(snapshot.result.before.amountMinor, "150000");
  assert.equal(snapshot.result.after.amountMinor, "90000");
  assert.equal(snapshot.result.before.status, "SUPPORTED_BY_UPLOADED_RECORDS");
  assert.equal(snapshot.result.after.status, "SUPPORTED_BY_UPLOADED_RECORDS");
  assert.equal(snapshot.result.comparison.deltaMinor, "-60000");
  assert.deepEqual(
    snapshot.result.comparison.contributions.map((item) => [item.factId, item.deltaMinor]),
    [["extra-charge", "-30000"], ["grant", "-30000"]],
  );
  assert.equal(snapshot.result.refundObservation.role, "refund_issued");
  assert.equal(snapshot.result.bankObservation.role, "bank_credit_observed");
  assert.notEqual(snapshot.result.refundObservation.factId, snapshot.result.bankObservation.factId);
  assert.equal(snapshot.result.receipt.facts.length, 4);
  assert.equal(snapshot.result.receipt.facts.some((fact) => fact.proposalId === "proposal-unreviewed"), false);
});
