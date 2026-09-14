# Worktree selector for task commands (todo item 47)

## Status

Design approved in conversation on 2026-09-14, section by section. Not implemented.

## Problem

`wtm run`, `start`, `stop`, `restart`, `logs` and `exec` act only on the worktree that contains the
current directory. Reaching another feature means `cd`, which is fragile for an agent or a
multi-feature session: every command needs a directory change, and the change leaks into the rest
of the session.

Two worktree selectors exist today and disagree:

| | `remove` (`commands/remove.ts`, `resolveExplicitSelector`) | `analyze` (`main.ts`, `resolveAnalysisSelector`) |
| --- | --- | --- |
| Path | absolute, or relative to the worktree containing `cwd`, compared after `realpath` | relative to the worktree containing `cwd`, no `realpath` |
| Directory name | yes | no |
| Branch (`feat/x`, `refs/heads/feat/x`) | yes | yes |
| Registered number | yes (`runProductionRemove`, `numericSelectorPath`), in the repository containing `cwd` | yes, in the repository containing `cwd` |
| Several matches | `WorktreeSelectorError` | silently the first |

(Both call the worktree containing `cwd` the "repository"; `docs/04` documents a relative path as
"relative to the current repository".)

From a multi-repository workspace root, without a selector, the commands fail with misleading
messages: foreground `run` says "cd into one of its repositories", the daemon-backed commands say
"Run `wtm init`" although the workspace is registered. Both use `WTM_WORKSPACE_NOT_FOUND`.

## Decisions (approved)

1. The repository is named with `--repo <name>`, not a `<repo>:<selector>` form. Adapters already
   produce task names containing `:` (`make:build`), and one grammar is simpler than two.
2. One selector replaces both existing ones, accepting the union of forms and refusing every
   ambiguity. The bit-for-bit requirement in `todo.md` is relaxed for the four changes listed
   under *Deliberate behaviour changes*.

## Design

### 1. The CLI resolves; the daemon is unchanged

With `--worktree <selector>`, the CLI resolves the selector to one worktree root and sends that
root in the `cwd` field of the request it already sends. Nothing else in the request changes.

This is equivalent to having `cd`'d there:

- the daemon's `ProductionRuntimeResolver` (`packages/daemon/src/runtime-factory.ts`) maps `cwd` to
  the innermost registered worktree for `start`, `stop`, `restart`, `logs` and `exec`;
- `exec` already runs at the worktree root whatever `cwd` was (`resolveExec` returns
  `registration.worktree.path`);
- foreground `run` and `run --enqueue` take the same `cwd`.

The IPC protocol and the daemon do not change. Without `--worktree`, every command behaves exactly
as today (except the workspace-root message in §4).

`--repo` without `--worktree` is refused with `WTM_CONFIG_INVALID`.

### 2. One selector: `packages/cli/src/worktree-selector.ts`

`remove`, `analyze` and the six task commands call one function. `resolveExplicitSelector` and
`resolveAnalysisSelector` are deleted.

Accepted forms, all tried at once against every candidate worktree:

- a path, absolute, or relative to the worktree containing `cwd` (as documented today), or relative
  to `cwd` itself when `cwd` is inside no worktree (a workspace root); compared after `realpath`;
- the worktree directory's name (`basename`);
- a branch, short (`feat/auth`) or full (`refs/heads/feat/auth`);
- a registered numeric id (`13`).

Rules:

- Exactly one matching worktree is the result. Zero, or more than one, is an error (§5). There is
  no precedence: a directory named `13` and a different worktree numbered 13 is an ambiguity.
- One worktree matching through several forms counts once.
- Bare worktrees are never candidates.
- A numeric id needs registration. Without a state store a number matches nothing through the id
  form; the other forms work from Git topology alone, as `remove` does today.

### 3. Which repositories are searched

1. With `--repo <name>`: only that repository. The name follows `wtm create --repos`: a
   `[repos.<name>]` entry, otherwise the main root's directory name
   (`resolveFeatureMembers`, `packages/core/src/analysis/create-feature.ts`). An unknown or
   ambiguous name is `WTM_CONFIG_INVALID`, as it is for `create`.
2. Without `--repo`, when `cwd` is inside a repository: only that repository (today's `analyze`
   behaviour).
3. Otherwise (a workspace root): every repository of the registered workspace containing `cwd`.
   The same branch in two repositories is an ambiguity whose remediation names `--repo`.

`--repo` needs a registered workspace; without one it is `WTM_WORKSPACE_NOT_FOUND` (the existing
not-initialized error).

The identity `wtm create` returns is directly usable: `branch.name` and `worktree.path` (per
member for `--repos`) are valid `--worktree` values, with `--repo` when the branch exists in
several repositories.

### 4. A workspace root without `--worktree`

