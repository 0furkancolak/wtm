import { relative, resolve, sep } from 'node:path';
import {
  wtmErrorCodeSchema,
  type JsonEnvelope,
  type WtmError,
  type WtmErrorCode,
} from '@wtm/protocol';
import { z } from 'zod';

const registeredWorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  root: z.string().min(1),
  scope: z.enum(['local', 'global-only']),
}).strict();

const endpointLeaseSchema = z.object({
  id: z.string().min(1),
  worktreeId: z.string().min(1),
  name: z.string().min(1),
  protocol: z.enum(['tcp', 'udp']),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  state: z.enum(['ACTIVE', 'RELEASED']),
  allocatedAt: z.string().min(1),
  lastVerifiedAt: z.string().min(1),
}).strict();

const statusSchema = z.object({
  workspace: registeredWorkspaceSchema,
  identity: z.object({
    repositoryId: z.string().min(1).nullable(),
    worktreeId: z.string().min(1).nullable(),
    numericId: z.number().int().positive().nullable(),
    path: z.string().min(1),
    branch: z.string().min(1).nullable(),
    headOid: z.string().min(1).nullable(),
    isMain: z.boolean(),
  }).strict(),
  state: z.enum([
    'UNKNOWN', 'DISCOVERED', 'ALLOCATED', 'PREPARING', 'READY', 'STARTING', 'RUNNING',
    'STOPPING', 'DEGRADED', 'FAILED', 'ORPHANED', 'CLEANING', 'REMOVED', 'DEGRADED_CLEANUP',
  ]),
  endpoints: z.array(endpointLeaseSchema),
  processes: z.array(z.object({
    task: z.string().min(1),
    pid: z.number().int().positive().nullable(),
    state: z.enum(['running', 'stopped', 'stale', 'unknown']),
    startedAt: z.string().min(1).nullable(),
    argv: z.array(z.string()),
  }).strict()),
  resources: z.array(z.object({
    name: z.string().min(1),
    path: z.string().min(1),
    policy: z.enum(['shared', 'native-cache', 'clone', 'isolated', 'symlink', 'copy', 'ephemeral', 'external', 'ignore']),
    state: z.enum(['ready', 'missing', 'degraded', 'unknown']),
  }).strict()),
}).strict();

const doctorSchema = z.object({
  workspace: registeredWorkspaceSchema,
  findings: z.array(z.object({
    check: z.enum(['git', 'config', 'adapters', 'resources', 'ports', 'process-records']),
    status: z.enum(['pass', 'warning', 'error', 'unknown']),
    message: z.string().min(1),
    details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  }).strict()),
}).strict();

const explainSchema = z.object({
  workspace: registeredWorkspaceSchema,
  decisions: z.array(z.object({
    kind: z.enum(['adapter', 'resource', 'task', 'config']),
    key: z.string().min(1),
    value: z.json(),
    provenance: z.object({ source: z.string().min(1), line: z.number().int().positive().optional() }).strict(),
    reason: z.string().min(1),
  }).strict()),
}).strict();

const planSchema = z.object({
  workspace: registeredWorkspaceSchema,
  changes: z.array(z.object({
    kind: z.enum(['config', 'adapter', 'resource', 'endpoint', 'process', 'task']),
    action: z.enum(['create', 'update', 'remove', 'none']),
    target: z.string().min(1),
    reason: z.string().min(1),
    details: z.record(z.string(), z.json()).optional(),
  }).strict()),
}).strict();

const envSchema = z.object({
  workspace: registeredWorkspaceSchema,
  variables: z.record(z.string(), z.string()),
}).strict();

const portsSchema = z.object({
  workspace: registeredWorkspaceSchema,
  leases: z.array(endpointLeaseSchema),
}).strict();

export type RegisteredWorkspace = z.infer<typeof registeredWorkspaceSchema>;
export type StatusDiagnostic = z.infer<typeof statusSchema>;
export type DoctorDiagnostic = z.infer<typeof doctorSchema>;
export type ExplainDiagnostic = z.infer<typeof explainSchema>;
export type PlanDiagnostic = z.infer<typeof planSchema>;
export type EnvDiagnostic = z.infer<typeof envSchema>;
export type PortsDiagnostic = z.infer<typeof portsSchema>;

const diagnosticSourceItems = new WeakMap<object, WtmError>();

