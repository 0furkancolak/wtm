import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { join as joinPosix } from 'node:path/posix';
import { corsVariablePattern } from '../runtime/cors';
import { readComposeFile, type ComposeService } from './compose';
import { readEnvDeclarations, type EnvDeclaration } from './declarations';

/** Where a detected fact was read from, named the way the repository names it. */
export interface DetectionEvidence {
  /** The file, relative to the workspace root, so a report never carries a home directory. */
  file: string;
  detail: string;
}

export interface DetectedPort {
  /** The variable the service reads its port from, when it declares one. */
  env: string | null;
  /** The port the repository asks for, which becomes the first port WTM tries. */
  preferred: number | null;
  evidence: DetectionEvidence[];
}

export type DetectionConfidence = 'high' | 'medium';

export interface DetectedLink {
  /** The variable holding the address of another service. */
  variable: string;
  /** The service it addresses. */
  target: string;
  /** The address rewritten against that service's endpoint, ready for `[environment]`. */
  template: string;
  confidence: DetectionConfidence;
  evidence: DetectionEvidence;
}

export interface DetectedService {
  /** The name its endpoint is configured under: `[ports.<name>]`, `{port.<name>}`. */
  name: string;
  /** The repository root, relative to the workspace root. */
  path: string;
  root: string;
  port: DetectedPort | null;
  /** The variables this service publishes its CORS allowlist under. */
  cors: string[];
  links: DetectedLink[];
  /** What detection saw but deliberately did not act on. */
  notes: string[];
}

export interface WorkspaceDetection {
  root: string;
  services: DetectedService[];
}

export interface DetectionRepository {
  /** The repository's main working tree. */
  root: string;
}

export interface DetectWorkspaceInput {
  root: string;
  repositories: readonly DetectionRepository[];
}

/** `PORT`, and the prefixed spellings — `API_PORT`, `SERVER_PORT`, `NEXT_PUBLIC_PORT`. */
const portVariablePattern = /^(?:([A-Z0-9]+(?:_[A-Z0-9]+)*)_)?PORT$/;
/** Variables that hold an address rather than a secret: `API_URL`, `NEXT_PUBLIC_API_BASE_URL`. */
const addressVariablePattern = /_(?:URL|URI|ORIGIN|ENDPOINT|HOST|ADDR|ADDRESS)$/;
const loopbackHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);
/** The host name a browser is given, which is not the address a server binds to. */
const publishedHost = 'localhost';

/**
 * Reads every repository in the workspace and works out what WTM would have to be told about
 * it: which port it wants, what it publishes that port under, where it expects a CORS
 * allowlist, and which of its variables point at another repository in the same workspace.
 *
 * The result is a proposal, not a decision. It exists to be written into `wtm.toml`, where a
 * person can read it, disagree with it, and change it — detection that stays inside the
 * program is detection nobody can correct.
 */
export async function detectWorkspaceServices(input: DetectWorkspaceInput): Promise<WorkspaceDetection> {
  const drafts = await Promise.all(input.repositories.map((repository) => readRepository(input.root, repository)));
  const named = nameServices(drafts);
  const services = named.map((draft) => ({
    name: draft.name,
    path: draft.path,
    root: draft.root,
    port: draft.port,
    cors: draft.cors,
    links: resolveLinks(draft, named),
    notes: draft.notes,
  }));
  return { root: input.root, services };
}

interface RepositoryDraft {
  name: string;
  path: string;
  root: string;
  port: DetectedPort | null;
  cors: string[];
  candidates: LinkCandidate[];
  composeServices: string[];
  notes: string[];
}

interface LinkCandidate {
  variable: string;
  url: string;
  evidence: DetectionEvidence;
}

async function readRepository(workspaceRoot: string, repository: DetectionRepository): Promise<RepositoryDraft> {
  const root = repository.root;
  // A repository-relative identifier is a logical name, not a filesystem path: it is reported,
  // compared, and matched in `wtm.toml`, so it always reads the same regardless of host, the
  // same way git always reports `/`-separated worktree paths.
  const path = toPosixPath(relative(workspaceRoot, root)) || '.';
  const declarations = await readEnvDeclarations(root);
  const manifest = await readPackageManifest(root);
  const compose = await readComposeFile(root);
  const makefilePort = await readMakefilePort(root);

  const evidence = (file: string, detail: string): DetectionEvidence => ({ file: joinPosix(path, file), detail });
  const composeSelf = compose?.services.find((service) => service.name === basename(root));
  const port = detectPort({
    declarations,
    scripts: manifest.scripts,
    compose: composeSelf ?? compose?.services[0] ?? null,
    makefilePort,
    evidence,
    composeFile: compose?.file ?? null,
  });

  return {
    name: basename(root),
    path,
    root,
    port,
    cors: declarations.filter(({ name }) => corsVariablePattern.test(name)).map(({ name }) => name),
    candidates: linkCandidates({ declarations, compose, evidence }),
    composeServices: compose?.services.map(({ name }) => name) ?? [],
    notes: await repositoryNotes(root, manifest),
  };
}

