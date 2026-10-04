const MAX_MINOR = 9223372036854775807n;

export type ParsedAmount = { sign: -1 | 0 | 1; minor: string };

export function isPositiveMinor(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value) &&
    value.length <= 19 && BigInt(value) <= MAX_MINOR;
}

export function parseUsAmount(raw: string): ParsedAmount | null {
  let value = raw.trim();
  let negative = false;
  if (value.startsWith('(') && value.endsWith(')')) {
    negative = true;
    value = value.slice(1, -1);
  } else if (value.startsWith('-')) {
    negative = true;
    value = value.slice(1);
  }
  const match = /^([0-9]+|[1-9][0-9]{0,2}(?:,[0-9]{3})+)(?:\.([0-9]{1,2}))?$/.exec(value);
  if (!match) return null;
  const whole = match[1];
  if (whole === undefined) return null;
  const digits = whole.replaceAll(',', '').replace(/^0+(?=[0-9])/, '');
  if (digits.length > 17) return null;
  const cents = BigInt(digits) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  if (cents > MAX_MINOR) return null;
  return { sign: cents === 0n ? 0 : negative ? -1 : 1, minor: cents.toString() };
}