export class DiagnosticSourceError extends Error {
  constructor(item: WtmError) {
    const normalized = freezeWtmError(normalizeExplicitError(item));
    super(normalized.message);
    this.name = 'DiagnosticSourceError';
    diagnosticSourceItems.set(this, normalized);
  }

  get item(): WtmError {
    const stored = diagnosticSourceItems.get(this);
    return normalizeExplicitError(stored ?? invalidDiagnosticItem());
  }
}

export interface DiagnosticDataSource {
  listRegisteredWorkspaces(): Promise<readonly RegisteredWorkspace[]>;
  readStatus(workspace: RegisteredWorkspace): Promise<StatusDiagnostic>;
  readDoctor(workspace: RegisteredWorkspace): Promise<DoctorDiagnostic>;
  readExplain(workspace: RegisteredWorkspace): Promise<ExplainDiagnostic>;
  readPlan(workspace: RegisteredWorkspace): Promise<PlanDiagnostic>;
  readEnv(workspace: RegisteredWorkspace): Promise<EnvDiagnostic>;
  readPorts(workspace: RegisteredWorkspace): Promise<PortsDiagnostic>;
}

export interface DiagnosticCommandInput {
  cwd: string;
  selector?: string;
  global?: boolean;
}

export type DiagnosticCommandEnvelope<T> = JsonEnvelope<{ workspaces: T[] }>;

interface RegisteredWorkspaceLookup {
  workspace: RegisteredWorkspace;
  normalizedRoot: string;
  depth: number;
}

const doctorOrder = new Map([
  ['git', 0], ['config', 1], ['adapters', 2], ['resources', 3], ['ports', 4], ['process-records', 5],
]);
const unknownDoctorFindings: DoctorDiagnostic['findings'] = [
  { check: 'git', status: 'unknown', message: 'Git diagnostics are unavailable.' },
  { check: 'config', status: 'unknown', message: 'Config diagnostics are unavailable.' },
  { check: 'adapters', status: 'unknown', message: 'Adapter diagnostics are unavailable.' },
  { check: 'resources', status: 'unknown', message: 'Resource diagnostics are unavailable.' },
  { check: 'ports', status: 'unknown', message: 'Port diagnostics are unavailable.' },
  { check: 'process-records', status: 'unknown', message: 'Process record diagnostics are unavailable.' },
];

export async function runStatusCommand(
  input: DiagnosticCommandInput,
  source: DiagnosticDataSource,
): Promise<DiagnosticCommandEnvelope<StatusDiagnostic>> {
  return collect('status', input, source, (workspace) => source.readStatus(workspace), statusSchema, normalizeStatus);
}

export async function runDoctorCommand(
  input: DiagnosticCommandInput,
  source: DiagnosticDataSource,
): Promise<DiagnosticCommandEnvelope<DoctorDiagnostic>> {
  return collect('doctor', input, source, (workspace) => source.readDoctor(workspace), doctorSchema, (value) => ({
    ...value,
    findings: [
      ...value.findings,
      ...unknownDoctorFindings.filter((fallback) =>
        !value.findings.some((finding) => finding.check === fallback.check)),
    ].sort((left, right) =>
      (doctorOrder.get(left.check) ?? 99) - (doctorOrder.get(right.check) ?? 99)
      || codeUnitCompare(left.status, right.status)
      || codeUnitCompare(left.message, right.message)),
  }));
}

export async function runExplainCommand(
  input: DiagnosticCommandInput,
  source: DiagnosticDataSource,
): Promise<DiagnosticCommandEnvelope<ExplainDiagnostic>> {
  return collect('explain', input, source, (workspace) => source.readExplain(workspace), explainSchema, (value) => ({
    ...value,
    decisions: [...value.decisions].sort((left, right) =>
      codeUnitCompare(left.kind, right.kind) || codeUnitCompare(left.key, right.key)),
  }));
}

export async function runPlanCommand(
  input: DiagnosticCommandInput,
  source: DiagnosticDataSource,
): Promise<DiagnosticCommandEnvelope<PlanDiagnostic>> {
  return collect('plan', input, source, (workspace) => source.readPlan(workspace), planSchema, (value) => ({
    ...value,
    changes: [...value.changes].sort((left, right) =>
      codeUnitCompare(left.kind, right.kind)
      || codeUnitCompare(left.target, right.target)
      || codeUnitCompare(left.action, right.action)),
  }));
}

