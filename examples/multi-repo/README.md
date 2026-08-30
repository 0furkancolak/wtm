# Multi-Repository Example

Copy `wtm.toml` to the directory that holds your repositories — not into one of them. This
example assumes two, `api/` and `web/`, each with its own worktrees.

```bash
cp examples/multi-repo/wtm.toml ./wtm.toml
wtm init --yes
wtm resolve api-dev
```

Endpoints are allocated per **feature**: a branch, across every repository that has it checked
out. `feat/login` in both repositories is one feature, so `{port.api}` means the same port in
both, and the web application reaches the API of its own branch rather than of `main`.

Two repositories both read `PORT`, and each one means its own endpoint — that is what
`[repos.<name>.environment]` is for. An entry names its repository by `path`, relative to the
workspace root.

`{cors.origins}` is every origin the feature runs on, so the API's allowlist follows the ports
it was actually given, on every branch, without being written out per branch.

You do not have to write any of this by hand. `wtm init` reads `.env.example`, `package.json`,
compose files, and `Makefile` in each repository and writes what it finds — including which
variable points at which other repository. Run `wtm detect` after adding a repository.
