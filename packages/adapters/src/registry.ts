import type {
  AdapterContext,
  AdapterMetadata,
  BuiltInAdapter,
  DetectionResult,
  DoctorCheck,
} from '@wtm/protocol';
import { adapterContextSchema, doctorCheckSchema } from '@wtm/protocol';
import { makeAdapter } from './make';
import { bunAdapter } from './bun';
import { pnpmAdapter } from './pnpm';
import { npmAdapter } from './npm';
import { nextAdapter } from './next';
import { uvAdapter } from './uv';
import { cargoAdapter } from './cargo';
import { goAdapter } from './go';
import { dockerComposeAdapter } from './docker-compose';

export interface AdapterActivation {
  adapter: BuiltInAdapter;
  metadata: AdapterMetadata;
  detection: DetectionResult;
}

export interface AdapterGraph {
  detected: AdapterActivation[];
  active: AdapterActivation[];
  findings: DoctorCheck[];
}

export const builtInAdapters: readonly BuiltInAdapter[] = [
  makeAdapter,
  bunAdapter,
  pnpmAdapter,
  npmAdapter,
  nextAdapter,
  uvAdapter,
  cargoAdapter,
  goAdapter,
  dockerComposeAdapter,
];

const exclusiveCapabilities = ['javascript.package-manager'] as const;

export async function detectBuiltInAdapters(context: AdapterContext): Promise<AdapterGraph> {
  const parsedContext = adapterContextSchema.parse(context);
  const detections = await Promise.all(builtInAdapters.map(async (adapter): Promise<AdapterActivation> => ({
    adapter,
    metadata: adapter.metadata(),
    detection: await adapter.detect(parsedContext),
  })));
  const detected = detections.filter(({ detection }) => detection.detected);
  const ambiguousAdapterIds = new Set<string>();
  const findings: DoctorCheck[] = [];

  for (const capability of exclusiveCapabilities) {
    const providers = detected.filter(({ metadata }) => metadata.provides.includes(capability));
    if (providers.length < 2) continue;

    const providerIds = providers.map(({ metadata }) => metadata.id);
    providerIds.forEach((id) => ambiguousAdapterIds.add(id));
    findings.push(doctorCheckSchema.parse({
      code: 'ADAPTER_DETECTION_AMBIGUOUS',
      message: `Capability ${capability} has multiple detected providers: ${providerIds.join(', ')}.`,
      severity: 'error',
      context: { capability, providers: providerIds },
    }));
  }

  let active = detected.filter(({ metadata }) => !ambiguousAdapterIds.has(metadata.id));
  while (true) {
    const providedCapabilities = new Set(active.flatMap(({ metadata }) => metadata.provides));
    const blocked = active.flatMap((activation) => (activation.metadata.requires ?? [])
      .filter((capability) => !providedCapabilities.has(capability))
      .map((capability) => ({ activation, capability })));
    if (blocked.length === 0) break;

    const blockedAdapterIds = new Set(blocked.map(({ activation }) => activation.metadata.id));
    for (const { activation, capability } of blocked) {
      findings.push(doctorCheckSchema.parse({
        code: 'ADAPTER_PLAN_CONFLICT',
        message: `Adapter ${activation.metadata.id} requires active capability ${capability}.`,
        severity: 'error',
        context: { adapter: activation.metadata.id, capability },
      }));
    }
    active = active.filter(({ metadata }) => !blockedAdapterIds.has(metadata.id));
  }

  return {
    detected,
    active,
    findings,
  };
}
