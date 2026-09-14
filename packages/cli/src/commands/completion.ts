import type { WtmError } from '@wtm/protocol';

export const SUPPORTED_SHELLS = ['bash', 'zsh', 'fish'] as const;
export type SupportedShell = (typeof SUPPORTED_SHELLS)[number];

export const SUPPORTED_COMPLETION_KINDS = ['tasks', 'worktrees', 'repos', 'repo-names'] as const;
export type CompletionDataKind = (typeof SUPPORTED_COMPLETION_KINDS)[number];

/**
 * Top-level commands whose first positional argument is a task name, a worktree selector, or a
 * repository/workspace selector — the three dynamic vocabularies `wtm __complete` can enumerate.
 *
 * This is domain knowledge Commander does not expose (it knows an argument is named `<task>`,
 * not what kind of thing fills it), so it is declared once here and read by all three shell
 * templates, rather than repeated per shell where the copies could drift apart from each other.
 */
const taskArgumentCommands = ['resolve', 'run', 'start', 'restart', 'stop', 'logs'] as const;
const worktreeSelectorCommands = ['analyze', 'remove'] as const;
const repoSelectorCommands = ['forget'] as const;

/**
 * The seven task commands that accept `--worktree`/`--repo` (item 47) — a superset of
 * `taskArgumentCommands` because `exec` takes raw argv, not a task name, but still resolves its
 * target through the same two flags. Declared separately so flag-value completion (this array)
 * and task-name completion (`taskArgumentCommands`) can differ without one silently drifting to
 * match the other.
 */
const targetFlagCommands = ['resolve', 'run', 'start', 'restart', 'stop', 'logs', 'exec'] as const;

export interface CompletionScriptRequest {
  shell: string;
  binaryName: string;
  /**
   * Every top-level command WTM currently registers, read live from the running CLI's own
   * `Command` tree rather than copied here, so a command added to `main.ts` reaches the
   * generated script without a second place having to remember it.
   */
  commands: readonly string[];
}

export type CompletionScriptResult =
  | { ok: true; script: string }
  | { ok: false; error: WtmError };

export function renderCompletionScript(request: CompletionScriptRequest): CompletionScriptResult {
  const commands = [...new Set(request.commands)].sort(compareNames);
  const bin = request.binaryName;
  switch (request.shell) {
    case 'bash': return { ok: true, script: bashScript(bin, commands) };
    case 'zsh': return { ok: true, script: zshScript(bin, commands) };
    case 'fish': return { ok: true, script: fishScript(bin, commands) };
    default: return { ok: false, error: unsupportedShellError(request.shell) };
  }
}

export function validateCompletionKind(
  kind: string,
): { ok: true; kind: CompletionDataKind } | { ok: false; error: WtmError } {
  if ((SUPPORTED_COMPLETION_KINDS as readonly string[]).includes(kind)) {
    return { ok: true, kind: kind as CompletionDataKind };
  }
  return { ok: false, error: unsupportedCompletionKindError(kind) };
}

function unsupportedShellError(shell: string): WtmError {
  return {
    code: 'WTM_CONFIG_INVALID',
    message: `Unsupported shell: ${JSON.stringify(shell)}. WTM completion supports `
      + `${SUPPORTED_SHELLS.join(', ')}.`,
    severity: 'error',
    context: { shell },
  };
}

