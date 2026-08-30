# Storage, Cache and Garbage Collection

## Storage constitution

```text
Download once.
Cache globally where the native tool guarantees safety.
Materialize dependency views cheaply.
Build independently.
Run independently.
```

WTM must not reduce isolation merely to make `du` output smaller.

## Core storage policies

```text
shared
native-cache
clone
isolated
symlink
copy
ephemeral
external
ignore
```

## Dependency store vs build output

Examples:

| Ecosystem | Shared/native store/cache | Worktree-local output/view |
|---|---|---|
| Bun | Bun global package cache | node_modules view, `.next`, dist |
| pnpm | content-addressable store | node_modules, build output |
| npm | npm download cache | node_modules, output |
| uv | uv cache | `.venv`, build output |
| Go | GOMODCACHE, GOCACHE | project/runtime output |
| Cargo | Cargo registry/git cache | `target/` |
| Gradle | user/build caches | project `.gradle`, `build/` |
| Maven | `.m2/repository` | `target/` |
| .NET | global NuGet packages | `bin/`, `obj/` |

Adapters own the exact knowledge; the core only understands policies.

## `node_modules`

WTM must not symlink every worktree to the main checkout's `node_modules`. Different branches may use different dependency graphs.

Instead, invoke the native package manager. Bun/pnpm and similar tools can reuse global/content-addressable storage while keeping branch-specific dependency views.

## `.venv`

A Python virtual environment is worktree-specific by default. Native environment managers such as uv can materialize from shared caches efficiently. WTM does not symlink multiple branches to one mutable `.venv`.

## `.next`, `target`, `build`, `dist`

Mutable branch-dependent outputs are isolated by default.

WTM does not share one writable `.next` between worktrees and does not share one writable Cargo `target` directory merely to save space.

## APFS clone policy

Explicit cloneable resources can use Copy-on-Write semantics on APFS.

Good examples:

- seeded SQLite development database;
- large fixture datasets;
- immutable starting asset trees that become independently writable.

Example:

```toml
[resources.seed_db]
path = ".data/dev.sqlite"
policy = "clone"
source = "{main.root}/.data/dev.sqlite"
```

Clone engine behavior:

```text
same clone-capable volume -> clone
clone unavailable         -> configured fallback (copy by default)
```

V1 does not automatically clone framework build directories such as `.next`; stale-cache behavior is not worth making the default unpredictable.

## Lazy materialization

Default:

```toml
[prepare]
mode = "lazy"
```

Worktree creation allocates lightweight identity/env/resource metadata. Dependency materialization happens when the first task requiring `deps.ready` is invoked.

This prevents ten speculative AI worktrees from immediately creating ten dependency/build trees.

`mode = "eager"` moves the same work forward to the moment the daemon learns the worktree exists, for a workspace that would rather pay it up front.

## Worktree-local resources

The files `[resources]` creates inside a worktree are outside every sandbox, deliberately: a Git working tree may never be a resource sandbox, because GC must never walk a repository. They therefore carry no lifecycle record, and `gc` will not collect them at any point. What removes them is removing the worktree.

`wtm disk` still counts them, under `worktree`, so the total is the whole total. A symbolic link counts as the link, not as the file in the main worktree it points at — that file belongs to the main worktree and would otherwise be counted once per branch. `wtm gc` names them in a warning, so that finding nothing to collect is not read as there being nothing else.

## Resource registry

Storage records include:

```text
owner
adapter
name
path
resource type
policy
retention
created_at
last_used_at
last_verified_at
logical size estimate
```

## GC scope

### `wtm gc`

V1 ships a single safe GC mode. It may remove:

- WTM caches;
- expired logs;
- ephemeral resources belonging to already removed worktrees;
- stale state whose external resource is verified absent.

Adapter-declared disposable build outputs and adapter-native dependency cleanup plans are not part of this mode. WTM does not directly delete arbitrary global package-manager caches.

## Plan and apply

`wtm gc` plans by default; `--dry-run` states that default explicitly. `--apply` performs the same guarded plan.

```bash
wtm gc
wtm gc --dry-run
wtm gc --apply
```

Both modes support `--json`.

## Hard deletion safeguards

Declarative WTM cleanup must never delete:

- Git-tracked source files;
- `.git` or Git administrative data;
- workspace root;
- user home/root paths;
- paths outside the resource sandbox unless explicitly classified and trusted.

Before deleting a worktree-local directory, core checks for tracked files using Git. A bad adapter cannot bypass this core rule.

## Disk reporting

APFS clone/COW makes logical size and physical unique bytes different. `wtm disk` must clearly label figures as logical or estimated reclaimable instead of pretending a naive directory sum is exact physical usage.
