import type { EndpointCandidate } from '../state/store';

export const maxEndpointBatchCandidates = 256;
export const maxEndpointBatchInputBytes = 128 * 1024;

/** Private helper wire contract. Positions preserve host/protocol identity as well as port. */
export function parseEndpointBatch(raw: string): readonly EndpointCandidate[] | null {
  if (Buffer.byteLength(raw) > maxEndpointBatchInputBytes) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== 1 || !Array.isArray(object.candidates)
    || object.candidates.length < 1 || object.candidates.length > maxEndpointBatchCandidates) return null;
  if (!object.candidates.every((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
    const candidate = entry as Record<string, unknown>;
    return Object.keys(candidate).length === 3
      && (candidate.protocol === 'tcp' || candidate.protocol === 'udp')
      && typeof candidate.host === 'string' && candidate.host.length > 0 && candidate.host.length <= 253
      && !candidate.host.includes('\0')
      && typeof candidate.port === 'number' && Number.isInteger(candidate.port)
      && candidate.port >= 1 && candidate.port <= 65_535;
  })) return null;
  return object.candidates as EndpointCandidate[];
}

export function validEndpointBatchResults(value: unknown, count: number): value is readonly boolean[] {
  return Array.isArray(value) && value.length === count && value.every((entry) => typeof entry === 'boolean');
}
