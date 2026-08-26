# Testing, Performance and Security

## Testing layers

### Unit tests

Cover pure logic:

- TOML merge precedence;
- template resolution;
- worktree porcelain parser;
- safety classification;
- remote-persisted commit logic;
- endpoint allocation;
- plan merge/conflict detection;
- error JSON serialization.

### Git integration tests

Create temporary repositories and actual Git worktrees. Test:

- existing worktrees at init;
- worktree add/remove through raw Git;
- detached HEAD;
- locked worktree;
- dirty/untracked worktree;
- ahead-of-upstream branch;
- no-upstream branch;
- remote-persisted branch;
- prunable metadata;
- worktree repair scenarios where feasible.

Tests use local bare repositories as remotes and never need network access.

### Daemon integration tests

Use temporary paths/socket/state DB:

- event schedules reconciliation;
- daemon restart recovers worktrees;
- adapter failure is isolated;
- managed process survives CLI exit;
- stop kills the process group but not unrelated PIDs;
- socket permissions are user-only.

### End-to-end tests

Run CLI against a fixture workspace containing:

- workspace Makefile;
- one JS repo;
- one Rust or Go repo;
- linked worktrees;
- mock adapters.

Validate human and JSON commands.

## Safety tests for removal

Every blocker must have a test proving `wtm remove` exits nonzero and leaves the worktree intact.

Required blocker fixtures:

```text
staged change
unstaged change
untracked file
merge conflict
local-only commit
missing upstream with local-only commit
detached local-only commit
locked worktree
main worktree
```

A separate fixture proves a clean, remote-persisted linked worktree is removable.

## GC security tests

Attempt malicious/invalid adapter cleanup plans targeting:

```text
/
$HOME
.git
tracked source file
symlink escaping resource root
another worktree's resource
```

Core must reject every action.

## Adapter trust tests

- repository-local adapter is not run before trust;
- trusted hash works;
- changed binary invalidates trust;
- stdout malformed JSON fails safely;
- adapter timeout does not block daemon.

## Performance benchmarks

Release gate on representative Apple Silicon:

### Idle

```text
CPU p95 < 0.2%
RSS target < 60 MiB
RSS > 80 MiB requires investigation before release
```

### Scale

Fixture:

```text
10 repositories
100 known worktrees
3 running managed tasks
```

Targets:

- `wtm status --global --json` warm response < 500 ms;
- single-repo reconciliation < 250 ms excluding Git pathological cases;
- ordinary source edit does not spawn ecosystem adapters;
- worktree creation event detected/reconciled promptly without source-tree polling.

These are project acceptance targets, not contractual public API latencies.

## Security model

### Trusted input

- user global config;
- explicitly initialized workspace config (commands can execute code by design);
- built-in adapters.

### Conditional trust

- repo-local executable adapters require trust.

### Untrusted data

- Git branch names;
- paths;
- adapter JSON until schema validated;
- remote names;
- process IDs read from stale state.

All values entering shell execution use argv arrays by default. Shell strings require `shell = true` so risk is explicit.

## Symlink/path safety

Before file deletion/materialization:

- canonicalize path;
- ensure policy permits target root;
- reject traversal outside owned roots;
- never follow an unexpected symlink into protected locations during recursive deletion;
- verify tracked-file guard for repo-local deletion.

## Network behavior

Core commands do not silently fetch/push. Network-affecting Git commands must be explicit.

## Rust escalation gate

A native Rust helper is introduced only when:

1. a reproducible benchmark fails a release budget;
2. Node/TS profiling identifies the exact bottleneck;
3. ordinary TypeScript/Node optimization cannot meet the target;
4. the helper can be isolated behind a narrow interface and tested independently.
