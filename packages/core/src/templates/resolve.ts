export interface TemplateContext {
  workspace?: { root?: string; name?: string };
  repo?: { root?: string; name?: string };
  main?: { root?: string };
  worktree?: { root?: string };
  id?: string | number;
  key?: string;
  slug?: string;
  branch?: string;
  branchSlug?: string;
  ports?: Record<string, string | number | undefined>;
  cors?: { origins?: string };
  env?: Record<string, string | undefined>;
}

export interface TemplateErrorShape {
  code: 'WTM_TEMPLATE_UNRESOLVED';
  severity: 'error';
  context: Record<string, unknown>;
}

export class WtmTemplateError extends Error implements TemplateErrorShape {
  readonly code = 'WTM_TEMPLATE_UNRESOLVED' as const;
  readonly severity = 'error' as const;

  constructor(variable: string) {
    super(`Unable to resolve template variable {${variable}}.`);
    this.name = 'WtmTemplateError';
    this.context = { variable };
  }

  readonly context: Record<string, unknown>;
}

/**
 * The single resolved value for one `{variable}`, with no substitution into a larger string.
 * `resolveTemplate` is built on this; `resolveEnvironment` also calls it directly so that an
 * `{env.X}` reference's own resolved value — opaque, and never re-scanned for `{...}` — can be
 * spliced in during the same single pass over the original text, rather than as a second pass
 * over text that already contains substituted, untrusted content.
 */
export function templateValue(variable: string, context: TemplateContext): string | number | undefined {
  switch (variable) {
    case 'workspace.root': return context.workspace?.root;
    case 'workspace.name': return context.workspace?.name;
    case 'repo.root': return context.repo?.root;
    case 'repo.name': return context.repo?.name;
    case 'main.root': return context.main?.root;
    case 'worktree.root': return context.worktree?.root;
    case 'id': return context.id;
    case 'key': return context.key;
    case 'slug': return context.slug;
    case 'branch': return context.branch;
    case 'branch.slug': return context.branchSlug;
    case 'cors.origins': return context.cors?.origins;
    default:
      if (variable.startsWith('port.')) return ownTemplateValue(context.ports, variable.slice('port.'.length));
      if (variable.startsWith('env.')) return ownTemplateValue(context.env, variable.slice('env.'.length));
      return undefined;
  }
}

function ownTemplateValue<T extends string | number>(values: Record<string, T | undefined> | undefined, name: string): T | undefined {
  if (name.length === 0 || values === undefined || !Object.hasOwn(values, name)) return undefined;
  return values[name];
}

/**
 * `guard`, when given, runs on every substituted variable's resolved value before it is spliced
 * in — never on the literal text around it. A caller building a command a shell will interpret
 * uses this to reject an unsafe value at the one point that still knows which text came from an
 * untrusted source and which the task author wrote themselves.
 */
export function resolveTemplate(
  value: string,
  context: TemplateContext,
  guard?: (variable: string, resolvedValue: string) => void,
): string {
  return value.replace(/\{([^{}]+)\}/g, (match, variable: string) => {
    const resolved = templateValue(variable, context);
    if (resolved === undefined) throw new WtmTemplateError(variable);
    const text = String(resolved);
    guard?.(variable, text);
    return text;
  });
}
