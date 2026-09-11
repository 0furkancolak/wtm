import type { PlatformId } from '../ports';
import { readLinuxMountBoundaries } from './linux';

/** Same-device mount evidence is currently available only on Linux. */
export function mountBoundaryReaderFor(platform: PlatformId): typeof readLinuxMountBoundaries | undefined {
  return platform === 'linux' ? readLinuxMountBoundaries : undefined;
}
