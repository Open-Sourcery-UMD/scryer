export const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

export function validId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

export function exactKeys(value: unknown, expected: readonly string[]): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

export function validInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !UTC.test(value) || value.startsWith('0000-')) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().replace('.000', '') === value;
}

export function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) ||
      value.startsWith('0000-')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