The code stays `WTM_WORKSPACE_NOT_FOUND`; only the message, `context` and remediation change.

The CLI checks before sending anything to the daemon: when `cwd` is inside a registered workspace
but inside none of its worktrees, and `--worktree` is absent, the six commands fail with

- message: "This is a workspace root, not a worktree. Name the target with `--worktree <selector>`.";
- `context.candidates`: the workspace's worktrees as `{ repo, branch, path, numericId }`, so an
  agent can pick one;
- remediation argv: the invoked command with `--worktree <selector>` added.

When no registered workspace contains `cwd`, today's messages are unchanged. A single-repository
workspace whose root is the main worktree is never in this state.

### 5. Selector errors

Code `WTM_WORKSPACE_NOT_FOUND`, as `WorktreeSelectorError` uses today.

- No match: `context` is `{ selector, repositories, matches: [] }`, the message lists the four
  accepted forms.
- Several matches: `context.matches` is `[{ repo, branch, path, numericId? }]`.
  - Matches in different repositories: one remediation per repository, the command with
    `--repo <name>` added.
  - Matches in one repository: the remediation asks for the selector as a path.
- `remove`'s existing fields stay: `repoPath` and `selector`. `matches` becomes the array above; the
  count moves to `matchCount`. This is a documented `docs/18` schema change.

### 6. Shell completion

In `packages/cli/src/commands/completion.ts`, for bash, zsh and fish:

- after `--worktree` on `run`, `start`, `stop`, `restart`, `logs`, `exec`: `wtm __complete worktrees`;
- after `--repo` on those commands: a new `wtm __complete repo-names`. The existing `repos` kind
  keeps listing workspace names for `forget`;
- `__complete worktrees` from a workspace root lists every repository's worktrees, following §3;
- task-name completion honours `--worktree`/`--repo` already on the line
  (`wtm start --worktree feat/auth <TAB>` lists that worktree's tasks) and falls back to `cwd`.

No flag value is completed today, so each script gains a flag-value branch; the completion script
snapshots change.

### 7. Deliberate behaviour changes

1. `analyze <selector>` refuses an ambiguous selector instead of taking the first match.
2. `analyze` accepts a directory name.
3. `analyze` compares paths after `realpath`, as `remove` does, so a symlinked spelling matches.
4. A number and a directory name that name different worktrees are an ambiguity for both commands.
   Today `remove` treats an all-digit selector only as a number.

Every selector that resolves to exactly one worktree today resolves to the same worktree after,
except the collision in 4.

(Correction, 2026-09-14, while planning: the approved section listed "`remove` starts accepting a
number" and "`analyze` resolves relative paths against `cwd`". Reading `runProductionRemove`
showed `remove` already accepts numbers, and both commands already resolve relative paths against
the worktree containing `cwd`, which `docs/04` documents. The design keeps the documented base and
drops both changes.)

## Documentation

- `docs/04-cli-reference.md`: `--worktree` and `--repo` on all six commands; the shared grammar and
  the four changes under `analyze` and `remove`.
- `docs/18-errors-json-contract.md`: the `context` of §4 and §5, including `matchCount`.
- `docs/11-ai-first-skill-integration.md` and `skills/wtm/SKILL.md`: the `cd`-free flow is the
  recommended path for agents.
- `CHANGELOG.md` (`Added`, `Changed`) and `todo.md` item 47.

## Testing

- Selector unit tests, table-driven: each form; directory name vs number collision; one worktree
  through two forms; bare worktree excluded; number without a store; the three scopes of §3;
  unknown and ambiguous `--repo`.
- Regression for `remove` and `analyze`: every selector that resolves uniquely today resolves to
  the same worktree; one test per deliberate change.
- `packages/cli/src/__tests__/main.test.ts`: on each of the six commands the selector is resolved
  and forwarded as `cwd`; `--repo` alone is refused.
- A real Git scenario under `runScenario`, in the style of `create-feature.scenario.ts`: a
  two-repository workspace registered by `wtm init`, the same branch created in both with
  `wtm create --repos`. From the workspace root, `start`, `stop`, `restart`, `logs`, `exec` and
  `run --enqueue` send the intended worktree root as `cwd` to a recording runtime client, and
  foreground `wtm resolve` (the same resolution `run` uses) reports that worktree; ambiguity without
  `--repo` fails; no `--worktree` gives the §4 error.

  (Correction, 2026-09-14, while planning: the approved section named a real daemon driven through
  `dist/cli/bin.js`. No CLI scenario starts a real daemon, and this design changes nothing on the
  daemon side of the request, whose `cwd` handling existing daemon tests cover. The recording client
  proves the one thing that changes.)
- Completion: script snapshots and the new `__complete` behaviour
  (`completion.test.ts`, `completion-production.scenario.ts`).