export async function runEnvCommand(
  input: DiagnosticCommandInput,
  source: DiagnosticDataSource,
): Promise<DiagnosticCommandEnvelope<EnvDiagnostic>> {
  return collect('env', input, source, (workspace) => source.readEnv(workspace), envSchema, (value) => ({
    ...value,
    variables: Object.fromEntries(Object.entries(value.variables).sort(([left], [right]) => codeUnitCompare(left, right))),
  }));
}

export async function runPortsCommand(
  input: DiagnosticCommandInput,
  source: DiagnosticDataSource,
): Promise<DiagnosticCommandEnvelope<PortsDiagnostic>> {
  return collect('ports', input, source, (workspace) => source.readPorts(workspace), portsSchema, (value) => ({
    ...value,
    leases: [...value.leases].sort(compareEndpoint),
  }));
}

async function collect<T extends { workspace: RegisteredWorkspace }>(
  command: string,
  input: DiagnosticCommandInput,
  source: DiagnosticDataSource,
  read: (workspace: RegisteredWorkspace) => Promise<T>,
  schema: z.ZodType<T>,
  normalize: (value: T) => T,
): Promise<DiagnosticCommandEnvelope<T>> {
  const mode = input.global === true ? 'global' as const : 'local' as const;
  if (mode === 'global' && input.selector !== undefined) {
    const error = diagnosticError(
      'WTM_CONFIG_INVALID',
      'A workspace selector cannot be combined with global scope.',
      { selector: input.selector },
    );
    return failure(command, { mode }, [], [toDiagnosticError(error, command)]);
  }
  let rawWorkspaces: unknown;
  try {
    rawWorkspaces = await source.listRegisteredWorkspaces();
  } catch (error) {
    return failure(command, { mode }, [], [toDiagnosticError(error, command)]);
  }
  let workspaces: RegisteredWorkspace[];
  try {
    const parsed = registeredWorkspaceSchema.array().safeParse(rawWorkspaces);
    if (!parsed.success) throw invalidResponse(parsed.error.issues.length);
    workspaces = parsed.data.sort((left, right) => codeUnitCompare(left.id, right.id));
  } catch (error) {
    const invalid = error instanceof DiagnosticSourceError ? error : invalidResponse(1);
    return failure(command, { mode }, [], [toDiagnosticError(invalid, command)]);
  }

  let selected: RegisteredWorkspace[];
  try {
    const lookups = workspaces.map(createWorkspaceLookup);
    selected = mode === 'global' ? workspaces : [selectLocalWorkspace(lookups, input)];
  } catch (error) {
    return failure(command, { mode }, [], [toDiagnosticError(error, command)]);
  }

  const data: T[] = [];
  const errors: WtmError[] = [];
  for (const workspace of selected) {
    let response: T;
    try {
      response = await read(workspace);
    } catch (error) {
      errors.push(toDiagnosticError(error, command, workspace.id));
      continue;
    }
    try {
      const parsed = schema.safeParse(response);
      if (!parsed.success) throw invalidResponse(parsed.error.issues.length);
      if (!sameRegisteredWorkspace(parsed.data.workspace, workspace)) {
        throw invalidResponse(1);
      }
      data.push(normalize(parsed.data));
    } catch (error) {
      errors.push(toDiagnosticError(error, command, workspace.id));
    }
  }

  const scope = mode === 'global'
    ? { mode } as const
    : { mode, workspaceId: (selected[0] as RegisteredWorkspace).id } as const;
  if (errors.length > 0) return failure(command, scope, data, errors);
  return {
    schemaVersion: 1,
    ok: true,
    command,
    scope,
    data: { workspaces: data },
    warnings: [],
    errors: [],
  };
}

function selectLocalWorkspace(
  lookups: RegisteredWorkspaceLookup[],
  input: DiagnosticCommandInput,
): RegisteredWorkspace {
  if (input.selector !== undefined) {
    const exactMatches = lookups.filter(({ workspace }) =>
      workspace.id === input.selector || workspace.name === input.selector);
    if (exactMatches.length === 1 && exactMatches[0] !== undefined) return exactMatches[0].workspace;
    if (exactMatches.length > 1) {
      throw diagnosticError('WTM_WORKSPACE_NOT_FOUND', 'The workspace selector did not resolve to one registered workspace.', {
        selector: input.selector,
      });
    }

    const resolvedSelector = resolve(input.cwd, input.selector);
    const pathMatches = lookups
      .filter((lookup) => contains(lookup.normalizedRoot, resolvedSelector))
      .sort(compareWorkspaceSpecificity);
    if (pathMatches[0] !== undefined) return pathMatches[0].workspace;
    throw diagnosticError('WTM_WORKSPACE_NOT_FOUND', 'The workspace selector did not resolve to one registered workspace.', {
      selector: input.selector,
    });
  }

  const cwd = resolve(input.cwd);
  const matches = lookups
    .filter((lookup) => contains(lookup.normalizedRoot, cwd))
    .sort(compareWorkspaceSpecificity);
  if (matches[0] !== undefined) return matches[0].workspace;
  throw diagnosticError(
    lookups.length === 0 ? 'WTM_NOT_INITIALIZED' : 'WTM_WORKSPACE_NOT_FOUND',
    lookups.length === 0
      ? 'No registered WTM workspace is available.'
      : 'The current directory is not contained by a registered WTM workspace.',
    { cwd },
  );
}

