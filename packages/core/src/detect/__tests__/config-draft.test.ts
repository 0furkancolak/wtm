import { describe, expect, it } from 'bun:test';
import { parse } from 'smol-toml';
import { parseWtmConfig } from '../../config/schema';
import { renderConfigDraft } from '../config-draft';
import type { DetectedService, WorkspaceDetection } from '../service-detection';

function service(overrides: Partial<DetectedService> & { name: string }): DetectedService {
  return {
    path: overrides.name,
    root: `/workspace/${overrides.name}`,
    port: null,
    cors: [],
    links: [],
    notes: [],
    ...overrides,
  };
}

const detection = (...services: DetectedService[]): WorkspaceDetection => ({ root: '/workspace', services });

const api = service({
  name: 'api',
  port: { env: 'PORT', preferred: 4000, evidence: [{ file: 'api/.env.example', detail: 'PORT=' }] },
  cors: ['CORS_ORIGINS'],
});

const web = service({
  name: 'web',
  port: { env: 'PORT', preferred: 5173, evidence: [{ file: 'web/.env.example', detail: 'PORT=' }] },
  links: [{
    variable: 'VITE_API_URL',
    target: 'api',
    template: 'http://localhost:{port.api}',
    confidence: 'high',
    evidence: { file: 'web/.env.example', detail: 'VITE_API_URL=' },
  }],
});

describe('configuration drafting', () => {
  it('writes what detection found as a configuration that parses', () => {
    const draft = renderConfigDraft({ detection: detection(api, web) });
    const config = parseWtmConfig(parse(`version = 1\n\n${draft.document}`));

    expect(config.ports?.api).toEqual({ preferred: 4000 });
    expect(config.repos?.api?.environment).toEqual({ PORT: '{port.api}', CORS_ORIGINS: '{cors.origins}' });
    // Two repositories both publish PORT, and each one means its own endpoint.
    expect(config.repos?.web?.environment).toEqual({ PORT: '{port.web}', VITE_API_URL: 'http://localhost:{port.api}' });
    expect(config.cors).toEqual({ enabled: false });
  });

  it('allocates from a band that contains the ports the repositories asked for', () => {
    // The built-in band starts at 20000, where a preferred 4000 would never be tried.
    const range = parsePortRangeFrom(renderConfigDraft({ detection: detection(api, web) }).document);

    expect(range).toBe('4000-5373');
  });

  it('fits itself to a range already in force, and says what it left out', () => {
    // A second [ports] table is a TOML error, so the range cannot be widened from here — and a
    // preferred port outside it is one the allocator would never offer.
    const draft = renderConfigDraft({
      detection: detection(api, web),
      existing: parseWtmConfig(parse('[ports]\nrange = "20000-50000"\n')),
    });

    expect(draft.outOfRange).toEqual([
      { service: 'api', preferred: 4000, range: '20000-50000', suggested: '4000-50000' },
      { service: 'web', preferred: 5173, range: '20000-50000', suggested: '4000-50000' },
    ]);
    expect(draft.document).not.toContain('\npreferred = 4000');
    expect(draft.document).toContain('Widen the range to "4000-50000", then add: preferred = 4000');
    expect(() => parseWtmConfig(parse(`version = 1\n\n${draft.document}`))).not.toThrow();
  });

  it('leaves alone every table the file already defines', () => {
    const draft = renderConfigDraft({
      detection: detection(api, web),
      existing: parseWtmConfig(parse('[ports]\nrange = "9000-9100"\n\n[repos.api]\npath = "api"\n')),
    });

    // The range is the file's own decision, so no [ports] table is proposed at all.
    expect(draft.blocks.map(({ path }) => path)).not.toContain('ports');
    expect(draft.blocks.filter(({ present }) => present).map(({ path }) => path)).toEqual(['repos.api']);
    expect(draft.additions).not.toContain('[repos.api]');
    expect(draft.additions).toContain('[repos.web]');
    expect(draft.additions).toContain('[ports.api]');
  });

  it('marks a link that was matched by name alone', () => {
    const guessed = service({
      name: 'web',
      links: [{
        variable: 'API_URL',
        target: 'api',
        template: 'http://localhost:{port.api}',
        confidence: 'medium',
        evidence: { file: 'web/.env.example', detail: 'API_URL=' },
      }],
    });

    expect(renderConfigDraft({ detection: detection(api, guessed) }).document)
      .toContain('matched by name — check it');
  });

  it('proposes nothing at all for a workspace that declares nothing', () => {
    const draft = renderConfigDraft({ detection: detection(service({ name: 'plain' })) });

    expect(draft.document).toBe('');
    expect(draft.additions).toBe('');
  });
});

function parsePortRangeFrom(document: string): unknown {
  return (parse(document) as { ports?: { range?: unknown } }).ports?.range;
}
