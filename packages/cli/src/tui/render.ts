import type { TuiViewModel } from './view-model';

/**
 * The pure render step of `wtm tui`: a view model plus a terminal size in, one ANSI frame string
 * out. Nothing here touches `process.stdout`, a timer or a key event — see `loop.ts` for the
 * untestable glue that calls this on a schedule and writes the result.
 */

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

/**
 * One section of the dashboard. Each panel only turns a view model into plain content lines; the
 * frame around it (heading, clipping, footer) is `renderTuiFrame`'s job, so a later unit adds a
 * panel by adding one of these to the list passed to `renderTuiFrame` — the disk-usage /
 * cleanup-candidate view (unit 2) and the log-tail view (unit 3) are meant to arrive exactly this
 * way, without any change to `renderTuiFrame` itself.
 */
export interface TuiPanel {
  readonly id: string;
  readonly title: string;
  lines(model: TuiViewModel): readonly string[];
}

const workspacePanel: TuiPanel = {
  id: 'workspace',
  title: 'Workspace',
  lines(model) {
    if (model.workspace === null) return ['(no registered workspace for this directory)'];
    return [
      `${model.workspace.name}  [${model.workspace.scope}]`,
      model.workspace.root,
    ];
  },
};

const worktreePanel: TuiPanel = {
  id: 'worktree',
  title: 'Worktree',
  lines(model) {
    if (model.worktree === null) return ['(no worktree resolved for this directory)'];
    const branch = model.worktree.branch ?? '(detached HEAD)';
    const role = model.worktree.isMain ? ', main worktree' : '';
    const head = model.worktree.headOid === null ? '(no commit)' : model.worktree.headOid.slice(0, 12);
    return [
      `${branch}${role}  state=${model.worktree.state}`,
      model.worktree.path,
      `head ${head}`,
    ];
  },
};

const processesPanel: TuiPanel = {
  id: 'processes',
  title: 'Running tasks',
  lines(model) {
    if (model.processes.length === 0) return ['(no managed processes recorded for this worktree)'];
    return model.processes.map((process) => {
      const pid = process.pid === null ? '-' : String(process.pid);
      return `${pad(process.task, 18)} ${pad(process.state, 8)} pid=${pid}`;
    });
  },
};

const portsPanel: TuiPanel = {
  id: 'ports',
  title: 'Ports',
  lines(model) {
    if (model.ports.length === 0) return ['(no active endpoint leases)'];
    return model.ports.map((port) =>
      `${pad(port.name, 18)} ${port.host}:${port.port}/${port.protocol}  ${port.state}`);
  },
};

const healthPanel: TuiPanel = {
  id: 'health',
  title: 'Health',
  lines(model) {
    if (model.health.length === 0) return ['(no doctor findings)'];
    return model.health.map((finding) =>
      `${healthGlyph(finding.status)} ${pad(finding.check, 17)} ${finding.message}`);
  },
};

/** The panels unit 1 ships. Disk/cleanup (unit 2) and log tail (unit 3) extend this list. */
export const defaultTuiPanels: readonly TuiPanel[] = [
  workspacePanel, worktreePanel, processesPanel, portsPanel, healthPanel,
];

const minColumns = 20;
const enterAltScreenAndClear = '\x1b[H\x1b[2J';

export function renderTuiFrame(
  model: TuiViewModel,
  size: TerminalSize,
  panels: readonly TuiPanel[] = defaultTuiPanels,
): string {
  const columns = Math.max(minColumns, size.columns);
  const rows = Math.max(1, size.rows);
  const lines: string[] = [];

  lines.push(clip(`wtm tui — refreshed ${model.fetchedAt}`, columns));
  lines.push('');

  for (const panel of panels) {
    lines.push(clip(`== ${panel.title} ==`, columns));
    for (const line of panel.lines(model)) lines.push(clip(line, columns));
    lines.push('');
  }

  const problems = [...model.statusErrors, ...model.doctorErrors];
  if (problems.length > 0) {
    lines.push(clip('== Errors ==', columns));
    for (const error of problems) lines.push(clip(`[${error.code}] ${error.message}`, columns));
    lines.push('');
  }

  lines.push(clip('q / ctrl+c quit   r refresh now', columns));

  return `${enterAltScreenAndClear}${lines.slice(0, rows).join('\r\n')}`;
}

/** A frame drawn when a poll itself throws, so a transient failure never leaves a blank screen. */
export function renderTuiFatalFrame(message: string, size: TerminalSize): string {
  const columns = Math.max(minColumns, size.columns);
  const lines = [
    clip('wtm tui — refresh failed', columns),
    '',
    ...message.split('\n').map((line) => clip(line, columns)),
    '',
    clip('q / ctrl+c quit   r refresh now', columns),
  ];
  return `${enterAltScreenAndClear}${lines.slice(0, Math.max(1, size.rows)).join('\r\n')}`;
}

function healthGlyph(status: string): string {
  if (status === 'pass') return '[ok]';
  if (status === 'warning') return '[!!]';
  if (status === 'error') return '[XX]';
  return '[??]';
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function clip(line: string, columns: number): string {
  return line.length <= columns ? line : `${line.slice(0, Math.max(0, columns - 1))}…`;
}
