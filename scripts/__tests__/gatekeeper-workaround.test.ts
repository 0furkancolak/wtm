import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The macOS quarantine workaround is advice to strip a security attribute, so it must not outlive
 * the defect it works around. Increment G (notarization, `todo.md` item 5) deletes it, and this
 * file is what makes an incomplete deletion fail instead of leaving stale advice behind.
 *
 * The passage is written once between the two markers below and reproduced in every document in
 * `carrierDocuments`. `.github/workflows/release.yml` publishes the GitHub Release body with
 * `--notes-file CHANGELOG.md`, so the changelog is the release notes — the README and the release
 * body are two renderings of one source, not two documents to keep in sync by hand.
 *
 * Three failures are covered, and every one of them is a half-removal:
 *
 * - the passage removed from one carrier and left in another (`in every document, or in none`);
 * - a marker removed while its prose stays (`outside a marked region`, which finds the orphan);
 * - the passage edited until it no longer names the command a reader has to run (`states`).
 *
 * Removing it from *every* carrier is green on purpose: that is the state Increment G is aiming
 * for, and this file should be deleted in the same change that reaches it.
 */
const startMarker = '<!-- gatekeeper-quarantine:start -->';
const endMarker = '<!-- gatekeeper-quarantine:end -->';

/** Every document that must carry the passage. All of them, or none. */
const carrierDocuments = ['README.md', 'CHANGELOG.md'];

/**
 * What a reader must still find after any edit to the prose. The command is exact because it is
 * the thing the reader types; the rest are the claims that make the advice safe to follow — why
 * the binary dies with no output at all, and why the documented `curl` path does not need this.
 */
const requiredCommand = 'xattr -d com.apple.quarantine wtm';
const requiredClaims = [requiredCommand, 'SIGKILL', 'before any WTM code runs', 'curl'];

/**
 * Words that mean the passage, wherever they appear. An occurrence outside a marked region of a
 * carrier is either a copy that the removal would miss or prose whose markers were deleted from
 * under it.
 */
const passageTerms = ['com.apple.quarantine', 'xattr'];

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('the macOS quarantine workaround', () => {
  test('is delimited by exactly one marked region per document', () => {
    const counts = Object.fromEntries(carrierDocuments.map((document) => {
      const source = read(document);
      return [document, [occurrences(source, startMarker).length, occurrences(source, endMarker).length]];
    }));
    for (const [document, [starts, ends]] of Object.entries(counts)) {
      expect(starts, `${document}: unbalanced or repeated markers (${starts} start, ${ends} end)`).toBe(ends);
      expect(starts <= 1, `${document}: ${starts} marked regions, expected at most one`).toBe(true);
    }
  });

  test('is present in every release-facing document, or in none', () => {
    const carrying = carrierDocuments.filter((document) => region(document) !== null);
    // Not `toEqual(carrierDocuments)`: zero carriers is the retired state, and is allowed.
    if (carrying.length === 0) return;
    expect(carrying, 'the workaround was removed from some documents but not others').toEqual(carrierDocuments);
  });

  test('states the cause, the command, and why the curl path is unaffected', () => {
    for (const document of carrierDocuments) {
      const body = region(document);
      if (body === null) continue;
      for (const claim of requiredClaims) {
        expect(body.includes(claim), `${document}: the marked region no longer states ${JSON.stringify(claim)}`)
          .toBe(true);
      }
    }
  });

  test('is never mentioned outside a marked region', () => {
    const regions = new Map(carrierDocuments.map((document) => [document, boundaries(document)]));
    const orphans: string[] = [];
    for (const document of scannedDocuments()) {
      const source = read(document);
      const marked = regions.get(document) ?? null;
      for (const term of passageTerms) {
        for (const index of occurrences(source, term)) {
          if (marked !== null && index > marked.start && index < marked.end) continue;
          orphans.push(`${document}:${line(source, index)} ${term}`);
        }
      }
    }
    expect(orphans, 'the workaround is documented outside the region the removal deletes').toEqual([]);
  });
});

function read(document: string): string {
  return readFileSync(join(repositoryRoot, document), 'utf8');
}

/** Every user-facing document. Planning records are excluded: they record the work, not the advice. */
function scannedDocuments(): string[] {
  const documents = [...carrierDocuments];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(join(repositoryRoot, directory), { withFileTypes: true })) {
      // `docs/superpowers` is this project's own spec and plan ledger, and `todo.md` is its
      // backlog; both name the workaround as work to do, which is not advice to a user.
      if (entry.name === 'superpowers') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.md')) documents.push(path);
    }
  };
  walk('docs');
  return documents;
}

function boundaries(document: string): { start: number; end: number } | null {
  const source = read(document);
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) return null;
  return { start, end: end + endMarker.length };
}

function region(document: string): string | null {
  const marked = boundaries(document);
  if (marked === null) return null;
  return read(document).slice(marked.start, marked.end);
}

function occurrences(source: string, needle: string): number[] {
  const found: number[] = [];
  for (let index = source.indexOf(needle); index !== -1; index = source.indexOf(needle, index + 1)) {
    found.push(index);
  }
  return found;
}

function line(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}
