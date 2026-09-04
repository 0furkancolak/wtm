/**
 * The Windows `FileTrustPolicy` (spec `2026-09-03-windows-trust-and-transport-seam.md`, D3).
 *
 * `fs.Stats` carries no owner or ACL information on Windows — `uid` is hardcoded `0` and `mode`'s
 * write bits do not reflect NTFS permissions at all — so this implementation does not consult the
 * `stat` it is handed for ownership or write-access questions (it still uses `stat.nlink`, which
 * Node does read from Windows's own `nNumberOfLinks`, for the hard-link predicate). Ownership and
 * access come from an injected reader that shells to `powershell.exe`, the same way every other
 * platform-specific port in this package shells to *its* platform's own inspection tool (`ps`,
 * `/proc`, `systemctl show`) rather than reimplementing the OS in a native addon.
 *
 * **This is documented, fixture-tested behaviour, not a measurement.** Nothing on this macOS host
 * can run `powershell.exe` or bind a real ACL, so `__tests__/windows.test.ts` proves the decision
 * logic against captured `Get-Acl`-shaped JSON and proves nothing about a real NTFS volume — the
 * same caveat C1 attached to the Linux `sun_path` limit before C2 measured it. Increment D2 is
 * where a second real Windows account is the thing that tries to read a path this policy allowed
 * or denied.
 */
import type { FileTrustPolicy, NodeJsStats, OwnerOnlyMask } from '../ports';

/** One access-control entry, as `Get-Acl`'s `.Access` reports it. */
export interface WindowsAccessRule {
  /** The security identifier of the principal the rule names — never a display name (D3: a
   *  display name can be renamed or localized, a SID cannot). */
  readonly identitySid: string;
  readonly accessControlType: 'Allow' | 'Deny';
  /** `FileSystemRights.ToString()`'s comma-separated flag names, e.g. `"Modify, Synchronize"`. */
  readonly fileSystemRights: string;
}

export interface WindowsPathAcl {
  readonly ownerSid: string;
  readonly accessRules: readonly WindowsAccessRule[];
}

/**
 * Reads one path's owner and ACL. Resolves `undefined` when the path's ACL cannot be read at all
 * (missing, or `powershell.exe` failed) — distinct from a `WindowsPathAcl` whose owner simply does
 * not match, which is a normal, decidable answer.
 */
export type WindowsAclReader = (path: string) => Promise<WindowsPathAcl | undefined>;

/** Resolves `null` when the current user's own SID cannot be determined. */
export type CurrentWindowsUserSidReader = () => Promise<string | null>;

/**
 * Principals trusted the way POSIX's checks implicitly trust root: a POSIX `mode` check does not
 * (and cannot) exclude root, who can read or write any file regardless of its bits, and this is
 * the same allowance, named rather than implicit. `S-1-5-18` is the well-known LocalSystem SID;
 * `S-1-5-32-544` is the well-known Administrators group SID. Both are constant on every Windows
 * installation — unlike an owner or a named user, a well-known SID is not localized or renamed.
 */
export const windowsTrustedPrincipalSids: readonly string[] = ['S-1-5-18', 'S-1-5-32-544'];

/**
 * `FileSystemRights` flag names that grant the ability to change a file's contents, attributes, or
 * permissions. Deliberately more than a `Write` substring match: `AppendData` and
 * `DeleteSubdirectoriesAndFiles` do not contain the word "Write" but are still write-capable, and a
 * substring match would miss them.
 */
const writeCapableRightNames: ReadonlySet<string> = new Set([
  'WriteData', 'AppendData', 'WriteExtendedAttributes', 'WriteAttributes', 'Write', 'Delete',
  'DeleteSubdirectoriesAndFiles', 'ChangePermissions', 'TakeOwnership', 'Modify', 'FullControl',
]);

function grantsWriteCapableAccess(rule: WindowsAccessRule): boolean {
  return rule.fileSystemRights.split(',').map((name) => name.trim())
    .some((name) => writeCapableRightNames.has(name));
}

export interface WindowsFileTrustPolicyOptions {
  readAcl: WindowsAclReader;
  currentUserSid: CurrentWindowsUserSidReader;
}

export function createWindowsFileTrustPolicy(options: WindowsFileTrustPolicyOptions): FileTrustPolicy {
  const { readAcl, currentUserSid } = options;

  async function isOwnedByCurrentUser(_stat: NodeJsStats, path: string): Promise<boolean> {
    const [acl, currentSid] = await Promise.all([readAcl(path), currentUserSid()]);
    if (acl === undefined || currentSid === null) return false;
    if (acl.ownerSid === currentSid) return true;
    // A directory the current process itself just created can still come back owned by
    // `S-1-5-32-544` (Administrators) rather than the process's own SID: Windows assigns
    // ownership of objects an administrator creates to the Administrators group by default,
    // and GitHub's `windows-latest` runners run exactly this way. A real CI run surfaced this
    // (D2) -- every unit fixture here had only ever asserted a *named user* owner, which this
    // never is on that host. The same trusted-principal carve-out `isWritableOnlyByOwner`
    // already applies to access rules belongs on ownership too, for the same reason `root`
    // is implicitly trusted by a POSIX mode check: a well-known SID is not a security gap.
    return windowsTrustedPrincipalSids.includes(acl.ownerSid);
  }

  /**
   * The two POSIX masks (`0o022`: no group/other *write*; `0o077`: no group/other access at all)
   * become two different questions here, matching the same distinction the code this port
   * replaces already drew: `0o077`'s stricter "no access at all" denies any `Allow` rule — read or
   * write — for a principal that is neither the owner nor trusted; `0o022`'s looser "no write"
   * only denies write-capable rules.
   */
  async function isWritableOnlyByOwner(
    _stat: NodeJsStats,
    path: string,
    mask: OwnerOnlyMask,
  ): Promise<boolean> {
    const [acl, currentSid] = await Promise.all([readAcl(path), currentUserSid()]);
    if (acl === undefined || currentSid === null) return false;
    const allowedSids = new Set([currentSid, ...windowsTrustedPrincipalSids]);
    return acl.accessRules
      .filter((rule) => rule.accessControlType === 'Allow')
      .filter((rule) => !allowedSids.has(rule.identitySid))
      .every((rule) => (mask === 0o022 ? !grantsWriteCapableAccess(rule) : false));
  }

  function isNotSharedByHardLink(stat: NodeJsStats): boolean {
    return stat.nlink === 1;
  }

  return {
    isOwnedByCurrentUser,
    isWritableOnlyByOwner,
    isNotSharedByHardLink,
    // A caller-facing "is identity available at all" check cannot itself be async without
    // changing the port's shape for every platform, so this answers it optimistically (Windows
    // always has *a* current-user SID) and lets `isOwnedByCurrentUser`/`isWritableOnlyByOwner`'s
    // own `currentSid === null` branch carry the real, per-call failure.
    currentIdentityAvailable: () => true,
  };
}