function createWorkspaceLookup(workspace: RegisteredWorkspace): RegisteredWorkspaceLookup {
  const normalizedRoot = resolve(workspace.root);
  return {
    workspace,
    normalizedRoot,
    depth: normalizedRoot.split(sep).filter((part) => part.length > 0).length,
  };
}

function compareWorkspaceSpecificity(left: RegisteredWorkspaceLookup, right: RegisteredWorkspaceLookup): number {
  return right.depth - left.depth
    || right.normalizedRoot.length - left.normalizedRoot.length
    || codeUnitCompare(left.normalizedRoot, right.normalizedRoot)
    || codeUnitCompare(left.workspace.id, right.workspace.id);
}

function contains(root: string, candidate: string): boolean {
  const nested = relative(root, candidate);
  return nested === '' || (nested !== '..' && !nested.startsWith(`..${sep}`) && !nested.startsWith(sep));
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeStatus(value: StatusDiagnostic): StatusDiagnostic {
  return {
    ...value,
    endpoints: [...value.endpoints].sort(compareEndpoint),
    processes: [...value.processes].sort((left, right) =>
      codeUnitCompare(left.task, right.task) || (left.pid ?? 0) - (right.pid ?? 0)),
    resources: [...value.resources].sort((left, right) =>
      codeUnitCompare(left.name, right.name) || codeUnitCompare(left.path, right.path)),
  };
}

function compareEndpoint(left: StatusDiagnostic['endpoints'][number], right: StatusDiagnostic['endpoints'][number]): number {
  return codeUnitCompare(left.name, right.name) || codeUnitCompare(left.id, right.id);
}

function failure<T>(
  command: string,
  scope: { mode: 'local' | 'global'; workspaceId?: string },
  data: T[],
  errors: WtmError[],
): DiagnosticCommandEnvelope<T> {
  const first = errors[0];
  const nonempty: [WtmError, ...WtmError[]] = first === undefined
    ? [diagnosticErrorItem('GIT_REPOSITORY_DEGRADED', 'Diagnostic collection failed.')]
    : [first, ...errors.slice(1)];
  return {
    schemaVersion: 1,
    ok: false,
    command,
    scope,
    data: { workspaces: data },
    warnings: [],
    errors: nonempty,
  };
}

function sameRegisteredWorkspace(left: RegisteredWorkspace, right: RegisteredWorkspace): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.root === right.root
    && left.scope === right.scope;
}

function invalidResponse(issueCount: number): DiagnosticSourceError {
  return new DiagnosticSourceError({
    code: 'ADAPTER_INVALID_RESPONSE',
    message: 'Diagnostic data source returned an invalid response.',
    severity: 'error',
    context: { issueCount },
  });
}

function diagnosticError(
  code: WtmErrorCode,
  message: string,
  context?: Record<string, unknown>,
): DiagnosticSourceError {
  return new DiagnosticSourceError({ code, message, severity: 'error', ...(context === undefined ? {} : { context }) });
}

function diagnosticErrorItem(code: WtmErrorCode, message: string): WtmError {
  return { code, message, severity: 'error' };
}

function toDiagnosticError(
  error: unknown,
  command: string,
  workspaceId?: string,
): WtmError {
  const stored = typeof error === 'object' && error !== null
    ? diagnosticSourceItems.get(error)
    : undefined;
  if (stored === undefined) {
    return {
      code: 'GIT_REPOSITORY_DEGRADED',
      message: 'Diagnostic data source failed.',
      severity: 'error',
      context: {
        command,
        ...(workspaceId === undefined ? {} : { workspaceId }),
      },
    };
  }
  const safeItem = normalizeExplicitError(stored);
  const sourceContext = safeItem.context ?? {};
  return {
    ...safeItem,
    context: {
      ...sourceContext,
      command,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    },
  };
}