function unsupportedCompletionKindError(kind: string): WtmError {
  return {
    code: 'WTM_CONFIG_INVALID',
    message: `Unsupported completion data kind: ${JSON.stringify(kind)}. `
      + `WTM supports ${SUPPORTED_COMPLETION_KINDS.join(', ')}.`,
    severity: 'error',
    context: { kind },
  };
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function present(commands: readonly string[], candidates: readonly string[]): string[] {
  const known = new Set(commands);
  return candidates.filter((name) => known.has(name));
}

function bashScript(bin: string, commands: readonly string[]): string {
  const taskCommands = present(commands, taskArgumentCommands);
  const worktreeCommands = present(commands, worktreeSelectorCommands);
  const repoCommands = present(commands, repoSelectorCommands);
  const targetCommands = present(commands, targetFlagCommands);
  const flagValueCompletion = targetCommands.length === 0 ? '' : `  local prev="\${COMP_WORDS[COMP_CWORD-1]}"
  case "$prev" in
    --worktree) COMPREPLY=( $(compgen -W "$(${bin} __complete worktrees 2>/dev/null)" -- "$cur") ); return 0 ;;
    --repo) COMPREPLY=( $(compgen -W "$(${bin} __complete repo-names 2>/dev/null)" -- "$cur") ); return 0 ;;
  esac
  local target=() i
  for (( i=2; i<cword; i++ )); do
    case "\${words[i]}" in
      --worktree|--repo) target+=("\${words[i]}" "\${words[i+1]}") ;;
    esac
  done
`;
  const taskArmBody = targetCommands.length === 0
    ? `COMPREPLY=( $(compgen -W "$(${bin} __complete tasks 2>/dev/null)" -- "$cur") )`
    : `COMPREPLY=( $(compgen -W "$(${bin} __complete tasks "\${target[@]}" 2>/dev/null)" -- "$cur") )`;
  return `# ${bin} bash completion
# Install with: ${bin} completion bash > /path/to/completions && source /path/to/completions
# or: source <(${bin} completion bash)
_${bin}_completion() {
  local cur words cword
  cur="\${COMP_WORDS[COMP_CWORD]}"
  words=("\${COMP_WORDS[@]}")
  cword=$COMP_CWORD
${flagValueCompletion}  COMPREPLY=()

  if [[ $cword -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${commands.join(' ')}" -- "$cur") )
    return 0
  fi

  case "\${words[1]}" in
    ${caseArm(taskCommands, taskArmBody)}
    ${caseArm(worktreeCommands, `COMPREPLY=( $(compgen -W "$(${bin} __complete worktrees 2>/dev/null)" -- "$cur") )`)}
    ${caseArm(repoCommands, `COMPREPLY=( $(compgen -W "$(${bin} __complete repos 2>/dev/null)" -- "$cur") )`)}
    *)
      COMPREPLY=( $(compgen -f -- "$cur") )
      ;;
  esac
  return 0
}
complete -F _${bin}_completion ${bin}
`;
}

function caseArm(names: readonly string[], body: string): string {
  if (names.length === 0) return '';
  return `${names.join('|')})
      ${body}
      ;;
`;
}

function zshScript(bin: string, commands: readonly string[]): string {
  const taskCommands = present(commands, taskArgumentCommands);
  const worktreeCommands = present(commands, worktreeSelectorCommands);
  const repoCommands = present(commands, repoSelectorCommands);
  const targetCommands = present(commands, targetFlagCommands);
  const flagValueCompletion = targetCommands.length === 0 ? '' : `  case "\${words[CURRENT-1]}" in
    --worktree) dynamic=(\${(f)"$(${bin} __complete worktrees 2>/dev/null)"}); _describe 'worktree' dynamic; return ;;
    --repo) dynamic=(\${(f)"$(${bin} __complete repo-names 2>/dev/null)"}); _describe 'repository' dynamic; return ;;
  esac
  local -a target
  local i
  for (( i=3; i<CURRENT; i++ )); do
    case "\${words[i]}" in
      --worktree|--repo) target+=("\${words[i]}" "\${words[i+1]}") ;;
    esac
  done
`;
  const taskArm = targetCommands.length === 0
    ? `dynamic=(\${(f)"$(${bin} __complete tasks 2>/dev/null)"})
      _describe 'task' dynamic
      ;;
`
    : `dynamic=(\${(f)"$(${bin} __complete tasks \${target[@]} 2>/dev/null)"})
      _describe 'task' dynamic
      ;;
`;
  return `#compdef ${bin}
# ${bin} zsh completion
# Install with: ${bin} completion zsh > /path/to/_${bin} (on your $fpath)
# or: source <(${bin} completion zsh)
_${bin}() {
  local -a commands
  commands=(${commands.join(' ')})

  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi

  local -a dynamic
${flagValueCompletion}  case "\${words[2]}" in
    ${taskCaseArm(taskCommands, taskArm)}
    ${zshCaseArm(worktreeCommands, 'worktrees', 'worktree')}
    ${zshCaseArm(repoCommands, 'repos', 'repository')}
    *)
      _files
      ;;
  esac
}
compdef _${bin} ${bin}
`;

  function taskCaseArm(names: readonly string[], body: string): string {
    if (names.length === 0) return '';
    return `${names.join('|')})
      ${body}`;
  }

  function zshCaseArm(names: readonly string[], kind: string, label: string): string {
    if (names.length === 0) return '';
    return `${names.join('|')})
      dynamic=(\${(f)"$(${bin} __complete ${kind} 2>/dev/null)"})
      _describe '${label}' dynamic
      ;;
`;
  }
}

function fishScript(bin: string, commands: readonly string[]): string {
  const taskCommands = present(commands, taskArgumentCommands);
  const worktreeCommands = present(commands, worktreeSelectorCommands);
  const repoCommands = present(commands, repoSelectorCommands);
  const targetCommands = present(commands, targetFlagCommands);
  const lines = [
    `# ${bin} fish completion`,
    `# Install with: ${bin} completion fish > ~/.config/fish/completions/${bin}.fish`,
    `set -l __${bin}_commands ${commands.join(' ')}`,
    '',
    `complete -c ${bin} -f`,
    `complete -c ${bin} -n "not __fish_seen_subcommand_from $__${bin}_commands" -a "$__${bin}_commands"`,
    '',
    `function __${bin}_complete_tasks
    set -l tokens (commandline -opc)
    set -l target
    for i in (seq (count $tokens))
        if contains -- $tokens[$i] --worktree --repo; and test $i -lt (count $tokens)
            set -a target $tokens[$i] $tokens[(math $i + 1)]
        end
    end
    ${bin} __complete tasks $target 2>/dev/null
end`,
    `function __${bin}_complete_worktrees; ${bin} __complete worktrees 2>/dev/null; end`,
    `function __${bin}_complete_repos; ${bin} __complete repos 2>/dev/null; end`,
    `function __${bin}_complete_repo_names; ${bin} __complete repo-names 2>/dev/null; end`,
    '',
  ];
  if (taskCommands.length > 0) {
    lines.push(`complete -c ${bin} -n "__fish_seen_subcommand_from ${taskCommands.join(' ')}" `
      + `-a "(__${bin}_complete_tasks)"`);
  }
  if (worktreeCommands.length > 0) {
    lines.push(`complete -c ${bin} -n "__fish_seen_subcommand_from ${worktreeCommands.join(' ')}" `
      + `-a "(__${bin}_complete_worktrees)"`);
  }
  if (repoCommands.length > 0) {
    lines.push(`complete -c ${bin} -n "__fish_seen_subcommand_from ${repoCommands.join(' ')}" `
      + `-a "(__${bin}_complete_repos)"`);
  }
  if (targetCommands.length > 0) {
    lines.push(`complete -c ${bin} -n "__fish_seen_subcommand_from ${targetCommands.join(' ')}" `
      + `-l worktree -r -a "(__${bin}_complete_worktrees)"`);
    lines.push(`complete -c ${bin} -n "__fish_seen_subcommand_from ${targetCommands.join(' ')}" `
      + `-l repo -r -a "(__${bin}_complete_repo_names)"`);
  }
  return `${lines.join('\n')}\n`;
}
