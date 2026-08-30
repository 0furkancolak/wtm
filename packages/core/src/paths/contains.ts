import { relative, resolve, sep } from 'node:path';

/**
 * Whether `candidate` is `root` itself or a directory inside it.
 *
 * Three copies of this test existed, and one of them compared by slicing `candidate` at
 * `root.length` without checking that the prefix matched. Every candidate shorter than the
 * root then sliced to the empty string and was reported as contained — so a numeric worktree
 * selector could resolve to a worktree in an unrelated project, which `wtm remove` would then
 * have acted on.
 */
export function containsPath(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..');
}
