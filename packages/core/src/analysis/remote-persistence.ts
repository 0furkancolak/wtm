import { runGit } from '../git/git-runner';

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

export function parseNulFormattedRefs(output: Uint8Array): string[] {
  return new TextDecoder()
    .decode(output)
    .split('\0')
    .map((field) => field.replace(/^\n+|\n+$/gu, ''))
    .filter((field) => field.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function normalizeAllowedRemoteRefs(patterns: readonly string[]): string[] {
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
