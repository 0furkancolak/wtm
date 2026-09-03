/**
 * The Windows `ProcessPlatform` — a **named, visible TODO**, not an implementation (spec
 * `2026-09-03-windows-trust-and-transport-seam.md`, D8).
 *
 * Every other port in this increment (`FileTrustPolicy`, `PlatformPaths`, `ServiceBackend`) is
 * decidable on this macOS host because its real work is parsing structured text — a `Get-Acl`
 * JSON blob, a `schtasks` report — against a fixture. Process identity and process-group
 * liveness on Windows are answered by Job Object handles and `QueryFullProcessImageName`-shaped
 * Win32 calls, which have no fixture equivalent: there is no captured text this file could parse
 * to prove the decision the way `proc-stat.ts` proves `/proc/<pid>/stat` parsing without a Linux
 * kernel. Writing a plausible-looking body here would be exactly the mistake this program's own
 * findings keep naming — a claim proven against nothing, waiting to be found wrong on first
 * contact with a real Windows host.
 *
 * So this file exists to make `PlatformId`'s widening to `'win32'` a type-complete choice (every
 * indexed-dispatch table in this package must have an entry for every `PlatformId`) without
 * silently answering a question D1 cannot answer. Every method throws a coded, named error
 * pointing at the increment that owns the real implementation, which is D2's job, not a `never`
 * that would fail to compile only if something ever actually called it on this platform — and
 * nothing does, because `selectPlatformRuntime` still refuses `win32` outright (`select.ts`).
 */
import type { ProcessGroupInspection, ProcessInspection, ProcessPlatform } from '../ports';

export class WindowsProcessPlatformNotImplementedError extends Error {
  readonly code = 'WTM_PLATFORM_NOT_YET_IMPLEMENTED' as const;

  constructor(method: string) {
    super(
      `ProcessPlatform.${method} has no Windows implementation yet. Job Object-based process `
      + 'identity and group liveness are Increment D2 (2026-08-31-v1-stable-program-map.md), '
      + 'which needs a real Windows host to prove against — see D8 of '
      + '2026-09-03-windows-trust-and-transport-seam.md.',
    );
    this.name = 'WindowsProcessPlatformNotImplementedError';
  }
}

export function createWindowsProcessPlatform(): ProcessPlatform {
  return {
    readStartTime(_pid: number): Promise<string | null> {
      throw new WindowsProcessPlatformNotImplementedError('readStartTime');
    },
    inspectProcess(_pid: number): Promise<ProcessInspection> {
      throw new WindowsProcessPlatformNotImplementedError('inspectProcess');
    },
    inspectProcessGroup(_pgid: number): Promise<ProcessGroupInspection> {
      throw new WindowsProcessPlatformNotImplementedError('inspectProcessGroup');
    },
  };
}