export const emptyDiagnosticDataSource: DiagnosticDataSource = {
  listRegisteredWorkspaces: async () => [],
  readStatus: unavailable,
  readDoctor: unavailable,
  readExplain: unavailable,
  readPlan: unavailable,
  readEnv: unavailable,
  readPorts: unavailable,
};

async function unavailable(): Promise<never> {
  throw diagnosticError('WTM_DAEMON_UNAVAILABLE', 'No diagnostic data source is configured.');
}

const sensitiveKeyFragments = [
  'token', 'password', 'passwd', 'secret', 'apikey', 'privatekey', 'authorization',
  'auth', 'cookie', 'credential', 'accesskey', 'bearer', 'sessionid', 'jwt',
];
const maxContextDepth = 6;
const maxContextEntries = 32;
const maxContextStringLength = 1024;

function normalizeExplicitError(item: WtmError): WtmError {
  const code = wtmErrorCodeSchema.safeParse(item?.code);
  if (!code.success || typeof item?.message !== 'string' || item.message.length === 0) {
    return {
      code: 'ADAPTER_INVALID_RESPONSE',
      message: 'Diagnostic data source returned an invalid response.',
      severity: 'error',
    };
  }
  const severity = item.severity === 'info' || item.severity === 'warning' || item.severity === 'error'
    ? item.severity
    : 'error';
  const context = sanitizeContext(item.context);
  const remediation = sanitizeRemediation(item.remediation);
  return {
    code: code.data,
    message: boundedString(item.message),
    severity,
    ...(Object.keys(context).length === 0 ? {} : { context }),
    ...(remediation.length === 0 ? {} : { remediation }),
  };
}

function invalidDiagnosticItem(): WtmError {
  return {
    code: 'ADAPTER_INVALID_RESPONSE',
    message: 'Diagnostic data source returned an invalid response.',
    severity: 'error',
  };
}

function freezeWtmError(item: WtmError): WtmError {
  freezeObject(item.context);
  freezeObject(item.remediation);
  return Object.freeze(item);
}

function freezeObject(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) freezeObject(descriptor.value, seen);
  }
  Object.freeze(value);
}

function sanitizeContext(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeValue(value, 0, new WeakSet());
  return isPlainRecord(sanitized) ? sanitized : {};
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return boundedString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return '[Circular]';
  if (depth >= maxContextDepth) return '[Truncated]';
  seen.add(value);

  if (Array.isArray(value)) {
    const output: unknown[] = [];
    const length = Math.min(value.length, maxContextEntries);
    for (let index = 0; index < length; index += 1) {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      } catch {
        output.push('[Unserializable]');
        continue;
      }
      if (descriptor === undefined || !('value' in descriptor)) continue;
      const child = sanitizeValue(descriptor.value, depth + 1, seen);
      if (child !== undefined) output.push(child);
    }
    if (value.length > maxContextEntries) output.push('[Truncated]');
    return output;
  }

  let descriptors: Record<string, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return '[Unserializable]';
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const keys = Object.keys(descriptors).sort(codeUnitCompare);
  for (const key of keys.slice(0, maxContextEntries)) {
    const safeKey = boundedString(key);
    if (isSensitiveKey(key)) {
      output[safeKey] = '[REDACTED]';
      continue;
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor)) continue;
    const child = sanitizeValue(descriptor.value, depth + 1, seen);
    if (child !== undefined) output[safeKey] = child;
  }
  if (keys.length > maxContextEntries) output.truncated = true;
  return output;
}

function sanitizeRemediation(value: WtmError['remediation']): NonNullable<WtmError['remediation']> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((item) => {
    if (
      typeof item !== 'object'
      || item === null
      || item.kind !== 'command-suggestion'
      || !Array.isArray(item.argv)
      || item.argv.length === 0
      || !item.argv.every((argument) => typeof argument === 'string')
    ) return [];
    return [{ kind: 'command-suggestion' as const, argv: item.argv.slice(0, 32).map(boundedString) }];
  });
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return sensitiveKeyFragments.some((fragment) => normalized.includes(fragment));
}

function boundedString(value: string): string {
  return value.length <= maxContextStringLength
    ? value
    : `${value.slice(0, maxContextStringLength)}[Truncated]`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
