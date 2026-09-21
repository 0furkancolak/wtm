/**
 * todo item 9: "the same `wtm.toml` works on all three operating systems, as far as it can".
 *
 * `scripts/__tests__/examples-portability.test.ts` already answers half of that question — it runs
 * every published example through the real schema and template resolver under a POSIX path flavor
 * and a Windows one, so a config whose *content* only works on one of them fails there. What it
 * does not check is the other half: the same configuration copied between machines does not arrive
 * as the same bytes. An editor writes a byte order mark; a checkout with `core.autocrlf` on, or an
 * editor that defaults to CRLF, changes every line ending. The text is the same configuration to
 * the person who wrote it, and the loader has to agree.
 *
 * These are fixture tests, and the labelling matters: the variants are constructed here as strings
 * rather than produced by a real editor on a real OS, so what they establish is that the loader
 * accepts the encodings those editors produce, not that any particular editor produces exactly
 * these bytes. That is the shape of evidence available without a second kernel, and it is the
 * right shape for this question, because the byte sequences involved (`U+FEFF`, `\r\n`) are fixed
 * by their specifications rather than by an OS.
 *
 * The last test in the file is different and says so: it runs against whichever host executes it,
 * so it is native evidence on every CI leg, and the win32 leg is what makes it Windows evidence.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { parse } from 'smol-toml';
import { resolveWorkspaceConfig } from '../load';
import { collectProvenance } from '../provenance';
import { parseWtmConfig, type WtmConfig } from '../schema';
import { stripByteOrderMark } from '../toml-text';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/**
 * One configuration exercising the kinds of value whose parse could plausibly be sensitive to line
 * endings or to a leading marker: a table header, a bare assignment, an inline array, a nested
 * table, and a quoted value containing the separator characters themselves.
 *
 * It deliberately contains no multi-line basic string. A line ending *inside* one is part of the
 * value rather than a separator, so it does not survive the trip between machines unchanged — the
 * last test in this block states that exception and pins it, rather than hiding it inside a shared
 * fixture that would then have to claim something untrue.
 */
const configurationLf = [
  'version = 1',
  '',
  '[workspace]',
  'name = "portable"',
  '',
  '[ports]',
  'range = "20000-50000"',
  '',
  '[ports.web]',
  'preferred = 4000',
  'env = "PORT"',
  '',
  '[tasks.dev]',
  'run = ["bun", "run", "dev"]',
  'cwd = "{worktree.root}"',
  '',
  '[tasks.dev.env]',
  'BANNER = "first second"',
  '',
].join('\n');

const byteOrderMark = '\uFEFF';

/** The same configuration as a machine with CRLF line endings stores it. */
const configurationCrlf = configurationLf.replace(/\n/gu, '\r\n');

/**
 * Every encoding of the one configuration, named. `bom` is an editor that writes the UTF-8 byte
 * order mark; `bom+crlf` is the combination, which is what an editor that does both produces and
 * is therefore the variant most likely to reach WTM in practice.
 */
const encodings = {
  lf: configurationLf,
  crlf: configurationCrlf,
  bom: `${byteOrderMark}${configurationLf}`,
  'bom+crlf': `${byteOrderMark}${configurationCrlf}`,
} as const;

/**
 * What the configuration means, written out rather than derived from one of the variants.
 *
 * Comparing the variants against each other would pass if every one of them were wrong in the same
 * way, which is exactly the failure a "they all agree" test cannot see. Spelling the value here is
 * what makes agreement mean *correct* rather than merely consistent.
 */
const expected: WtmConfig = {
  version: 1,
  workspace: { name: 'portable' },
  ports: { range: '20000-50000', web: { preferred: 4000, env: 'PORT' } },
  tasks: { dev: { run: ['bun', 'run', 'dev'], cwd: '{worktree.root}', env: { BANNER: 'first second' } } },
};

/**
 * The document as every command that reads one from disk hands it to the parser.
 *
 * Named rather than inlined so these tests cannot drift into testing a private arrangement of
 * their own: this is the exact composition `loadConfigFile`, `wtm init`, `wtm detect` and
 * `wtm changes` each perform.
 */
function parseDocument(text: string, source: string) {
  return parseWtmConfig(parse(stripByteOrderMark(text)), source);
}

