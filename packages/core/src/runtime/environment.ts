import { resolveTemplate, WtmTemplateError, type TemplateContext } from '../templates/resolve';

export interface EnvironmentResolutionInput {
  workspace?: Record<string, string>;
  task?: Record<string, string>;
  context: TemplateContext;
}

export class WtmEnvironmentError extends Error {
  readonly code = 'WTM_CONFIG_INVALID' as const;
  readonly severity = 'error' as const;
  readonly context: Record<string, unknown>;

  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'WtmEnvironmentError';
    this.context = context;
  }
}

export function resolveEnvironment(input: EnvironmentResolutionInput): Record<string, string> {
  const declared = { ...input.workspace, ...input.task };
  const inherited = input.context.env ?? {};
  const resolved: Record<string, string> = {};
  const resolving: string[] = [];

  const resolveName = (name: string): string => {
    if (Object.hasOwn(resolved, name)) return resolved[name] as string;
    if (!Object.hasOwn(declared, name)) {
      const value = inherited[name];
      if (value === undefined) throw new WtmTemplateError(`env.${name}`);
      return value;
    }

    const cycleStart = resolving.indexOf(name);
    if (cycleStart !== -1) {
      const cycle = [...resolving.slice(cycleStart), name];
      throw new WtmEnvironmentError(`Circular environment template reference: ${cycle.join(' -> ')}`, {
        variables: cycle,
      });
    }

    resolving.push(name);
    try {
      const raw = declared[name] as string;
      const withEnvironment = raw.replace(/\{env\.([^{}]+)\}/g, (_match, referencedName: string) =>
        resolveName(referencedName),
      );
      const value = resolveTemplate(withEnvironment, {
        ...input.context,
        env: { ...inherited, ...resolved },
      });
      resolved[name] = value;
      return value;
    } finally {
      resolving.pop();
    }
  };

  for (const name of Object.keys(declared)) resolveName(name);
  return resolved;
}
