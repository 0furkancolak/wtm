# Multi-Repository Example

Copy `wtm.toml` to the directory that holds your repositories — not into one of them. This
example assumes two, `api/` and `web/`, each with its own worktrees.

```bash
cp examples/multi-repo/wtm.toml ./wtm.toml
wtm init --yes
cd api
wtm resolve api-dev
```

Endpoints are allocated per **feature**: a branch, across every repository that has it checked
out. `feat/login` in both repositories is one feature, so `{port.api}` means the same port in
both. This controls endpoint identity; it does not select or create the checkout a task runs in.
The example's task `cwd` values explicitly use `{workspace.root}/api` and
`{workspace.root}/web`. To run a linked checkout, define the task in that repository with
`cwd = "{worktree.root}"` and invoke it from that checkout. Confirm the directory, argv and
environment with `wtm resolve` before starting the application.

Two repositories both read `PORT`, and each one means its own endpoint — that is what
`[repos.<name>.environment]` is for. An entry names its repository by `path`, relative to the
workspace root.

`{cors.origins}` is every origin the feature runs on, so the API's allowlist follows the ports
it was actually given, on every branch, without being written out per branch.

You do not have to write any of this by hand. `wtm init` reads `.env.example`, `package.json`,
compose files, and `Makefile` in each repository and writes what it finds — including which
variable points at which other repository. Run `wtm detect` after adding a repository.

Run context-dependent commands from a repository, as the `cd api` step does above. The workspace
parent can hold several repositories without being a Git worktree itself. The copy example
uses Bash syntax; in PowerShell use the shell's native file-copy command. These tasks require
`make` and each repository's actual `dev` target on the chosen operating system.
