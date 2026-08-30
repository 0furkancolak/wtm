import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The names Docker Compose itself looks for, in the order it looks for them. */
export const composeFiles = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
] as const;

/** A compose file that is megabytes long is a generated artifact, and is not read. */
const maxComposeBytes = 256 * 1024;

export interface ComposeService {
  name: string;
  /** The container ports the file publishes on the host, in the order declared. */
  published: number[];
  /** Environment entries whose value is a URL, which is what names one service from another. */
  urls: Array<{ name: string; url: string }>;
}

export interface ComposeFileReport {
  file: string;
  services: ComposeService[];
}

/**
 * Reads the service names, published ports, and URL-valued environment entries out of a
 * compose file.
 *
 * This is a deliberately small reader rather than a YAML parser: it understands the block
 * shapes compose files are written in and gives up on anything else. What it produces is
 * evidence for a suggestion a person reads before accepting, never a runtime decision — so
 * missing a service costs a suggestion, and there is nothing for a malformed file to break.
 */
export async function readComposeFile(root: string): Promise<ComposeFileReport | null> {
  for (const file of composeFiles) {
    const contents = await readComposeContents(join(root, file));
    if (contents === null) continue;
    return { file, services: parseComposeServices(contents) };
  }
  return null;
}

async function readComposeContents(path: string): Promise<string | null> {
  try {
    const contents = await readFile(path, 'utf8');
    return contents.length > maxComposeBytes ? null : contents;
  } catch {
    return null;
  }
}

interface ComposeLine {
  indent: number;
  content: string;
}

export function parseComposeServices(contents: string): ComposeService[] {
  const lines = readableLines(contents);
  const servicesAt = lines.findIndex(({ indent, content }) => indent === 0 && content === 'services:');
  if (servicesAt === -1) return [];

  const body = block(lines, servicesAt);
  const services: ComposeService[] = [];
  for (const [index, line] of body.entries()) {
    const name = /^([A-Za-z0-9][A-Za-z0-9._-]*):$/.exec(line.content)?.[1];
    if (name === undefined || line.indent !== body[0]?.indent) continue;
    services.push(parseService(name, block(body, index)));
  }
  return services;
}

function parseService(name: string, body: ComposeLine[]): ComposeService {
  const service: ComposeService = { name, published: [], urls: [] };
  for (const [index, line] of body.entries()) {
    if (line.indent !== body[0]?.indent) continue;
    if (line.content === 'ports:') service.published = parsePorts(block(body, index));
    if (line.content === 'environment:') service.urls = parseEnvironment(block(body, index));
  }
  return service;
}

/** `- "8080:3000"`, `- 3000:3000`, `- 3000`, and the host-address form `- 127.0.0.1:8080:3000`. */
function parsePorts(entries: ComposeLine[]): number[] {
  const ports: number[] = [];
  for (const entry of entries) {
    const value = unquote(entry.content.replace(/^-\s*/, ''));
    const published = /^(?:[0-9.]+:)?(\d{1,5})(?::\d{1,5})?(?:\/\w+)?$/.exec(value)?.[1];
    const port = Number(published);
    if (published !== undefined && port >= 1 && port <= 65_535) ports.push(port);
  }
  return ports;
}

/** Both spellings compose accepts: the `KEY: value` map and the `- KEY=value` list. */
function parseEnvironment(entries: ComposeLine[]): Array<{ name: string; url: string }> {
  const urls: Array<{ name: string; url: string }> = [];
  for (const entry of entries) {
    const listed = /^-\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(entry.content);
    const mapped = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.+)$/.exec(entry.content);
    const match = listed ?? mapped;
    if (match?.[1] === undefined) continue;
    const url = unquote(match[2] ?? '');
    if (/^https?:\/\/[A-Za-z0-9]/.test(url)) urls.push({ name: match[1], url });
  }
  return urls;
}

/** The lines nested under `lines[index]`, up to the next line at the same or shallower indent. */
function block(lines: ComposeLine[], index: number): ComposeLine[] {
  const parent = lines[index];
  if (parent === undefined) return [];
  const body: ComposeLine[] = [];
  for (const line of lines.slice(index + 1)) {
    if (line.indent <= parent.indent) break;
    body.push(line);
  }
  return body;
}

function readableLines(contents: string): ComposeLine[] {
  const lines: ComposeLine[] = [];
  for (const raw of contents.split(/\r?\n/)) {
    // A tab in the indentation is not valid YAML, and guessing its width would misplace the line.
    if (raw.includes('\t')) continue;
    const content = raw.trim();
    if (content.length === 0 || content.startsWith('#')) continue;
    lines.push({ indent: raw.length - raw.trimStart().length, content: content.replace(/\s+#.*$/, '') });
  }
  return lines;
}

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value.trim());
  return (quoted?.[2] ?? value).trim();
}
