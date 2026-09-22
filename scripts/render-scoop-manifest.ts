import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The release archive is named by the build, so the manifest and the pipeline share one source. */
export const manifestArchiveName = 'wtm-windows-x64.zip';

export interface ScoopManifestInput {
  version: string;
  x64Sha256: string;
}

const root = resolve(fileURLToPath(import.meta.url), '../..');
const templatePath = join(root, 'packaging/scoop/wtm.json.template');
const manifestPath = join(root, 'artifacts/scoop/wtm.json');
const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const sha256 = /^[0-9a-f]{64}$/;

export function renderScoopManifest(input: ScoopManifestInput): string {
  const version = input?.version ?? '';
  if (!semver.test(version)) throw new Error(`version ${JSON.stringify(version)} is not valid SemVer`);
  const substitutions: Readonly<Record<string, string>> = {
    VERSION: version,
    ARCHIVE: manifestArchiveName,
    X64_SHA256: digest(input),
  };
  // Same normalization as `render-homebrew-formula.ts`: the template is a checked-out git file,
  // and without a repository-wide `.gitattributes` pinning line endings, a host whose git converts
  // on checkout hands this `\r\n`. The rendered manifest is a build artifact, not a copy of
  // whatever bytes checkout happened to produce.
  const rendered = readFileSync(templatePath, 'utf8')
    .replace(/\r\n/g, '\n')
    .replaceAll(/\{\{([A-Z0-9_]+)\}\}/g, (placeholder, name: string) => substitutions[name] ?? placeholder);
  const leftover = /\{\{[A-Z0-9_]+\}\}/.exec(rendered);
  if (leftover !== null) throw new Error(`manifest template has an unknown placeholder ${leftover[0]}`);
  // A Scoop manifest is JSON; a template that renders to invalid JSON is caught here rather than
  // by whatever installs it later.
  JSON.parse(rendered);
  return rendered;
}

export function resolveManifestInput(
  args: readonly string[],
  readFile: (path: string) => string,
): ScoopManifestInput {
  const [version, second, third] = args;
  if (version === undefined) throw new Error(usage);
  if (second === '--checksums') {
    if (third === undefined) throw new Error(usage);
    return { version, ...readChecksumDigest(readFile(third)) };
  }
  if (second === undefined) throw new Error(usage);
  return { version, x64Sha256: second };
}

export function readChecksumDigest(document: string): { x64Sha256: string } {
  const digests = new Map<string, string>();
  for (const line of document.split('\n')) {
    const entry = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (entry !== null) digests.set(entry[2] as string, entry[1] as string);
  }
  const value = digests.get(manifestArchiveName);
  if (value === undefined) throw new Error(`checksum document has no entry for ${manifestArchiveName}`);
  return { x64Sha256: value };
}

const usage = 'usage: render-scoop-manifest <version> (<x64-sha256> | --checksums <path>)';

function digest(input: ScoopManifestInput): string {
  const value = input?.x64Sha256 ?? '';
  if (!sha256.test(value)) {
    throw new Error(`x64Sha256 ${JSON.stringify(value)} is not 64 lowercase hexadecimal characters`);
  }
  return value;
}

if (import.meta.main) {
  const manifest = renderScoopManifest(
    resolveManifestInput(process.argv.slice(2), (path) => readFileSync(path, 'utf8')),
  );
  mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
  writeFileSync(manifestPath, manifest, { mode: 0o600 });
  process.stdout.write(`${manifestPath}\n`);
}
