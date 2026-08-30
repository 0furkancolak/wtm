# Reference Configurations

## 1. Workspace Makefile with worktree-numbered dev commands

```toml
version = 1

[workspace]
name = "workspace"

[prepare]
mode = "lazy"

[ports]
strategy = "stable-dynamic"
# The band has to contain every preferred port below.
range = "3000-4999"

[ports.web]
preferred = 3000

[ports.api]
preferred = 4000

[environment]
WEB_PORT = "{port.web}"
API_PORT = "{port.api}"
WTM_ID = "{id}"

[tasks.dev]
expose = true
main = ["make", "dev"]
worktree = ["make", "dev-with-worktree-{id}"]
cwd = "{workspace.root}"
background = true
singleton = true

[tasks.test]
expose = true
run = ["make", "test"]
cwd = "{workspace.root}"
```

## 2. Next.js + API + Docker Compose

```toml
version = 1

[workspace]
name = "product"

[ports]
range = "3000-4999"

[ports.web]
preferred = 3000

[ports.api]
preferred = 4000

[environment]
PORT = "{port.web}"
API_PORT = "{port.api}"
NEXT_PUBLIC_API_URL = "http://localhost:{port.api}"
COMPOSE_PROJECT_NAME = "{workspace.name}-{repo.name}-wt{id}"

[resources.env]
path = ".env"
policy = "symlink"
source = "{main.root}/.env"
optional = true

[tasks.dev]
expose = true
run = ["make", "dev"]
cwd = "{worktree.root}"
background = true

[tasks.compose-up]
run = ["docker", "compose", "up", "-d"]
cwd = "{worktree.root}"

[tasks.compose-down]
run = ["docker", "compose", "down"]
cwd = "{worktree.root}"
```

## 3. Python/uv

```toml
version = 1

[workspace]
name = "python-platform"

[capabilities]
"python.environment-manager" = "uv"

[tasks.dev]
expose = true
run = ["uv", "run", "uvicorn", "app.main:app", "--port", "{port.api}"]
cwd = "{worktree.root}"
background = true
requires = ["deps.ready"]

[ports]
range = "8000-8999"

[ports.api]
preferred = 8000
```

The uv adapter keeps `.venv` worktree-local and uses uv's native cache strategy.

## 4. Rust service

```toml
version = 1

[workspace]
name = "rust-services"

[tasks.dev]
expose = true
run = ["cargo", "run"]
cwd = "{worktree.root}"
background = true
requires = ["deps.ready"]

[tasks.test]
expose = true
run = ["cargo", "test"]
cwd = "{worktree.root}"
```

Cargo registry/git cache is shared naturally; `target/` remains isolated by adapter policy.

## 5. Polyglot monorepo

```toml
version = 1

[workspace]
name = "platform"

[ports]
range = "3000-8999"

[ports.web]
preferred = 3000

[ports.api]
preferred = 8080

[tasks.dev]
expose = true
run = ["make", "dev", "WTM_ID={id}"]
cwd = "{workspace.root}"
background = true

[tasks."search.test"]
run = ["go", "test", "./..."]
cwd = "{worktree.root}/services/search"

[capabilities]
"python.environment-manager" = "uv"
```

V1 has no per-repository override table in workspace `wtm.toml`. A repository that needs its own tasks or capabilities carries them in its own `.wtm.toml`.

## 6. Global-only registration

For a third-party repo where no WTM files should be created:

```bash
cd ~/src/third-party
wtm init --global --yes
```

User-level configuration can then be edited through WTM config commands without modifying the repository.
