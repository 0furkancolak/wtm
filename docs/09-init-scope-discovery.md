# Initialization, Scope and Discovery

## `wtm init`

`wtm init` is the primary onboarding command. It must work on an existing development directory without requiring the user to rearrange repositories.

### Flow

1. determine candidate workspace root from explicit path or current directory;
2. scan up to configured depth while excluding known heavy/generated directories;
3. detect `.git` directories and linked-worktree `.git` files;
4. normalize each repository through `git rev-parse --git-common-dir` and `--show-toplevel`;
5. deduplicate linked worktrees back to their common repository;
6. query `git worktree list --porcelain -z` for each unique repo;
7. detect ecosystem/task markers;
8. detect workspace-level Makefile/task files even when they are outside repos;
9. propose workspace name and safe defaults;
10. create `wtm.toml` when absent unless `--global` was requested; use a complete existing file unchanged, or return non-secret generated `requiredChanges` when it requires an update;
11. register workspace in user state;
12. install/update the Agent Skill unless disabled;
13. ask daemon to reconcile/watch the new workspace;
14. output a final `doctor` summary.

## Scan exclusions

Default discovery ignores directories such as:

```text
.git internal object traversal
node_modules
.next
.turbo
.venv
target
dist
build
vendor caches
Library-like generated roots
```

A `.git` directory itself is recognized as a repository marker, but init does not recursively traverse object files.

## Linked worktree detection

A linked worktree may contain a `.git` **file**, not a directory. Init must recognize both.

All worktree topology is normalized through Git commands rather than relying on assumptions about `.git` file content.

## Workspace-level Makefile

Example:

```text
DEV/
├── wtm.toml
├── Makefile
├── repo-a/
├── repo-b/
└── worktrees/
```

WTM can define:

```toml
[tasks.dev]
main = ["make", "dev"]
worktree = ["make", "dev-with-worktree-{id}"]
cwd = "{workspace.root}"
```

Therefore an agent inside `repo-a` or a nested linked worktree can use `wtm start dev` without discovering the parent Makefile itself.

## Local registration

`wtm init` creates/uses workspace `wtm.toml`. It never rewrites an existing file: a complete file is used unchanged, while an incomplete file produces bounded generated `requiredChanges` for explicit user application. Reconstructed configuration and user-authored values are not copied into ordinary error context. The daemon watches this registered workspace only.

## Global-only registration

`wtm init --global /path/to/project` stores the resolved workspace config under the WTM user data directory and does not create project files.

This supports:

- third-party repositories;
- temporary experiments;
- repos where the user does not want WTM config committed.

## `--global` command semantics

For read/maintenance commands:

```bash
wtm status --global
wtm analyze --global
wtm ports --global
wtm plan --global
```

means "operate across registered workspaces".

It never means "find every Git repo on this Mac".

## Repository auto-discovery after init

When a new repository is cloned under a registered workspace, a structural filesystem event schedules discovery. The repository is added to that workspace's known repository set and reconciled.

A new worktree outside the workspace can still be detected when its common Git repository lives inside a watched registered workspace because the Git common directory changes.

## Workspace presets (`--preset`)

`wtm init --preset <name>` seeds a brand-new `wtm.toml` from a fixed, known starter instead of
leaving it as bare name-and-version. Each preset is one file, `examples/<name>/wtm.toml`, read
verbatim so the file on disk and what gets seeded can never drift; only its `[workspace]` name is
rewritten to the real workspace's name. The known names, one per shipped example:

```text
nextjs
nextjs-hono
bun-monorepo
docker-compose
python-uv
rust
go
```

An unknown name is refused with a `WTM_CONFIG_INVALID` error naming every known preset, before
anything is read from disk.

**A preset never replaces detection.** Step 7 above still runs by default, and its result always
wins:

- If detection (unless `--no-detect` was also passed) finds nothing it would write — the same
  situation `--no-detect` addresses on its own — the preset becomes the new file's whole seed.
- If detection *does* find something to declare, `--preset` is refused outright rather than
  silently discarding either side: the error names the conflict
  (`context.conflict: "preset-detection-conflict"`) and says to rerun with
  `--no-detect --preset <name>` to use the preset anyway, or to drop `--preset` and keep what
  detection found.
- If `wtm.toml` already exists, `--preset` has nothing to seed — `wtm init` never edits a file it
  did not write, the same rule detection itself already follows — and the result reports
  `data.preset = { name, applied: false }` with a warning rather than an error, since nothing is
  at risk of being silently discarded.

`data.preset` is `null` when `--preset` was not given.

## Non-interactive AI initialization

```bash
wtm init --yes --json
```

must never silently choose a destructive action. It may accept defaults, write WTM config and register watchers, but does not edit Git history, delete files or rewrite existing task files.
