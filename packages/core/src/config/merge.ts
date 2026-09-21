import { collectProvenance, type ResolvedConfig, type Provenance } from './provenance';
import { WtmConfigError, type TaskConfig, type WtmConfig } from './schema';

type ConfigRecord = Record<string, unknown>;

export interface ConfigLayer {
  source: string;
  value: WtmConfig;
  provenance?: Map<string, Provenance>;
}

function isRecord(value: unknown): value is ConfigRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const dangerousKeys = new Set(['__proto__', 'constructor', 'prototype']);

function assertSafeKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) assertSafeKeys(child);
    return;
  }
  if (!isRecord(value)) return;

  for (const key of Object.keys(value)) {
    if (dangerousKeys.has(key)) {
      throw new WtmConfigError('WTM configuration contains a prohibited object key.', { key });
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new WtmConfigError('WTM configuration contains an accessor property.', { key });
    }
    assertSafeKeys(descriptor.value);
  }
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneValue) as T;
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)])) as T;
  return value;
}

function leafPaths(value: unknown, prefix: string[] = []): string[] {
  if (Array.isArray(value) || !isRecord(value)) return prefix.length === 0 ? [] : [prefix.join('.')];
  return Object.entries(value).flatMap(([key, child]) => leafPaths(child, [...prefix, key]));
}

function mergeInto(target: ConfigRecord, source: ConfigRecord): void {
  for (const [key, incoming] of Object.entries(source)) {
    const existing = target[key];
    if (isRecord(existing) && isRecord(incoming)) {
      mergeInto(existing, incoming);
    } else {
      target[key] = cloneValue(incoming);
    }
  }
}

export function mergeConfigLayers(layers: ConfigLayer[]): ResolvedConfig<WtmConfig> {
  const value: ConfigRecord = {};
  const provenance = new Map<string, Provenance>();

  for (const layer of layers) {
    assertSafeKeys(layer.value);
    mergeInto(value, layer.value as ConfigRecord);
    for (const path of leafPaths(layer.value)) {
      const source = layer.provenance?.get(path);
      provenance.set(path, source ?? { source: layer.source });
    }
  }

  return { value: value as WtmConfig, provenance };
}

/**
 * Layers `wtm task set` records on top of an already-resolved configuration. Each named task is
 * a whole replacement, not a field-by-field merge — the same way a later file layer replaces an
 * earlier one's array or string leaves in {@link mergeConfigLayers} — so a stale provenance entry
 * from the file-defined task cannot survive under a field the override left out and be picked up
 * by `wtm explain` as if it still applied.
 */
export function applyTaskOverrides(resolved: ResolvedConfig<WtmConfig>, overrides: Record<string, TaskConfig>): ResolvedConfig<WtmConfig> {
  const names = Object.keys(overrides);
  if (names.length === 0) return resolved;

  const tasks = { ...resolved.value.tasks, ...overrides };
  const provenance = new Map(resolved.provenance);
  for (const name of names) {
    for (const key of provenance.keys()) {
      if (key === `tasks.${name}` || key.startsWith(`tasks.${name}.`)) provenance.delete(key);
    }
  }
  for (const [key, value] of collectProvenance({ tasks: overrides }, 'db')) provenance.set(key, value);

  return { value: { ...resolved.value, tasks }, provenance };
}
