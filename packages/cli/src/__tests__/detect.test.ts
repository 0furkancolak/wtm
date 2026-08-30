import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { parse } from 'smol-toml';
import { parseWtmConfig } from '@wtm/core';
import { runDetectCommand, type DetectCommandResult } from '../commands/detect';

const execFileAsync = promisify(execFile);
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wtm-detect-command-'));
  await repository('api', 'PORT=4000\nCORS_ORIGINS=\n');
  await repository('web', 'PORT=5173\nVITE_API_URL=http://localhost:4000\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function repository(name: string, example: string): Promise<void> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await execFileAsync('git', ['init', '--initial-branch=main', path]);
  await writeFile(join(path, '.env.example'), example);
}

const detect = async (write?: boolean): Promise<DetectCommandResult> => {
  const envelope = await runDetectCommand({ root, ...(write === undefined ? {} : { write }) });
  expect(envelope.errors).toEqual([]);
  expect(envelope.data).not.toBeNull();
  return envelope.data as DetectCommandResult;
};

const configuration = async () => parseWtmConfig(parse(await readFile(join(root, 'wtm.toml'), 'utf8')));

describe('wtm detect', () => {
  it('reports what each repository declares, and changes nothing', async () => {
    await writeFile(join(root, 'wtm.toml'), 'version = 1\n\n[workspace]\nname = "shop"\n');

    const result = await detect();

    expect(result.detection.services.map(({ name }) => name)).toEqual(['api', 'web']);
    expect(result.written).toBe(false);
    expect(result.additions).toContain('[repos.api]');
    expect(await readFile(join(root, 'wtm.toml'), 'utf8')).not.toContain('[repos.api]');
  });

  it('writes the tables the configuration does not have yet', async () => {
    await writeFile(join(root, 'wtm.toml'), 'version = 1\n\n[workspace]\nname = "shop"\n');

    expect((await detect(true)).written).toBe(true);
    const config = await configuration();

    expect(config.workspace?.name).toBe('shop');
    expect(config.ports?.api).toEqual({ preferred: 4000 });
    expect(config.repos?.api?.environment).toEqual({ PORT: '{port.api}', CORS_ORIGINS: '{cors.origins}' });
    expect(config.repos?.web?.environment).toEqual({
      PORT: '{port.web}',
      VITE_API_URL: 'http://localhost:{port.api}',
    });
  });

  it('never writes the same table twice', async () => {
    await writeFile(join(root, 'wtm.toml'), 'version = 1\n\n[workspace]\nname = "shop"\n');
    await detect(true);
    const afterFirst = await readFile(join(root, 'wtm.toml'), 'utf8');

    // The second run has nothing left to add, and a table written twice is a TOML error.
    expect((await detect(true)).written).toBe(false);
    expect(await readFile(join(root, 'wtm.toml'), 'utf8')).toBe(afterFirst);
  });

  it('keeps a decision the configuration already made', async () => {
    await writeFile(join(root, 'wtm.toml'), [
      'version = 1', '', '[workspace]', 'name = "shop"', '',
      '[repos.api.environment]', 'PORT = "{port.api}"', 'CORS_ORIGINS = "https://staging.invalid"', '',
    ].join('\n'));

    const envelope = await runDetectCommand({ root, write: true });
    const result = envelope.data as DetectCommandResult;

    expect((await configuration()).repos?.api?.environment?.CORS_ORIGINS).toBe('https://staging.invalid');
    expect(result.blocks.find(({ path }) => path === 'repos.api')?.present).toBe(true);
    // Being told what was left alone is the difference between a skipped table and a lost one.
    expect(envelope.warnings.map(({ message }) => message))
      .toContain('The configuration already decides repos.api; those were left as they are.');
  });

  it('says which port the range in force would never offer', async () => {
    await writeFile(join(root, 'wtm.toml'), 'version = 1\n\n[ports]\nrange = "20000-50000"\n');

    const envelope = await runDetectCommand({ root, write: true });

    expect(envelope.warnings.map(({ message }) => message)).toContain(
      'api asks for port 4000, outside [ports].range = "20000-50000". '
      + 'Widen it to "4000-50000" to give it that port.',
    );
    // What was written still has to be a configuration the workspace can run on.
    expect((await configuration()).ports?.api).toEqual({});
  });

  it('says where to start when there is no configuration to add to', async () => {
    const envelope = await runDetectCommand({ root, write: true });

    expect(envelope.ok).toBe(false);
    expect(envelope.errors[0]?.message).toContain('wtm init');
  });
});
