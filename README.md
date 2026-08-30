# WTM — Worktree Runtime Manager

**Run many Git worktrees at once, on macOS, without port collisions, `.env` copying, or losing uncommitted work.**

WTM is a local-first runtime and safety manager for Git worktrees. It discovers your
repositories and linked worktrees, resolves per-worktree tasks and environments, supervises
long-running processes, allocates endpoints, and refuses unsafe worktree removal.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](#requirements)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-green.svg)](#requirements)
[![JSON output](https://img.shields.io/badge/output-stable%20JSON-orange.svg)](#json-output-for-scripts-and-agents)

Powered by [nafru.com](https://nafru.com).

---

## Why WTM

Working on three branches at once used to mean three copies of a repository, three sets of
ports picked by hand, three `.env` files kept in sync, and a lingering fear of running
`git worktree remove` on the one that still had uncommitted work.

Git worktrees solve the checkout problem. They do not solve the *runtime* problem:

| Problem | What WTM does |
| --- | --- |
| Two worktrees both want port 3000 | Allocates and persists an endpoint per worktree |
| `.env` copied by hand into every worktree | Resolves a shared config into a per-worktree environment delta |
| A workspace `Makefile` is invisible from a nested worktree | Detects it and exposes each target as a task |
| The web app needs the API's port, and it moves per branch | Allocates one endpoint set per feature, shared by every repository on that branch |
| Every branch needs its own CORS allowlist written by hand | Reads the variable your `.env.example` declares and fills it in |
| Which `next dev` belongs to which branch? | Supervises processes, attributes them, and streams their logs |
| `worktree remove` can destroy unpushed work | Analyzes safety first and refuses when work would be lost |
| An AI agent rediscovers your project every session | Ships an Agent Skill and stable `--json` output for every command |

WTM does not replace Git, Make, Bun, npm, pnpm, uv, Cargo, Go, or Docker. It is a
context-aware orchestration layer around them.

## Table of contents

- [Install](#install)
- [Quick start](#quick-start)
- [How to use WTM](#how-to-use-wtm)
  - [1. Initialize a workspace](#1-initialize-a-workspace)
  - [2. See where you are](#2-see-where-you-are)
  - [3. Define or inherit tasks](#3-define-or-inherit-tasks)
  - [4. Run a task in the foreground](#4-run-a-task-in-the-foreground)
  - [5. Supervise a long-running task](#5-supervise-a-long-running-task)
  - [6. Remove a worktree safely](#6-remove-a-worktree-safely)
  - [7. Reclaim disk](#7-reclaim-disk)
- [Makefile support](#makefile-support)
- [Ports and CORS](#ports-and-cors)
- [Detection](#detection)
- [Configuration](#configuration)
- [The daemon](#the-daemon)
- [JSON output for scripts and agents](#json-output-for-scripts-and-agents)
- [Command reference](#command-reference)
- [Make targets for this repository](#make-targets-for-this-repository)
- [What V1 does and does not answer](#what-v1-does-and-does-not-answer)
- [Requirements](#requirements)
- [Uninstall](#uninstall)
- [Development](#development)
- [Documentation](#documentation)
- [License](#license)

## Install

### From source, today (recommended while pre-release)

Requires [Bun](https://bun.sh) 1.3+ and Node.js 24+ to build. The result is a single
standalone executable that needs neither afterwards.

```bash
git clone https://github.com/0furkancolak/wtm.git && cd wtm && make install
```

`make install` builds the executable, installs it into `~/.local/bin`, and registers the
per-user daemon. For a shared prefix:

```bash
sudo make install PREFIX=/usr/local
```

To install the binary alone and leave launchd untouched:

```bash
make install WITH_DAEMON=0
```

### Homebrew (after a release is published)

```bash
brew tap 0furkancolak/wtm && brew install 0furkancolak/wtm/wtm
```

### Direct macOS binary (after a release is published)

Select the archive matching your architecture, verify it against `SHA256SUMS`, then extract:

```bash
case "$(uname -m)" in
  arm64) archive=wtm-darwin-arm64.tar.gz ;;
  x86_64) archive=wtm-darwin-x64.tar.gz ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac
curl -LO "https://github.com/0furkancolak/wtm/releases/download/v<VERSION>/$archive"
curl -LO https://github.com/0furkancolak/wtm/releases/download/v<VERSION>/SHA256SUMS
shasum -a 256 -c --ignore-missing SHA256SUMS
tar -xzf "$archive"
```

### npm (Node.js 24+, after a release is published)

```bash
npm install --global worktree-runtime-manager
```

The npm package carries no runtime of its own and uses the Node.js you already have. The
standalone executable embeds one, which is why it is roughly 97 MB on disk.

## Quick start

```bash
cd /path/to/your/workspace
wtm init --yes
wtm status
wtm resolve dev
wtm start dev
wtm logs dev --follow
wtm stop dev
```

## How to use WTM

### 1. Initialize a workspace

Run this once, at the root of the directory that holds your repositories:

```bash
wtm init --yes
```

`init` walks the tree (five levels deep by default), records every repository and linked
worktree it finds, and writes a `wtm.toml` next to itself. It registers the workspace in
WTM's own state under `~/Library/Application Support/WTM`; nothing outside that directory
and the `wtm.toml` is modified.

A workspace root need not itself be a Git repository. A directory holding ten sibling
repositories, each with its own worktrees, is a valid workspace.

It also *reads* those repositories, and writes what it finds into the `wtm.toml` as
configuration you can edit — see [Detection](#detection). Pass `--no-detect` to skip that and
get a file with nothing but a name and a version.

### 2. See where you are

```bash
wtm status
```

`status` answers "which worktree am I in, what is running here, and on which ports". Add a
selector to ask about another worktree, or `--global` to aggregate every registered
workspace.

```bash
wtm analyze
```

`analyze` reports the safety picture for the current worktree: staged, unstaged, untracked
and unmerged counts, the upstream relationship, and whether removal would lose work.

### 3. Define or inherit tasks

A task is a named command WTM can resolve, run, and supervise. Tasks come from two places:

**Your `wtm.toml`:**

```toml
version = 1

[tasks.dev]
run = ["bun", "run", "dev"]
cwd = "{worktree.root}"
background = true

[tasks.test]
run = ["bun", "test"]
```

**Adapters, automatically.** If your project already describes its commands somewhere WTM
understands — a `Makefile`, a `docker-compose.yml` — those become tasks without being
written twice. See [Makefile support](#makefile-support). Anything `wtm.toml` names always
wins over an adapter of the same name.

Templates such as `{worktree.root}`, `{branch}`, `{id}`, `{slug}`, and `{port.<name>}`
resolve per worktree, which is what keeps two branches from fighting over the same directory
or port. `wtm.toml` is read from the workspace root, so one file covers every repository
under it.

### 4. Run a task in the foreground

```bash
wtm resolve test    # show the exact argv, cwd, and environment delta — run nothing
wtm run test        # run it in the foreground, streaming its output
```

`resolve` before `run` is the habit worth forming: it shows precisely what will execute,
which is far easier to reason about than a failure after the fact.

### 5. Supervise a long-running task

Background tasks need the daemon (see [The daemon](#the-daemon)).

```bash
wtm start dev              # start it under supervision
wtm ps                     # list every WTM-managed process group
wtm logs dev --follow      # tail its rotating logs
wtm restart dev            # stop and start it safely
wtm stop dev               # stop it; `wtm stop` with no task stops all
```

Each supervised task runs inside its own process group behind an anchor process, so
stopping a task stops everything it spawned rather than leaving orphans behind.

### 6. Remove a worktree safely

```bash
wtm analyze feature-branch   # what would be lost?
wtm remove feature-branch    # refuses if the answer is "something"
```

`remove` will not delete a worktree with uncommitted changes or unpushed commits. That is
the point of it existing rather than typing `git worktree remove`.

### 7. Reclaim disk

```bash
wtm disk        # logical and allocated usage per resource
wtm gc          # plan the collection
wtm gc --apply  # carry it out
```

## Makefile support

Many projects already keep their commands in a `Makefile`. WTM reads it and offers every
target as a task, so you do not describe the same commands twice.

Given this `Makefile`:

```make
dev: ## Start the dev server
	bun run dev

test:
	bun test
```

WTM offers:

| Task | Runs |
| --- | --- |
| `make` | `make` (the default goal) |
| `make:dev` | `make dev` — described as "Start the dev server" |
| `make:test` | `make test` |

```bash
wtm resolve make:dev
wtm start make:dev
```

A workspace root holding several repositories usually keeps the commands that span them in a
`Makefile` of its own. Those targets are offered too, under their own namespace and running
at the root:

| Task | Runs | Where |
| --- | --- | --- |
| `make:dev` | `make dev` | this worktree |
| `workspace:up` | `make up` | the workspace root |

The namespaces are separate because the work is: a repository's own `dev` is not the root's.

The Makefile is **parsed, never evaluated**. WTM does not run `make -p` to enumerate
targets, because that would execute the `$(shell …)` expansions of a repository it has not
been told to trust. Pattern rules (`%.o:`), variable targets (`$(BINARY):`), assignments,
`define` blocks, and the dot-prefixed special targets are all skipped; `GNUmakefile`,
`makefile`, and `Makefile` are read in the order GNU make itself reads them.

Every task WTM can see, whichever adapter contributed it, is visible with:

```bash
wtm resolve <task>   # exactly what one of them would run
```

## Ports and CORS

Two branches cannot both listen on 3000, and the port a branch does get is of no use to the
rest of the stack unless they are told about it. Declare the endpoints once:

```toml
[ports]
range = "4100-4199"

[ports.api]
preferred = 4100

[ports.web]
preferred = 4150

[repos.api]
path = "api"

[repos.api.environment]
PORT = "{port.api}"

[repos.web]
path = "web"

[repos.web.environment]
PORT = "{port.web}"
API_URL = "http://localhost:{port.api}"
```

WTM then allocates a port per endpoint, per **feature** — where a feature is a branch,
across every repository that has it checked out. Working on `feat/login` in both `api/` and
`web/` gives you:

| Worktree | `PORT` | `{port.api}` | `API_URL` |
| --- | --- | --- | --- |
| `api-feat` (`feat/login`) | 4100 | 4100 | — |
| `web-feat` (`feat/login`) | 4150 | 4100 | `http://localhost:4100` |
| `api` (`main`) | 4101 | 4101 | — |
| `web` (`main`) | 4151 | 4101 | `http://localhost:4101` |

That is what lets the web app reach the API of *its own* feature. Both repositories read
`PORT` and each one means its own endpoint, which is what `[repos.<name>.environment]` is
for: a workspace-wide `[environment]` cannot say two things about one variable.

`preferred` is the port tried first, so the main worktree keeps the port your team already
types; it has to fall inside `[ports].range`, and WTM says so plainly rather than quietly
handing out something else. Ports are leased and persisted, so they survive restarts; a port
something else has taken is stepped over. `strategy = "fixed"` with a `port` opts an endpoint
out of allocation entirely, and `origin = false` marks one that no browser talks to.

### CORS, without writing it out per branch

An API whose port moves per feature needs an allowlist that moves with it. `{cors.origins}`
is every origin the feature runs on, across the repositories that share its branch:

```toml
[repos.api.environment]
CORS_ORIGINS = "{cors.origins}"
```

```bash
$ wtm resolve make:dev
CORS_ORIGINS=http://localhost:4100,http://localhost:4150
```

`wtm init` writes that line for you when the repository declares the variable in
`.env.example`, `.env.sample`, `.env.template`, `.env.defaults`, or `.env` — see
[Detection](#detection). Left unconfigured, WTM looks for it at run time instead:

```toml
[cors]
enabled = true                        # false stops the search; the variables above still work
env = ["MY_ORIGINS"]                  # look for these instead of what the repository declares
origins = ["https://staging.example"] # allow these as well as the feature's own
```

`CORS_ORIGIN`, `CORS_ORIGINS`, `CORS_ALLOWED_ORIGINS`, `ALLOWED_ORIGINS` and the same
spellings behind a project prefix are recognized. Only the variable *names* are read — never
a value, because a real `.env` holds credentials.

Anything `[environment]` sets by hand always wins over what WTM worked out, and
`[repos.<name>.environment]` wins over that.

## Detection

A workspace already says what it needs: `.env.example` names the port variable, `package.json`
names the dev server's port, `compose.yaml` publishes ports and points one service at another.
WTM reads all of it — and then **writes it into `wtm.toml`**, because configuration you cannot
read is configuration you cannot correct.

```bash
wtm init --yes        # detect, and write it into the wtm.toml it creates
wtm detect            # report what the repositories declare now
wtm detect --write    # append the tables wtm.toml does not have yet
```

Given `api/.env.example` with `PORT=4000` and `CORS_ORIGINS=`, and `web/.env.example` with
`PORT=5173` and `VITE_API_URL=http://localhost:4000/api`, `wtm init` writes:

```toml
[ports]
range = "4000-5373"

# api/.env.example: PORT=
[ports.api]
preferred = 4000

# web/.env.example: PORT=
[ports.web]
preferred = 5173

[repos.api]
path = "api"

[repos.api.environment]
PORT = "{port.api}"
CORS_ORIGINS = "{cors.origins}"

[repos.web]
path = "web"

[repos.web.environment]
PORT = "{port.web}"
# web/.env.example: VITE_API_URL= points at api
VITE_API_URL = "http://localhost:{port.api}/api"
```

`VITE_API_URL` named port 4000, which is the port the API repository asks for — so the two are
connected, and the address is rewritten against `{port.api}`. A compose file connects them the
same way, by service name (`http://api:4000`). When nothing but the variable's own name
suggests a target, the line is written with a comment saying it was a guess.

What is read, and what is not:

| Read | For |
| --- | --- |
| `.env.example`, `.env.sample`, `.env.template`, `.env.defaults` | Variable names, and values that are a port or a loopback/service URL |
| `.env` | Variable names only |
| `package.json` | `scripts.dev`/`start`/`serve` port flags, workspace layout |
| `compose.yaml` / `docker-compose.yml` | Published ports, and URL-valued `environment` entries |
| `Makefile` | A `PORT = …` assignment |

No other value ever leaves those files. A value that is not a port or a bare `http(s)` address
is dropped at the reader, query strings included — `DATABASE_URL`, `JWT_SECRET`, and an API key
in an example file never reach a report, a log, or your `wtm.toml`.

`wtm init` never edits a `wtm.toml` it did not write, and `wtm detect --write` only appends
tables the file does not already define. Anything already decided is reported and left alone.

## Configuration

## Configuration

`wtm.toml` lives at the workspace root — the directory `wtm init` was run in, which in a
multi-repository setup is above all of them. A user-level
`~/Library/Application Support/WTM/config.toml` is merged underneath it, and a repository may
override anything in its own `.wtm.toml`.

```toml
version = 1

[environment]
DATABASE_URL = "postgres://localhost/app_{slug}"

[ports]
strategy = "stable-dynamic"
range = "3000-3999"

[ports.web]
preferred = 3000

[repos.web]
path = "web"

[repos.web.environment]
PORT = "{port.web}"

[cors]
enabled = true

[tasks.dev]
run = ["bun", "run", "dev"]
cwd = "{worktree.root}"
background = true
singleton = true

[tasks.migrate]
run = ["bun", "run", "db:migrate"]
```

Copyable configurations for common stacks live in [examples/](examples/README.md):
[minimal](examples/minimal), [multi-repo](examples/multi-repo),
[bun-monorepo](examples/bun-monorepo), [docker-compose](examples/docker-compose), and
[polyglot](examples/polyglot). The full
schema is in [docs/03-configuration-spec.md](docs/03-configuration-spec.md).

## The daemon

Background supervision (`start`, `stop`, `restart`, `ps`, `logs`) needs a per-user daemon
registered as a macOS LaunchAgent. `make install` registers it for you.

```bash
wtm daemon install     # register the LaunchAgent
wtm daemon status      # is it registered and reachable?
wtm daemon uninstall   # remove it
```

Foreground commands — `status`, `analyze`, `resolve`, `run`, `exec`, `init` — work without
it. Installing WTM never starts your tasks; only `wtm start` does.

## JSON output for scripts and agents

Every command accepts `--json` and answers with the same envelope:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "resolve",
  "data": { "argv": ["make", "test"], "cwd": "/path/to/worktree" },
  "warnings": [],
  "errors": []
}
```

`ok` is the single field to branch on; `errors[].code` is stable and documented in
[docs/18-errors-json-contract.md](docs/18-errors-json-contract.md). Attribution and human
formatting never leak into JSON or into a task's own output streams.

WTM ships an Agent Skill so a coding agent can use all of this without being taught:

```bash
wtm skill --install
```

## Command reference

| Command | What it answers |
| --- | --- |
| `wtm init [path]` | Register this workspace and discover its repositories |
| `wtm detect [path]` | What the repositories declare, and the TOML that says it |
| `wtm status [selector]` | Identity, state, endpoints, processes, resources |
| `wtm analyze [selector]` | Would removing this worktree lose work? |
| `wtm remove <selector>` | Remove a linked worktree, refusing when unsafe |
| `wtm resolve <task>` | The exact argv, cwd, and environment for a task |
| `wtm run <task>` | Run a task in the foreground |
| `wtm start/stop/restart <task>` | Supervise a task in the background |
| `wtm ps` | Every WTM-managed process group |
| `wtm logs [task] --follow` | Rotating per-task logs |
| `wtm exec <argv...>` | Raw argv in the resolved environment |
| `wtm disk` / `wtm gc` | Resource usage and safe collection |
| `wtm daemon <action>` | Register, inspect, or remove the LaunchAgent |
| `wtm adapter <action>` | Manage trusted external adapters |
| `wtm skill` | Print or install the Agent Skill |
| `wtm doctor` | Deterministic workspace diagnostics |

Full detail: [docs/04-cli-reference.md](docs/04-cli-reference.md).

## Make targets for this repository

`make` on its own lists everything:

| Target | What it does |
| --- | --- |
| `make install` | Build, install to `~/.local/bin`, register the daemon |
| `make reinstall` | Rebuild and reinstall |
| `make uninstall` | Unregister the daemon and remove the executable |
| `make purge` | Uninstall, then delete this user's WTM state |
| `make where` | Which `wtm` is on PATH, its version, the daemon |
| `make check` | Lint, typecheck, unit suites |
| `make verify` | The full release gate |
| `make clean` | Remove build output |

Override the prefix with `PREFIX=…`, and skip daemon registration with `WITH_DAEMON=0`.

## What V1 does and does not answer

WTM is pre-release and honest about its edges. Every command carries a real payload, and
`wtm doctor` answers every check it declares. What remains is scope rather than absence:

- `explain` reports the configuration in force, so it resolves the way a task would, endpoint
  leases included. `plan` never allocates, and never creates a resource.
- `[events.*]` runs a workspace's own tasks. A task an event starts never sets off further
  events, and an event that describes something happening once — a worktree discovered, a
  repository registered — is announced once and recorded, so restarting the daemon does not
  install your dependencies again. An installation that predates event dispatch announces
  `workspace.discovered` and `repo.discovered` once, on the daemon's next pass.
- `wtm gc` never collects the files `[resources]` creates inside a worktree, and says so:
  garbage collection may not walk a Git working tree. `wtm disk` counts them, so the number is
  the whole number. Removing the worktree removes them.
- External adapters are a defined protocol with a trust store; only the built-in adapters ship
  in this version.

## Requirements

- **macOS** for the LaunchAgent-managed daemon
- **Node.js 24+** for the npm installation (the standalone executable embeds its own)
- **Bun 1.3+** to build from source and to run the tests

## Uninstall

```bash
make uninstall   # unregister the daemon, remove the executable
make purge       # the above, plus this user's WTM state and configuration
```

By hand, if you installed some other way:

```bash
wtm daemon uninstall
rm -f "$(command -v wtm)"
rm -rf "$HOME/Library/Application Support/WTM"
```

Removing WTM never touches your repositories or worktrees.

## Development

```bash
bun install --frozen-lockfile
make check      # lint, typecheck, unit suites
make e2e        # end-to-end workflow suite
make verify     # the whole release gate
```

Every routine action has a `make` target; `make help` lists them. Contribution guidance is
in [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [Full documentation](docs/README.md) — architecture, configuration, safety, CLI
- [Configuration examples](examples/README.md)
- [Error and JSON contract](docs/18-errors-json-contract.md)
- [Security policy](SECURITY.md)
- [WTM Agent Skill](skills/wtm/SKILL.md)

WTM has no required account, no cloud control plane, no default telemetry, and no implicit
fetch or push behaviour.

## License

Apache License 2.0. See [LICENSE](LICENSE).
