import type { PlatformId, SocketAddressPolicy } from '../ports';
import {
  darwinSocketPathLimitBytes,
  linuxSocketPathLimitBytes,
  windowsPipeNameLimitCharacters,
} from './limits';
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

/**
 * Provisional, unlike the other two (Increment D1, D7/D8): `limitBytes` is actually a character
 * count on a named pipe's name, not `sizeof(sun_path)`, and `boundPathFor` is the identity
 * function because there is no bind-then-link step to derive a private name for. See
 * `windowsPipeNameLimitCharacters`'s own comment.
 */
export const windowsSocketAddressPolicy: SocketAddressPolicy = {
  limitBytes: windowsPipeNameLimitCharacters,
  boundPathFor: (publishedPath: string) => publishedPath,
};

const policies: Readonly<Record<PlatformId, SocketAddressPolicy>> = {
  darwin: darwinSocketAddressPolicy,
  linux: linuxSocketAddressPolicy,
  win32: windowsSocketAddressPolicy,
};

export function socketAddressPolicyFor(platform: PlatformId): SocketAddressPolicy {
  return policies[platform];
}
