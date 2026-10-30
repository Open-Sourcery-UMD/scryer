import assert from "node:assert/strict";
import { test } from "node:test";
import { formatUsdMinor } from "../../frontend/lib/format-money.mjs";

test("formats signed minor units without rounding or losing large integers", () => {
  assert.equal(formatUsdMinor("0"), "$0.00");
  assert.equal(formatUsdMinor("150000"), "$1,500.00");
  assert.equal(formatUsdMinor("90000"), "$900.00");
  assert.equal(formatUsdMinor("-60000"), "-$600.00");
  assert.equal(formatUsdMinor("900719925474099300"), "$9,007,199,254,740,993.00");
});

test("refuses noncanonical money strings", () => {
  for (const value of ["", "01", "-0", "1.5", "1e3", " 100", "+100"]) {
    assert.throws(() => formatUsdMinor(value), /Invalid minor-unit amount/);
  }
});
