import { CSV_LIMITS } from './csv.ts';
import { ImportError } from './errors.ts';
import { sha256Hex } from './hash.ts';
import type { Artifact } from './types.ts';

export type SourceAvailability = 'AVAILABLE' | 'SOURCE_UNAVAILABLE' | 'HASH_MISMATCH';

export async function sourceAvailability(artifact: Artifact, bytes: Uint8Array | null): Promise<SourceAvailability> {
  if (!artifact || typeof artifact.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
    throw new ImportError('INVALID_ARTIFACT');
  }
  if (bytes === null) return 'SOURCE_UNAVAILABLE';
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > CSV_LIMITS.inputBytes) {
    throw new ImportError('INVALID_SOURCE');
  }
  const digest = await sha256Hex(new Uint8Array(bytes));
  return digest === artifact.sha256 ? 'AVAILABLE' : 'HASH_MISMATCH';
}
