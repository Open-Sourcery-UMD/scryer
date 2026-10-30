const wholeDollarFormatter = new Intl.NumberFormat("en-US", {
  useGrouping: true,
  maximumFractionDigits: 0,
});

/** @param {string} value @returns {string} */
export function formatUsdMinor(value) {
  if (!/^(?:0|-?[1-9][0-9]*)$/.test(value)) {
    throw new Error("Invalid minor-unit amount");
  }

  const cents = BigInt(value);
  const magnitude = cents < BigInt(0) ? -cents : cents;
  const dollars = wholeDollarFormatter.format(magnitude / BigInt(100));
  const remainder = (magnitude % BigInt(100)).toString().padStart(2, "0");
  return `${cents < BigInt(0) ? "-" : ""}$${dollars}.${remainder}`;
}
