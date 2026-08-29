# References

Official references consulted for the design package. These links are implementation references, not copied specifications.

## Git

- Git worktree documentation: https://git-scm.com/docs/git-worktree.html
  - `git worktree list --porcelain -z` is documented as machine-readable/stable output.
  - normal `git worktree remove` removes only clean linked worktrees unless Git's force behavior is explicitly used.
  - worktree lock/prune/repair semantics are defined here.
- Git hooks documentation: https://git-scm.com/docs/githooks
  - `post-checkout` also runs after `git worktree add` unless `--no-checkout` is used.
  - WTM intentionally does not make Git hooks the primary discovery mechanism to avoid hook ownership/conflicts.

## Node.js

- Node.js filesystem API: https://nodejs.org/api/fs.html
  - on macOS, `fs.watch()` uses kqueue for files and FSEvents for directories.
  - the callback filename is not guaranteed, motivating reconcile-from-truth behavior.
- Node.js releases: https://nodejs.org/en/about/previous-releases
  - Node 24 is LTS as of the design date (2026-08-26).
- Node.js child process API: https://nodejs.org/api/child_process.html
  - detached processes on non-Windows systems become leaders of a new process group/session.
- Node.js single executable applications: https://nodejs.org/api/single-executable-applications.html
  - the basis of the shipped standalone macOS channel, which embeds the pinned Node 24 runtime, the SQL migrations and the agent skill.
- Node SQLite API: https://nodejs.org/api/sqlite.html
  - backs the standalone build, so it needs no native addon. `better-sqlite3` backs the npm channel. Both sit behind the same store interface, so core state is coupled to neither.

## Agent Skills / AI

- OpenAI Academy, Using skills: https://openai.com/academy/skills/
- OpenAI Help, Skills in ChatGPT: https://help.openai.com/en/articles/20001066
- OpenAI Codex overview: https://openai.com/codex/

These references describe portable `SKILL.md`-based Agent Skills and support the decision to ship a WTM skill alongside the CLI.

## Notes

Dependency/library versions for implementation should be locked during repository bootstrap and revalidated before public release. Architecture does not depend on a specific minor version of Commander, Zod, smol-toml, `bun test` or better-sqlite3.