function detectPort(input: {
  declarations: EnvDeclaration[];
  scripts: Record<string, string>;
  compose: ComposeService | null;
  makefilePort: { port: number; line: string } | null;
  composeFile: string | null;
  evidence: (file: string, detail: string) => DetectionEvidence;
}): DetectedPort | null {
  const found: DetectionEvidence[] = [];
  const declared = ownPortDeclaration(input.declarations);
  if (declared !== undefined) found.push(input.evidence(declared.file, `${declared.name}=`));

  const scripted = scriptPort(input.scripts);
  if (scripted !== null) found.push(input.evidence('package.json', `scripts.${scripted.script}`));
  if (input.compose !== null && input.compose.published[0] !== undefined && input.composeFile !== null) {
    found.push(input.evidence(input.composeFile, `services.${input.compose.name}.ports`));
  }
  if (input.makefilePort !== null) found.push(input.evidence('Makefile', input.makefilePort.line));

  const preferred = numericValue(declared?.value)
    ?? scripted?.port
    ?? input.compose?.published[0]
    ?? input.makefilePort?.port
    ?? null;
  const env = declared?.name ?? null;
  if (env === null && preferred === null) return null;
  return { env, preferred, evidence: found };
}

/**
 * The repository's own port variable. A bare `PORT` is unambiguous; a prefixed one is only
 * taken when nothing else claims the prefix, because `API_PORT` in the web app's example file
 * is the API's port, not the web app's.
 */
function ownPortDeclaration(declarations: EnvDeclaration[]): EnvDeclaration | undefined {
  const ports = declarations.filter(({ name }) => portVariablePattern.test(name));
  return ports.find(({ name }) => name === 'PORT') ?? ports[0];
}

/** `next dev -p 3000`, `vite --port 5173`, `PORT=3000 node server.js`. */
function scriptPort(scripts: Record<string, string>): { script: string; port: number } | null {
  for (const script of ['dev', 'start', 'serve', 'develop']) {
    const command = scripts[script];
    if (command === undefined) continue;
    const match = /(?:--port[= ]|(?<![\w-])-p[= ]|(?<![\w-])PORT=)(\d{2,5})\b/.exec(command);
    const port = Number(match?.[1]);
    if (match !== null && port >= 1 && port <= 65_535) return { script, port };
  }
  return null;
}

async function readMakefilePort(root: string): Promise<{ port: number; line: string } | null> {
  for (const file of ['Makefile', 'makefile', 'GNUmakefile']) {
    const contents = await readTextFile(join(root, file), 64 * 1024);
    if (contents === null) continue;
    const match = /^([A-Z0-9_]*PORT)\s*[:?]?=\s*(\d{2,5})\s*$/m.exec(contents);
    const port = Number(match?.[2]);
    if (match?.[1] !== undefined && port >= 1 && port <= 65_535) return { port, line: `${match[1]} =` };
  }
  return null;
}

function linkCandidates(input: {
  declarations: EnvDeclaration[];
  compose: Awaited<ReturnType<typeof readComposeFile>>;
  evidence: (file: string, detail: string) => DetectionEvidence;
}): LinkCandidate[] {
  const candidates: LinkCandidate[] = [];
  for (const declaration of input.declarations) {
    if (declaration.value === null || corsVariablePattern.test(declaration.name)) continue;
    if (!addressVariablePattern.test(declaration.name) || !/^https?:\/\//i.test(declaration.value)) continue;
    candidates.push({
      variable: declaration.name,
      url: declaration.value,
      evidence: input.evidence(declaration.file, `${declaration.name}=`),
    });
  }
  for (const service of input.compose?.services ?? []) {
    for (const entry of service.urls) {
      candidates.push({
        variable: entry.name,
        url: entry.url,
        evidence: input.evidence(input.compose?.file ?? 'compose.yaml', `services.${service.name}.environment`),
      });
    }
  }
  return candidates;
}

/**
 * Turns each repository's directory name into the name its endpoint is configured under, and
 * settles collisions, because two repositories called `api` still need two endpoints.
 */
function nameServices(drafts: RepositoryDraft[]): RepositoryDraft[] {
  const taken = new Set<string>();
  return drafts.map((draft) => {
    const base = slug(basename(draft.root));
    let name = base;
    for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}-${suffix}`;
    taken.add(name);
    return { ...draft, name };
  });
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
}

/**
 * Decides which service each address points at. A port that another service already asks for
 * is the strongest signal there is; a compose hostname is as strong, because compose resolves
 * service names to services. Falling back to the variable's own name is a guess, and is
 * reported as one.
 */
function resolveLinks(draft: RepositoryDraft, services: RepositoryDraft[]): DetectedLink[] {
  const others = services.filter((service) => service.name !== draft.name);
  const links = new Map<string, DetectedLink>();

  for (const candidate of draft.candidates) {
    const address = parseAddress(candidate.url);
    if (address === null) continue;
    const resolved = matchService(address, candidate.variable, others, draft);
    if (resolved === null || links.has(candidate.variable)) continue;
    links.set(candidate.variable, {
      variable: candidate.variable,
      target: resolved.service.name,
      template: `${address.protocol}//${publishedHost}:{port.${resolved.service.name}}${address.path}`,
      confidence: resolved.confidence,
      evidence: candidate.evidence,
    });
  }
  return [...links.values()];
}

