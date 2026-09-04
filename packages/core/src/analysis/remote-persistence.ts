import { remoteFetchTimeoutMs, runGit } from '../git/git-runner';

export const defaultAllowedRemoteRefs = Object.freeze(['refs/remotes/origin/*'] as const);

export interface RemotePersistenceAnalysis {
  allowedRemoteRefs: string[];
  matchingRefs: string[];
  containingRefs: string[];
  persisted: boolean;
}

export async function analyzeRemotePersistence(
  repoPath: string,
  headOid: string,
  allowedRemoteRefs: readonly string[] = defaultAllowedRemoteRefs,
): Promise<RemotePersistenceAnalysis> {
  const patterns = normalizeAllowedRemoteRefs(allowedRemoteRefs);
  const result = await runGit(repoPath, [
    'for-each-ref',
    '--format=%(refname)%00',
    'refs/remotes',
  ]);
  const matchingRefs = parseNulFormattedRefs(result.stdout).filter((ref) =>
    patterns.some((pattern) => matchesRefPattern(ref, pattern))
  );
  const containingRefs: string[] = [];

  for (const ref of matchingRefs) {
    const containment = await runGit(repoPath, [
      'merge-base', '--is-ancestor', headOid, ref,
    ], { acceptedExitCodes: [0, 1] });
    if (containment.exitCode === 0) containingRefs.push(ref);
  }

  return {
    allowedRemoteRefs: patterns,
    matchingRefs,
    containingRefs,
    persisted: containingRefs.length > 0,
  };
}

export interface RemoteRefreshResult {
  remotes: string[];
  refreshedAt: string;
}

/**
 * Brings the remote-tracking refs the allowed patterns name up to date, and reports what it
 * fetched so the caller can record how fresh its evidence is.
 *
 * This is the only network-touching function in analysis, and nothing calls it implicitly:
 * `analyzeWorktree` reads local refs and never fetches, so a caller that wants fresh knowledge
 * asks for it here first and hands the result forward. That split is what keeps
 * `docs/14-testing-performance-security.md`'s rule — network-affecting Git commands are explicit
 * — true of every analysis path.
 *
 * It fails closed: a fetch that fails propagates its `GitCommandError` rather than
 * returning a result over stale refs, because reporting refreshed knowledge the repository does
 * not have is exactly the outcome the caller asked to avoid.
 */
export async function refreshRemoteTrackingRefs(
  repoPath: string,
  allowedRemoteRefs: readonly string[] = defaultAllowedRemoteRefs,
): Promise<RemoteRefreshResult> {
  assertRepositoryPath(repoPath);
  const selectors = deriveRemoteSelectors(normalizeAllowedRemoteRefs(allowedRemoteRefs));
  const remotes = (await readConfiguredRemotes(repoPath))
    .filter((remote) => selectors.some((selector) => selector(remote)));

  for (const remote of remotes) {
    // `--prune` is the whole point. Without it a branch deleted on the remote leaves its
    // remote-tracking ref in place, `analyzeRemotePersistence` still finds HEAD reachable from
    // an allowed ref, and a refresh that changed nothing reports REFRESHED confidence over
    // knowledge that is exactly as stale as before.
    await runGit(repoPath, ['fetch', '--prune', '--quiet', '--', remote], {
      timeoutMs: remoteFetchTimeoutMs,
    });
  }

  return { remotes, refreshedAt: new Date().toISOString() };
}

export function parseNulFormattedRefs(output: Uint8Array): string[] {
  return new TextDecoder()
    .decode(output)
    .split('\0')
    .map((field) => field.replace(/^\n+|\n+$/gu, ''))
    .filter((field) => field.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * The shape an allowed-remote-ref pattern must have: a `refs/remotes/` ref, with at most a
 * single trailing wildcard. Exported so the `wtm.toml` config schema rejects a malformed pattern
 * at load time with the same rule this module enforces at analysis time — one definition of
 * "valid", not two that can drift apart.
 */
export function normalizeAllowedRemoteRefs(patterns: readonly string[]): string[] {
  const unique = [...new Set(patterns)];
  if (unique.length === 0) throw new TypeError('At least one allowed remote-tracking ref is required');
  for (const pattern of unique) {
    if (!pattern.startsWith('refs/remotes/') || pattern.includes('\0') || pattern.includes('\n')) {
      throw new TypeError(`Invalid allowed remote-tracking ref: ${pattern}`);
    }
    const wildcardIndex = pattern.indexOf('*');
    if (wildcardIndex !== -1 && wildcardIndex !== pattern.length - 1) {
      throw new TypeError(`Allowed remote-tracking ref wildcards must be trailing: ${pattern}`);
    }
  }
  return unique.sort((left, right) => left.localeCompare(right));
}

function matchesRefPattern(ref: string, pattern: string): boolean {
  return pattern.endsWith('*') ? ref.startsWith(pattern.slice(0, -1)) : ref === pattern;
}

/**
 * Turns `refs/remotes/<name>/...` patterns into predicates over configured remote names. A
 * pattern whose remote segment is itself a wildcard — `refs/remotes/*` — selects every remote
 * the repository has configured.
 */
function deriveRemoteSelectors(patterns: readonly string[]): ((remote: string) => boolean)[] {
  return patterns.map((pattern) => {
    const rest = pattern.slice('refs/remotes/'.length);
    const separator = rest.indexOf('/');
    const segment = separator === -1 ? rest : rest.slice(0, separator);
    if (segment.endsWith('*')) {
      const prefix = segment.slice(0, -1);
      assertRemoteNameFragment(prefix, pattern, true);
      return (remote: string) => remote.startsWith(prefix);
    }
    assertRemoteNameFragment(segment, pattern, false);
    return (remote: string) => remote === segment;
  });
}

/**
 * The set to intersect the patterns with. Reading it is what keeps a pattern naming a remote
 * this repository does not have from becoming a failing `git fetch upstream` — or, worse, an
 * argument-less `git fetch` that quietly goes to the default remote instead of the named one.
 */
async function readConfiguredRemotes(repoPath: string): Promise<string[]> {
  const result = await runGit(repoPath, ['remote']);
  const names = result.stdout
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const name of names) assertRemoteNameFragment(name, 'git remote', false);
  return [...new Set(names)].sort((left, right) => left.localeCompare(right));
}

/**
 * A remote name reaches `git` as a bare argument, so one that begins with `-` would be read as
 * an option. Rejecting it here — before anything is spawned — is cheaper than reasoning about
 * what `git fetch --prune -- --upload-pack=…` would do.
 */
function assertRemoteNameFragment(value: string, source: string, allowEmpty: boolean): void {
  const invalid = (!allowEmpty && value.length === 0)
    || value.startsWith('-')
    || value.includes('/')
    || value.includes('\0')
    || value.includes('\n');
  if (invalid) throw new TypeError(`Invalid remote name "${value}" from ${source}`);
}

function assertRepositoryPath(repoPath: string): void {
  const invalid = repoPath.length === 0
    || repoPath.startsWith('-')
    || repoPath.includes('\0')
    || repoPath.includes('\n');
  if (invalid) throw new TypeError(`Invalid repository path: ${repoPath}`);
}
