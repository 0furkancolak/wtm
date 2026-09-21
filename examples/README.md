# WTM Examples

These are copyable `wtm.toml` configurations for existing projects, not application starters. Copy the file that fits your repository to its root, then adjust command names, service paths, and ports to match the project.

- [`minimal/wtm.toml`](minimal/wtm.toml) defines one foreground `test` task that runs `npm test`.
- [`bun-monorepo/wtm.toml`](bun-monorepo/wtm.toml) uses Bun, a worktree-local web app, one preferred port declaration, a background `dev` task, and a foreground `test` task. Its `apps/web` directory must exist; map `{port.web}` into the environment variable the application reads, as its README shows.
- [`docker-compose/wtm.toml`](docker-compose/wtm.toml) supplies per-worktree Compose names and explicit `compose-up`/`compose-down` tasks. WTM does not start Docker during initialization.
- [`multi-repo/wtm.toml`](multi-repo/wtm.toml) sits above several repositories rather than inside one. It allocates an endpoint per service per feature, gives each repository its own reading of `PORT`, and fills the API's CORS allowlist from the ports the feature was given. `wtm init` writes a file of this shape for you.
- [`polyglot/wtm.toml`](polyglot/wtm.toml) defines the `js-test`, `python-test`, and `rust-test` tasks for JavaScript, Python/uv, and Rust. Its services live in `services/web`, `services/api`, and `services/worker`.
- [`nextjs/wtm.toml`](nextjs/wtm.toml) reserves a preferred port for a single Next.js app, and defines a background `dev` task running `next dev` plus a foreground `test` task running `npm test`.
- [`nextjs-hono/wtm.toml`](nextjs-hono/wtm.toml) is a Next.js frontend paired with a Hono API in one repository. It reserves one port per service, runs each with its own background task (`dev-web`, `dev-api`) out of `apps/web` and `apps/api`, and runs the whole suite with `bun test`.
- [`python-uv/wtm.toml`](python-uv/wtm.toml) declares `python.environment-manager = "uv"` and defines a background `dev` task and a foreground `test` task, both run through `uv run`.
- [`rust/wtm.toml`](rust/wtm.toml) defines a background `dev` task running `cargo run` and a foreground `test` task running `cargo test`.
- [`go/wtm.toml`](go/wtm.toml) defines a background `dev` task running `go run .` and a foreground `test` task running `go test ./...`.

## Presets

Each of the five entries above that is not `minimal`, `multi-repo`, or `polyglot`, plus `bun-monorepo` and `docker-compose`, doubles as a **preset**: `wtm init --preset <name>` seeds a brand-new `wtm.toml` from exactly the matching file here, with only its `[workspace]` name rewritten to the real workspace. A preset never replaces detection — see [`docs/09-init-scope-discovery.md`](../docs/09-init-scope-discovery.md#workspace-presets---preset) for exactly when it applies.

Validate a copied configuration before starting a task:

```bash
wtm resolve <task>
```

Use the task name provided by the selected example; for example, `wtm resolve python-test` for the polyglot configuration.
