import type { WtmConfig } from './schema.js';

export interface Provenance {
  source: string;
  line?: number;
}

export interface ResolvedConfig<T> {
  value: T;
  provenance: Map<string, Provenance>;
}

type ConfigRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ConfigRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function findTomlValueLine(toml: string, path: string): number | undefined {
  const target = path.split('.');
  const lines = toml.split(/\r?\n/);
  let table: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (rawLine === undefined) continue;
    const tableMatch = /^\s*\[([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\]\s*(?:#.*)?$/.exec(rawLine);
    if (tableMatch?.[1] !== undefined) {
      table = tableMatch[1].split('.');
      continue;
    }

    const assignment = /^\s*([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s*=/.exec(rawLine);
    if (assignment?.[1] === undefined) continue;
    const candidate = [...table, ...assignment[1].split('.')];
    if (candidate.length === target.length && candidate.every((part, partIndex) => part === target[partIndex])) {
      return index + 1;
    }
  }

  return undefined;
}

export function collectProvenance(value: WtmConfig, source: string, toml?: string): Map<string, Provenance> {
  const provenance = new Map<string, Provenance>();

  const visit = (current: unknown, path: string[]) => {
    if (Array.isArray(current) || !isRecord(current)) {
      if (path.length > 0) {
        const key = path.join('.');
        const line = toml === undefined ? undefined : findTomlValueLine(toml, key);
        provenance.set(key, line === undefined ? { source } : { source, line });
      }
      return;
    }

    for (const [key, child] of Object.entries(current)) visit(child, [...path, key]);
  };

  visit(value, []);
  return provenance;
}
