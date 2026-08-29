import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Release archives are named by the build, so the formula and the pipeline share one source. */
export const formulaArchiveNames = {
  arm64: 'wtm-darwin-arm64.tar.gz',
  x64: 'wtm-darwin-x64.tar.gz',
} as const;

export interface HomebrewFormulaInput {
  version: string;
  arm64Sha256: string;
  x64Sha256: string;
}

const root = resolve(fileURLToPath(import.meta.url), '../..');
const templatePath = join(root, 'packaging/homebrew/wtm.rb.template');
const formulaPath = join(root, 'artifacts/formula/wtm.rb');
const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const sha256 = /^[0-9a-f]{64}$/;

export function renderHomebrewFormula(input: HomebrewFormulaInput): string {
  const version = input?.version ?? '';
  if (!semver.test(version)) throw new Error(`version ${JSON.stringify(version)} is not valid SemVer`);
  const substitutions: Readonly<Record<string, string>> = {
    VERSION: version,
    ARM64_ARCHIVE: formulaArchiveNames.arm64,
    X64_ARCHIVE: formulaArchiveNames.x64,
    ARM64_SHA256: digest(input, 'arm64Sha256'),
    X64_SHA256: digest(input, 'x64Sha256'),
  };
  const rendered = readFileSync(templatePath, 'utf8')
    .replaceAll(/\{\{([A-Z0-9_]+)\}\}/g, (placeholder, name: string) => substitutions[name] ?? placeholder);
  const leftover = /\{\{[A-Z0-9_]+\}\}/.exec(rendered);
  if (leftover !== null) throw new Error(`formula template has an unknown placeholder ${leftover[0]}`);
  return rendered;
}

export function resolveFormulaInput(
  args: readonly string[],
  readFile: (path: string) => string,
): HomebrewFormulaInput {
  const [version, second, third] = args;
  if (version === undefined) throw new Error(usage);
  if (second === '--checksums') {
    if (third === undefined) throw new Error(usage);
    return { version, ...readChecksumDigests(readFile(third)) };
  }
  if (second === undefined || third === undefined) throw new Error(usage);
  return { version, arm64Sha256: second, x64Sha256: third };
}

export function readChecksumDigests(document: string): { arm64Sha256: string; x64Sha256: string } {
  const digests = new Map<string, string>();
  for (const line of document.split('\n')) {
    const entry = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (entry !== null) digests.set(entry[2] as string, entry[1] as string);
  }
  return {
    arm64Sha256: required(digests, formulaArchiveNames.arm64),
    x64Sha256: required(digests, formulaArchiveNames.x64),
  };
}

const usage = 'usage: render-homebrew-formula <version> (<arm64-sha256> <x64-sha256> | --checksums <path>)';

function digest(input: HomebrewFormulaInput, field: 'arm64Sha256' | 'x64Sha256'): string {
  const value = input?.[field] ?? '';
  if (!sha256.test(value)) {
    throw new Error(`${field} ${JSON.stringify(value)} is not 64 lowercase hexadecimal characters`);
  }
  return value;
}

function required(digests: ReadonlyMap<string, string>, name: string): string {
  const value = digests.get(name);
  if (value === undefined) throw new Error(`checksum document has no entry for ${name}`);
  return value;
}

if (import.meta.main) {
  const formula = renderHomebrewFormula(
    resolveFormulaInput(process.argv.slice(2), (path) => readFileSync(path, 'utf8')),
  );
  mkdirSync(dirname(formulaPath), { recursive: true, mode: 0o700 });
  writeFileSync(formulaPath, formula, { mode: 0o600 });
  process.stdout.write(`${formulaPath}\n`);
}