function matchService(
  address: ParsedAddress,
  variable: string,
  others: RepositoryDraft[],
  draft: RepositoryDraft,
): { service: RepositoryDraft; confidence: DetectionConfidence } | null {
  const byHost = others.find((service) => service.name === slug(address.host));
  if (byHost !== undefined) return { service: byHost, confidence: 'high' };

  if (loopbackHosts.has(address.host) && address.port !== null) {
    const byPort = others.find((service) => service.port?.preferred === address.port);
    if (byPort !== undefined) return { service: byPort, confidence: 'high' };
    // A loopback address on this repository's own port is this repository talking to itself.
    if (draft.port?.preferred === address.port) return null;
  }

  if (!loopbackHosts.has(address.host) && !draft.composeServices.includes(address.host)) return null;
  const tokens = new Set(variable.toLowerCase().split('_'));
  const byName = others.find((service) => tokens.has(service.name));
  return byName === undefined ? null : { service: byName, confidence: 'medium' };
}

interface ParsedAddress {
  protocol: string;
  host: string;
  port: number | null;
  path: string;
}

function parseAddress(value: string): ParsedAddress | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return {
    protocol: url.protocol,
    host: url.hostname,
    port: url.port === '' ? null : Number(url.port),
    path: url.pathname === '/' && !value.endsWith('/') ? '' : url.pathname,
  };
}

interface PackageManifest {
  scripts: Record<string, string>;
  workspaces: string[];
}

async function readPackageManifest(root: string): Promise<PackageManifest> {
  const empty: PackageManifest = { scripts: {}, workspaces: [] };
  const contents = await readTextFile(join(root, 'package.json'), 1024 * 1024);
  if (contents === null) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return empty;
  }
  if (typeof parsed !== 'object' || parsed === null) return empty;
  const manifest = parsed as Record<string, unknown>;
  const workspaces = Array.isArray(manifest.workspaces)
    ? manifest.workspaces.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return { scripts: stringRecord(manifest.scripts), workspaces };
}

/**
 * A monorepo runs several applications out of one repository, and WTM allocates one endpoint
 * per repository. Saying so is the point: the alternative is a workspace that silently gets
 * one port where it needed three.
 */
async function repositoryNotes(root: string, manifest: PackageManifest): Promise<string[]> {
  if (manifest.workspaces.length === 0) return [];
  const directories = new Set(manifest.workspaces.map((pattern) => pattern.split('/')[0] ?? ''));
  const applications: string[] = [];
  for (const directory of directories) {
    if (directory.length === 0 || directory.includes('*')) continue;
    for (const child of await listDirectories(join(root, directory))) {
      if (await readTextFile(join(root, directory, child, 'package.json'), 1024 * 1024) !== null) {
        applications.push(`${directory}/${child}`);
      }
    }
  }
  if (applications.length < 2) return [];
  return [
    `This repository publishes ${applications.length} packages (${applications.slice(0, 4).join(', ')}`
    + `${applications.length > 4 ? ', …' : ''}). WTM allocates one endpoint per repository, so add a `
    + '[ports.<name>] entry for each package that listens, and name it in that package\'s task.',
  ];
}

async function listDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map(({ name }) => name).sort();
  } catch {
    return [];
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function numericValue(value: string | null | undefined): number | null {
  if (value === undefined || value === null || !/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65_535 ? port : null;
}

/** `path.relative`/`path.join` use the host separator; a repo-relative identifier never should. */
function toPosixPath(value: string): string {
  return sep === '/' ? value : value.split(sep).join('/');
}

async function readTextFile(path: string, maxBytes: number): Promise<string | null> {
  try {
    const contents = await readFile(path, 'utf8');
    return contents.length > maxBytes ? null : contents;
  } catch {
    return null;
  }
}
