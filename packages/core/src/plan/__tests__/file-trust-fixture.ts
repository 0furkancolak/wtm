import { defaultCoreFileTrustPolicy, type FileTrustPolicy } from '../../file-trust-policy';

/**
 * A host-independent stand-in for `FileTrustPolicy`, shared by the adapter-trust and
 * external-adapter tests in this directory (plus `descriptor-audit.scenario.ts`, which exercises
 * the same call paths from a spawned child process).
 *
 * None of these tests are about `FileTrustPolicy`'s own ownership/permission/hard-link decisions —
 * that is `file-trust-policy.ts` and the platform package's own test surface. What these tests
 * exercise is the adapter *trust store* (exact canonical-path/sha256 matching), the V1 declaration
 * format, and the external-adapter protocol/timeout/descriptor plumbing. Every executable and
 * private execution copy involved is a temp file this same test process just wrote, so "yes, this
 * is mine, yes, it's safe" is the only correct answer these tests actually mean to give.
 *
 * Before this fixture existed, these call sites relied on `adapter-trust.ts`'s own default
 * (`defaultCoreFileTrustPolicy`), which answers from the current POSIX user id — unavailable on
 * Windows, which turned every one of these into a false "not owned by the current user" rejection
 * unrelated to what the test actually meant to check.
 *
 * This is deliberately not a blanket "answer yes to everything" stub: `openTrustedAdapterDescriptor`
 * threads the same policy into `createAnonymousTrustedAdapter`'s private execution directory, whose
 * `ensurePrivateDirectory` walks every real lexical component from the filesystem root looking for
 * symlinks — and on macOS, `os.tmpdir()` sits below `/var`, a root-owned symlink to `/private/var`.
 * A policy that claims ownership of *everything* claims ownership of `/var` too, which trips the
 * exact protection `assertNoSymlinkComponents` exists to enforce (a symlink the current user
 * appears to own is refused outright). So this delegates to the real POSIX answer wherever the host
 * can give one — correct for `/var` and correct for the directories these tests actually create —
 * and only substitutes "trust it" in the one case that real answer cannot be trusted at all: no
 * identity available, `defaultCoreFileTrustPolicy`'s Windows failure mode. That substitution can
 * only ever make this fixture *more* permissive than the real POSIX policy already is on this host,
 * never less, and it never inspects the current POSIX user id or a raw file mode/owner field itself.
 */
export function trustedFileTrustPolicy(): FileTrustPolicy {
  return {
    isOwnedByCurrentUser: async (stat, path) => (defaultCoreFileTrustPolicy.currentIdentityAvailable()
      ? defaultCoreFileTrustPolicy.isOwnedByCurrentUser(stat, path)
      : true),
    isWritableOnlyByOwner: async (stat, path, mask) => (defaultCoreFileTrustPolicy.currentIdentityAvailable()
      ? defaultCoreFileTrustPolicy.isWritableOnlyByOwner(stat, path, mask)
      : true),
    isNotSharedByHardLink: () => true,
    currentIdentityAvailable: () => true,
  };
}
