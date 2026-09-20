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

/**
 * Whether two paths name the same location, as far as spelling can tell.
 *
 * `===` is not that test, and the difference is only visible on a host whose paths have more than
 * one legal spelling. `node:path`'s `relative` normalizes separators and applies the host's own
 * rule about case: on Windows `C:\p\repo`, `c:\p\repo` and `C:/p/repo` are one directory and
 * compare equal here, while on POSIX two spellings differing in case are two directories and do
 * not. Comparing the strings directly gets POSIX right by accident and Windows wrong every time —
 * `wtm forget C:\path\to\repo` could not match a stored repository root at all.
 *
 * What it deliberately is not is a `realpath`. A junction, an 8.3 short name and a symlink all
 * still compare unequal to their targets, because the callers here ask about registrations whose
 * directory may already be gone — which is the case `wtm forget` exists for — and a question that
 * needs the filesystem cannot be asked about a path that is no longer on it.
 */
export function samePath(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)) === '';
}
