# WTM Examples

These are copyable `wtm.toml` configurations for existing projects, not application starters. Copy the file that fits your repository to its root, then adjust command names, service paths, and ports to match the project.

- [`minimal/wtm.toml`](minimal/wtm.toml) defines one foreground `test` task that runs `npm test`.
- [`bun-monorepo/wtm.toml`](bun-monorepo/wtm.toml) uses Bun, a worktree-local web app, one preferred port declaration, a background `dev` task, and a foreground `test` task. Its `apps/web` directory must exist; configure the application itself to consume its preferred port until WTM port allocation is available to runtime task resolution.
- [`docker-compose/wtm.toml`](docker-compose/wtm.toml) supplies per-worktree Compose names and explicit `compose-up`/`compose-down` tasks. WTM does not start Docker during initialization.
- [`polyglot/wtm.toml`](polyglot/wtm.toml) defines the `js-test`, `python-test`, and `rust-test` tasks for JavaScript, Python/uv, and Rust. Its services live in `services/web`, `services/api`, and `services/worker`.

Validate a copied configuration before starting a task:

```bash
wtm resolve <task>
```

Use the task name provided by the selected example; for example, `wtm resolve python-test` for the polyglot configuration.
