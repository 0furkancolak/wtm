import { sep } from 'node:path';

export interface GitWorktreeRecord {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  lockedReason: string | null;
  prunableReason: string | null;
}

const decoder = new TextDecoder();

/**
 * Git's own plumbing commands (`worktree list --porcelain`, `rev-parse --show-toplevel`,
 * `rev-parse --git-common-dir`, ...) always print paths with forward slashes on stdout, even on
 * Windows, regardless of what separator the host filesystem actually uses. Node's own path
 * construction (`path.join`, `mkdtemp`, `path.resolve`, ...) uses backslashes there. Anywhere a
 * path captured from git's stdout is later compared (`===`, `toEqual`) against or joined with a
 * Node-native path, that mismatch is silent — so every such path is normalized once, here at the
 * point it is parsed out of git's output, rather than patched at each downstream comparison site.
 *
 * A no-op on darwin/linux by construction: `sep` is already `/` there, so the branch that does the
 * replacement never runs and the string is returned unchanged.
 */
export function toNativeGitPath(path: string): string {
  return sep === '/' ? path : path.replaceAll('/', sep);
}

export function parseGitWorktreePorcelain(output: Uint8Array): GitWorktreeRecord[] {
  const records: GitWorktreeRecord[] = [];
  let current: GitWorktreeRecord | null = null;
  let fieldStart = 0;

  const finishRecord = () => {
    if (current !== null) {
      records.push(current);
      current = null;
    }
  };

  const parseField = (field: Uint8Array) => {
    if (field.length === 0) {
      finishRecord();
      return;
    }

    const line = decoder.decode(field);
    const separator = line.indexOf(' ');
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1);

    if (key === 'worktree') {
      finishRecord();
      current = {
        path: toNativeGitPath(value),
        head: null,
        branch: null,
        detached: false,
        bare: false,
        lockedReason: null,
        prunableReason: null,
      };
      return;
    }

    if (current === null) return;

    switch (key) {
      case 'HEAD':
        current.head = value;
        break;
      case 'branch':
        current.branch = value;
        break;
      case 'detached':
        current.detached = true;
        break;
      case 'bare':
        current.bare = true;
        break;
      case 'locked':
        current.lockedReason = value;
        break;
      case 'prunable':
        current.prunableReason = value;
        break;
    }
  };

  for (let index = 0; index < output.length; index += 1) {
    if (output[index] === 0) {
      parseField(output.subarray(fieldStart, index));
      fieldStart = index + 1;
    }
  }

  if (fieldStart < output.length) parseField(output.subarray(fieldStart));
  finishRecord();
  return records;
}
