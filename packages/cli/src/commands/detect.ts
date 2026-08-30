import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import {
  detectWorkspaceServices,
  discoverWorkspace,
  parseWtmConfig,
  renderConfigDraft,
  WtmConfigError,
  type ConfigDraft,
  type ConfigDraftBlock,
  type WorkspaceDetection,
  type WtmConfig,
} from '@wtm/core';
import type { JsonEnvelope, WtmError } from '@wtm/protocol';

export interface DetectCommandInput {
  root: string;
  /** Append the tables the configuration does not have yet. Off by default: reading is safe. */
  write?: boolean;
  maxDepth?: number;
}

export interface DetectCommandResult {
  workspaceRoot: string;
  configPath: string;
  configExists: boolean;
  detection: WorkspaceDetection;
  blocks: ConfigDraftBlock[];
  /** The tables that are missing, as TOML ready to be appended. */
  additions: string;
  written: boolean;
}

export type DetectCommandEnvelope = JsonEnvelope<DetectCommandResult | null>;

/**
 * Reads the workspace's repositories and reports what WTM would have to be told about them —
 * which port each one wants, where it expects a CORS allowlist, and which of its variables
 * address another repository in the same workspace.
 *
 * It is a separate command from `init` because a workspace grows: a repository added a month
 * later declares things nothing has been told about, and the answer should be a diff a person
 * can read rather than a rewrite of a file they own.
 */
export async function runDetectCommand(input: DetectCommandInput): Promise<DetectCommandEnvelope> {
  try {
    return await detect(input);
  } catch (error) {
    return {
      schemaVersion: 1,
      ok: false,
      command: 'detect',
      scope: { mode: 'local' },
      data: null,
      warnings: [],
      errors: [toDetectError(error)],
    };
  }
}

async function detect(input: DetectCommandInput): Promise<DetectCommandEnvelope> {
  const discovery = await discoverWorkspace(input.root, { maxDepth: input.maxDepth ?? 5 });
  const configPath = join(discovery.root, 'wtm.toml');
  const existing = await readConfig(configPath);
  const detection = await detectWorkspaceServices({
    root: discovery.root,
    repositories: discovery.repositories.map(({ mainRoot }) => ({ root: mainRoot })),
  });
  const draft = renderConfigDraft({
    detection,
    ...(existing === null ? {} : { existing: existing.config }),
  });

  if (input.write === true && existing === null) {
    throw new WtmConfigError('There is no wtm.toml to add to. Run `wtm init` to create one.', {
      source: configPath,
    });
  }
  const written = input.write === true && existing !== null && draft.additions.length > 0;
  if (written && existing !== null) await appendConfig(configPath, existing.contents, draft.additions);

  return {
    schemaVersion: 1,
    ok: true,
    command: 'detect',
    scope: { mode: 'local' },
    warnings: warnings(detection, draft),
    errors: [],
    data: {
      workspaceRoot: discovery.root,
      configPath,
      configExists: existing !== null,
      detection,
      blocks: draft.blocks,
      additions: draft.additions,
      written,
    },
  };
}

/**
 * Adds the missing tables to the end of the file, and never touches a line already in it. A
 * table defined twice is a TOML error, so only tables the file does not already define are
 * offered — and the result is parsed before it is kept.
 */
async function appendConfig(path: string, contents: string, additions: string): Promise<void> {
  const separator = contents.length === 0 || contents.endsWith('\n') ? '\n' : '\n\n';
  const updated = `${contents}${separator}${additions}`;
  try {
    parseWtmConfig(parse(updated), path);
  } catch (error) {
    throw error instanceof WtmConfigError ? error : new WtmConfigError(
      'Adding the detected tables would make the configuration invalid; nothing was written.',
      { source: path },
    );
  }

  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    // Anything written since the file was read would be below this, and is left alone.
    await handle.write(`${separator}${additions}`);
  } finally {
    await handle.close();
  }
}

async function readConfig(path: string): Promise<{ contents: string; config: WtmConfig } | null> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  return { contents, config: parseWtmConfig(parse(contents), path) };
}

function warnings(detection: WorkspaceDetection, draft: ConfigDraft): WtmError[] {
  const found: WtmError[] = [];
  for (const port of draft.outOfRange) {
    found.push(warning(
      `${port.service} asks for port ${port.preferred}, outside [ports].range = "${port.range}". `
      + `Widen it to "${port.suggested}" to give it that port.`,
      { service: port.service, port: port.preferred, range: port.range },
    ));
  }
  for (const service of detection.services) {
    for (const note of service.notes) {
      found.push(warning(note, { service: service.name }));
    }
    for (const link of service.links.filter(({ confidence }) => confidence !== 'high')) {
      found.push(warning(
        `${service.name} may address ${link.target} through ${link.variable}, matched by name alone.`,
        { service: service.name, variable: link.variable, target: link.target },
      ));
    }
  }
  const present = draft.blocks.filter((block) => block.present).map(({ path }) => path);
  if (present.length > 0) {
    found.push(warning(
      `The configuration already decides ${present.join(', ')}; those were left as they are.`,
      { blocks: present },
    ));
  }
  return found;
}

function warning(message: string, context: Record<string, unknown>): WtmError {
  return { code: 'WTM_CONFIG_INVALID', message, severity: 'warning', context };
}

function toDetectError(error: unknown): WtmError {
  const message = error instanceof Error ? error.message : String(error);
  const context = typeof error === 'object' && error !== null && 'context' in error
    && typeof error.context === 'object' && error.context !== null && !Array.isArray(error.context)
    ? error.context as Record<string, unknown>
    : {};
  return { code: 'WTM_CONFIG_INVALID', message, severity: 'error', context: { ...context, command: 'detect' } };
}
