import type { PlatformId, SocketAddressPolicy } from '../ports';
import { darwinSocketPathLimitBytes, linuxSocketPathLimitBytes } from './limits';
import { boundDaemonSocketPath } from './socket-path';

/**
 * The socket port, per platform.
 *
 * There is one implementation and two constants: the bind-path derivation is arithmetic on a
 * filename and is identical everywhere, so writing it twice would create two things to keep
 * true for no gain. What genuinely differs is `sizeof(sun_path)`, and that is the whole port.
 */

export const darwinSocketAddressPolicy: SocketAddressPolicy = {
  limitBytes: darwinSocketPathLimitBytes,
  boundPathFor: boundDaemonSocketPath,
};

export const linuxSocketAddressPolicy: SocketAddressPolicy = {
  limitBytes: linuxSocketPathLimitBytes,
  boundPathFor: boundDaemonSocketPath,
};

export function socketAddressPolicyFor(platform: PlatformId): SocketAddressPolicy {
  return platform === 'linux' ? linuxSocketAddressPolicy : darwinSocketAddressPolicy;
}