describe('a wtm.toml survives the encodings different machines write it in', () => {
  for (const [name, text] of Object.entries(encodings)) {
    test(`parses to the same configuration from ${name}`, () => {
      expect(parseDocument(text, 'wtm.toml')).toEqual(expected);
    });
  }

  test('reports the same provenance line for a value however the file is encoded', () => {
    // `wtm explain` cites `source:line` at a contributor who is looking at the file in an editor.
    // A byte order mark or a CRLF that shifted the count by one would make every citation in a
    // Windows-authored file point at the line above the one it means.
    for (const [name, text] of Object.entries(encodings)) {
      const document = stripByteOrderMark(text);
      const provenance = collectProvenance(parseDocument(text, 'wtm.toml'), 'wtm.toml', document);

      expect(provenance.get('workspace.name'), name).toEqual({ source: 'wtm.toml', line: 4 });
      expect(provenance.get('ports.web.preferred'), name).toEqual({ source: 'wtm.toml', line: 10 });
      expect(provenance.get('tasks.dev.cwd'), name).toEqual({ source: 'wtm.toml', line: 15 });
    }
  });

  test('loads from disk to the same resolved value however the file is encoded', async () => {
    // Through the real loader this time, not `parse` directly: the byte order mark arrives with
    // the file, so stripping it has to happen on the read path where a file is what is being
    // parsed. A unit test of `parse` alone would pass against a loader that never handled it.
    for (const [name, text] of Object.entries(encodings)) {
      const root = await mkdtemp(join(tmpdir(), 'wtm-config-encoding-'));
      directories.push(root);
      const workspaceRoot = join(root, 'workspace');
      await mkdir(workspaceRoot, { recursive: true });
      await writeFile(join(workspaceRoot, 'wtm.toml'), text);

      const resolved = await resolveWorkspaceConfig({
        workspaceRoot,
        globalConfigPath: join(root, 'absent-global.toml'),
      });

      expect(resolved.value.workspace?.name, name).toBe('portable');
      expect(resolved.value.ports?.web?.preferred, name).toBe(4000);
      expect(resolved.value.tasks?.dev?.env?.BANNER, name).toBe('first second');
      expect(resolved.provenance.get('workspace.name'), name)
        .toEqual({ source: join(workspaceRoot, 'wtm.toml'), line: 4 });
    }
  });

  test('a line ending inside a multi-line string is a value, and does travel with the file', () => {
    // The one documented limit on "the same `wtm.toml` works everywhere", pinned so it is a known
    // property rather than a surprise. Outside a quoted value a line ending is a separator and the
    // tests above prove it makes no difference. Inside a multi-line basic string it is a
    // character, TOML 1.0.0 keeps it ("all other whitespace and newline characters remain
    // intact"), and so a configuration whose value spans lines carries whichever ending its author
    // saved into, for example, an environment variable a task will read.
    //
    // It is not normalized here on purpose: a loader that rewrote the bytes inside a quoted value
    // would be changing what the configuration says in order to make two files match, which is the
    // same trade the CLI refuses when it declines to emit a `plistPath` naming something that is
    // not a plist. A configuration that needs one exact ending should say so with an escape
    // (`\n`), which is unambiguous on every platform.
    const multiLine = 'BANNER = """\nfirst\nsecond"""\n';

    expect(parse(multiLine)).toEqual({ BANNER: 'first\nsecond' });
    expect(parse(multiLine.replace(/\n/gu, '\r\n'))).toEqual({ BANNER: 'first\r\nsecond' });
    // The escape is the portable spelling, and it is identical from both encodings.
    const escaped = 'BANNER = "first\\nsecond"\n';
    expect(parse(escaped)).toEqual({ BANNER: 'first\nsecond' });
    expect(parse(escaped.replace(/\n/gu, '\r\n'))).toEqual({ BANNER: 'first\nsecond' });
  });

  test('a byte order mark in the middle of a file is still a syntax error', async () => {
    // The strip is a leading-marker rule, not a "delete every U+FEFF" rule. A marker anywhere else
    // is a character inside the document and TOML has no business accepting it there — removing it
    // silently would change what a configuration says in order to make it load.
    const root = await mkdtemp(join(tmpdir(), 'wtm-config-encoding-'));
    directories.push(root);
    const workspaceRoot = join(root, 'workspace');
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(workspaceRoot, 'wtm.toml'), `version = 1\n${byteOrderMark}[workspace]\nname = "x"\n`);

    await expect(resolveWorkspaceConfig({
      workspaceRoot,
      globalConfigPath: join(root, 'absent-global.toml'),
    })).rejects.toMatchObject({ code: 'WTM_CONFIG_INVALID' });
  });
});

describe('config discovery on this host', () => {
  /**
   * Native evidence, not fixture evidence: this builds its paths with the host's own `node:path`
   * and reads them back through the real loader, so it measures whatever OS is running it. On the
   * win32 CI leg it is a statement about `C:\...\wtm.toml` and backslash separators; here it is a
   * statement about POSIX ones. It is in this file because the layering it pins — global, then
   * workspace, then each directory between the workspace and the repository, then the repository —
   * is the part of "the same `wtm.toml` works everywhere" that depends on path handling rather
   * than on encoding, and `nestedConfigPaths` walks the host's separator to produce it.
   */
  test('layers a nested workspace in the same order whatever the host separator is', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-config-nested-'));
    directories.push(root);
    const workspaceRoot = join(root, 'workspace');
    const repoRoot = join(workspaceRoot, 'apps', 'api');
    const globalConfigPath = join(root, 'global.toml');
    await mkdir(repoRoot, { recursive: true });
    await writeFile(globalConfigPath, '[ports.web]\npreferred = 3000\n[workspace]\nname = "from-global"\n');
    await writeFile(join(workspaceRoot, 'wtm.toml'), '[ports.web]\npreferred = 4000\n');
    await writeFile(join(workspaceRoot, 'apps', 'wtm.toml'), '[ports.web]\npreferred = 5000\n');
    await writeFile(join(repoRoot, '.wtm.toml'), '[ports.web]\npreferred = 6000\n');

    const resolved = await resolveWorkspaceConfig({ workspaceRoot, repoRoot, globalConfigPath });

    expect(resolved.value.ports?.web?.preferred).toBe(6000);
    // The layer that nothing overrode still comes through, which is what proves the earlier
    // layers were read rather than merely not crashed on.
    expect(resolved.value.workspace?.name).toBe('from-global');
    expect(resolved.provenance.get('ports.web.preferred')?.source).toBe(join(repoRoot, '.wtm.toml'));
    // Spelled against the host's own separator: the point is that the source is the path this OS
    // names, not that it is a POSIX one.
    expect(resolved.provenance.get('ports.web.preferred')?.source).toContain(`apps${sep}api`);
  });
});
