import { readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  adapterContextSchema,
  adapterMetadataSchema,
  adapterPlanSchema,
  detectionResultSchema,
  doctorCheckSchema,
} from '@wtm/protocol';
import type {
  AdapterContext,
  AdapterMetadata,
  AdapterPlan,
  BuiltInAdapter,
  DetectionResult,
  DoctorCheck,
} from '@wtm/protocol';

interface BuiltInAdapterDefinition {
  metadata: AdapterMetadata;
  detect(context: AdapterContext): Promise<DetectionResult>;
  plan(context: AdapterContext): Promise<AdapterPlan>;
  doctor?(context: AdapterContext): Promise<DoctorCheck[]>;
}

export function defineBuiltInAdapter(definition: BuiltInAdapterDefinition): BuiltInAdapter {
  const metadata = adapterMetadataSchema.parse(definition.metadata);

  return {
    metadata: () => adapterMetadataSchema.parse(metadata),
    async detect(context) {
      const parsedContext = adapterContextSchema.parse(context);
      return detectionResultSchema.parse(await definition.detect(parsedContext));
    },
    async plan(context) {
      const parsedContext = adapterContextSchema.parse(context);
      return adapterPlanSchema.parse(await definition.plan(parsedContext));
    },
    async doctor(context) {
      const parsedContext = adapterContextSchema.parse(context);
      const checks = definition.doctor === undefined ? [] : await definition.doctor(parsedContext);
      return checks.map((check) => doctorCheckSchema.parse(check));
    },
  };
}

export async function detectMarkers(root: string, markers: readonly string[], confidence = 1): Promise<DetectionResult> {
  const evidence: DetectionResult['evidence'] = [];
  const seenPaths = new Set<string>();
  for (const marker of markers) {
    const markerPath = join(root, marker);
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(markerPath);
      if (!(await stat(canonicalPath)).isFile()) continue;
    } catch {
      continue;
    }
    if (seenPaths.has(canonicalPath)) continue;
    seenPaths.add(canonicalPath);
    evidence.push({ kind: 'file', value: marker });
  }

  return {
    detected: evidence.length > 0,
    confidence: evidence.length > 0 ? confidence : 0,
    evidence,
  };
}

export async function detectPackageJsonDependency(root: string, dependency: string): Promise<DetectionResult> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as unknown;
  } catch {
    return { detected: false, confidence: 0, evidence: [] };
  }

  if (!isRecord(value)) return { detected: false, confidence: 0, evidence: [] };
  const dependencies = value.dependencies;
  const devDependencies = value.devDependencies;
  const hasDependency = (isStringRecord(dependencies) && dependency in dependencies)
    || (isStringRecord(devDependencies) && dependency in devDependencies);

  return hasDependency
    ? { detected: true, confidence: 1, evidence: [{ kind: 'package-json-dependency', value: dependency }] }
    : { detected: false, confidence: 0, evidence: [] };
}

export async function detectFilePattern(
  root: string,
  marker: string,
  pattern: RegExp,
  confidence = 1,
): Promise<DetectionResult> {
  let contents: string;
  try {
    contents = await readFile(join(root, marker), 'utf8');
  } catch {
    return { detected: false, confidence: 0, evidence: [] };
  }

  return pattern.test(contents)
    ? { detected: true, confidence, evidence: [{ kind: 'file', value: marker }] }
    : { detected: false, confidence: 0, evidence: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}
