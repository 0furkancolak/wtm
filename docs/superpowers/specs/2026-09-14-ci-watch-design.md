# CI watch for agents (todo item 54)

## Status

Design approved in conversation on 2026-09-14, section by section. Not implemented.

Depends on item 47 (`--worktree` / `--repo` and the shared worktree selector, PR #9).

## Problem

Agents stop developing to wait for CI after a push or a pull request, and each check costs a
round of `gh pr checks`, `gh run view` and `gh run view --log-failed` calls and their tokens. Item
53 added skill guidance to keep working; this item gives the guidance a WTM-native mechanism: WTM
follows the CI of a commit in the background and keeps the result, including a short summary of
failed jobs, ready for one cheap local read.

## Decisions (approved)

1. **Delivery is a `wtm` command only.** `wtm ci status --json` returns the result. WTM installs no
   hook into Claude Code, Codex or any other agent host. `todo.md` item 54 named host hooks as one
   option; they are dropped: hooks cannot push into a conversation on their own, writing another
   tool's settings needs its own consent and ownership design, and the skill already teaches agents
   to check at work boundaries.
2. **Watching starts only with an explicit command,** `wtm ci watch`. There is no automatic watch
   on push and no configuration switch. Network access therefore starts only when an agent or user
   asks for it (the explicit-network rule of `docs/14` and `packages/core/src/analysis/remote-persistence.ts`).
3. **The result carries the run status, every job and a bounded failed-job log summary.** An agent
   does not fetch logs itself.
4. **The daemon owns the watch** and writes to the state store; `wtm ci status` reads the store and
   never touches the network.

## Design

### 1. Commands

`wtm ci watch [--worktree <selector>] [--repo <name>] [--pr <number>] --json`

- The CLI resolves the target worktree with the item 47 selector (the worktree containing `cwd`
  without `--worktree`; the workspace-root refusal applies), reads its branch and HEAD commit from
  local Git, and derives the provider repository (§3). None of this touches the network.
- It sends `ci.watch { worktreePath, branch, headSha, pr? }` to the daemon and returns immediately
  with the watch: `{ watchId, repo, branch, headSha, pr?, state: 'pending' }`. It never waits for CI.
- Before accepting, the daemon checks once that `gh` exists and is authenticated for the host
  (`gh auth status --hostname <host>`). Failure is `WTM_CI_UNAVAILABLE` (§5).
- Watching the same worktree again: the same `headSha` returns the existing watch (idempotent); a
  different `headSha` closes the older pending watch of that worktree as `superseded` and starts a
  new one.

`wtm ci status [--worktree <selector>] [--repo <name>] [--all] --json`

- Reads the state store only.
- Default: the latest watch of the target worktree. `--all`: the latest watch of every worktree in
  the workspace containing `cwd`.
- A worktree with no watch returns `data.watch: null`, not an error.
- `data.watch`: `{ watchId, repo, branch, headSha, pr?, state, startedAt, updatedAt, finishedAt?,
  runs: [{ runId, workflow, event, status, conclusion, url, jobs: [{ jobId, name, conclusion, url,
  logSummary? }] }], detail? }`.
- `state` is one of `pending`, `success`, `failure`, `cancelled`, `timed_out`, `no_runs`,
  `superseded`, `unavailable`. `success` needs every run concluded successfully (skipped and
  neutral count as success); any failed or timed-out run makes `failure`; otherwise a cancelled run
  makes `cancelled`.
- `detail` explains `unavailable`, `timed_out` and `no_runs` in one sentence.

`wtm ci unwatch [--worktree <selector>] [--repo <name>] --json` stops a pending watch of the target
worktree and marks it `cancelled`; with no pending watch it succeeds with `data.stopped: false`.

The three commands take `--worktree` and `--repo` with item 47's rules and completions.

### 2. The daemon watcher

- **What is watched:** every workflow run of `headSha` in the provider repository, whatever its
  event. A push and a pull request on one commit produce two runs; both count. `--pr` is recorded
  for display and for `status` filtering; the commit is the key.
- **Polling:** `gh run list --repo <host/owner/repo> --commit <sha> --json
  databaseId,workflowName,event,status,conclusion,url` and, for runs that are not complete, their
  jobs (`gh run view <id> --repo … --json jobs`). The first poll runs 15 s after the watch starts;
  the interval grows by 1.5× up to 2 min and resets to 15 s when any run or job changes state.
- **Budgets:** at most 20 pending watches (a 21st `ci watch` is refused with
  `WTM_CI_UNAVAILABLE`, remediation `wtm ci unwatch`); at most 30 `gh` invocations per minute across
  all watches, excess polls wait for the next slot; a `gh` rate-limit or HTTP 5xx answer delays that
  watch by the current interval ×2 (capped at 10 min) without failing it.
- **Ends:** when every run is complete (state from §1); `no_runs` when no run exists 3 min after the
  watch started; `timed_out` 2 h after the watch started; `unavailable` when `gh` stops being
  authenticated or the repository is no longer reachable (three consecutive such failures).
- **Failed job logs:** once per failed job, when its run completes:
  `gh run view <runId> --repo … --job <jobId> --log-failed`. Each output line has the form
  `<job name>\t<step name>\t<ISO timestamp> <text>`; the summary keeps only `<text>`. It is built as:
  every line containing `##[error]` together with the 20 lines before it, plus every line matching a
  test-runner failure marker (`(fail)`, `FAIL `, `✗`, `error:`), in log order, overlapping windows
  merged and gaps shown as `…`; when the log has no such line, the last 40 lines. ANSI sequences
  removed, secrets masked (§4), capped at 8 KiB keeping the end, stored with the job.

  (Correction, 2026-09-14, while planning: the approved section said "the last 40 lines". A real
  `--log-failed` output of this repository's CI (3000 lines, the step name `UNKNOWN STEP`) ends with
  40 lines of post-job cleanup, while the actual failure sits at line 1559 behind `##[error]`. The
  error-anchored summary keeps the intent — a short, useful failure excerpt — and the last 40 lines
  stay as the fallback.)
- **Restart:** pending watches are stored; a starting daemon resumes them with the first poll after
  15 s. A watch whose deadline passed while the daemon was down ends `timed_out`.
- **Idle cost:** no timer exists while no watch is pending (goal G5, `docs/01`).

### 3. Provider and repository identity

- GitHub only in this item. The provider interface (`CiProvider`: `checkAvailable`, `listRuns`,
  `listJobs`, `failedJobLog`) is provider-neutral so a GitLab provider can be added later; core does
  not depend on GitHub (item 13's rule).
- The repository comes from the repository's `origin` remote (`remote_identity`): HTTPS
  (`https://github.com/owner/repo(.git)`), SSH (`git@github.com:owner/repo(.git)`,
  `ssh://git@host/owner/repo`) and GitHub Enterprise hosts, passed to `gh` as `host/owner/repo`.
- Which host counts as GitHub: `github.com`, and any host for which `gh auth status --hostname
  <host>` succeeds. Any other remote, or no remote, is `WTM_CI_UNAVAILABLE` with
  `context.remote` and the message "No CI provider for this remote."

### 4. Security, privacy and retention

- WTM stores and reads no tokens. `gh` authenticates; the daemon runs it with the user's
  environment, without a shell, with argv only, and with a 30 s timeout per invocation.
- Only a watch started by `wtm ci watch` makes network calls. `ci status`, `status`, `doctor` and
  every other command stay local.
- Log summaries keep GitHub's own `***` masking and additionally mask `ghp_`, `gho_`, `ghu_`, `ghs_`,
  `ghr_` and `github_pat_` tokens, `AKIA[0-9A-Z]{16}`, `Bearer <token>` and
  `-----BEGIN … PRIVATE KEY-----` blocks as `[masked]`.
- The results live in the user's private state database, like every other WTM state.
- Retention: finished watches are deleted 7 days after `finishedAt`; `wtm remove` deletes the
  removed worktree's watches; `superseded` watches are deleted with their worktree's next finished
  watch.

### 5. Errors

One new code: `WTM_CI_UNAVAILABLE`, severity error, operational exit class (1).

| Situation | `context` | Remediation |
| --- | --- | --- |
| `gh` not found | `{ provider: 'github' }` | none; the message names the GitHub CLI install page |
| `gh` not authenticated for the host | `{ provider: 'github', host }` | `gh auth login --hostname <host>` |
| Remote not supported, or no remote | `{ remote }` | none |
| 20 watches pending | `{ pending: 20 }` | `wtm ci unwatch --worktree <selector>` |

Worktree selection failures are item 47's (`WTM_WORKSPACE_NOT_FOUND`, `WTM_CONFIG_INVALID`); a
missing daemon is the existing daemon error. A watch that becomes unavailable later is reported by
`ci status` as `state: 'unavailable'` with `detail`, not as a command error.

### 6. Layers and storage

- `packages/protocol`: `ci.watch`, `ci.status`, `ci.unwatch` request and response schemas; the
  watch schema of §1.
- `packages/core`: the provider-neutral `CiProvider` interface and the pure parts — remote URL →
  provider repository, run and job aggregation into a state, log summarising and masking, the
  polling schedule as a pure function of time and state. No GitHub-specific code, no subprocess, no
  `process.platform`.
- `packages/daemon/src/ci/`: the GitHub provider, which implements `CiProvider` by running `gh`
  through an injectable command runner (the `ServiceCommandRunner` shape of
  `packages/platform/src/service/types.ts`), so tests substitute a fake executor.
  (`packages/adapters` holds project-type adapters such as npm and make, not external services.)
- `packages/daemon`: the watcher (scheduling, budgets, restart, retention) on the daemon's injectable
  clock.
- `packages/cli`: the three commands, `--worktree`/`--repo`, completion.
- Store: migration `015-ci-watches.sql` with `ci_watches` (id, repository_id, worktree_id, branch,
  head_sha, pr, state, detail, started_at, updated_at, finished_at, next_poll_at, poll_interval_ms,
  failure_streak) and `ci_runs` (watch_id, run_id, workflow, event, status, conclusion, url,
  jobs_json with each job's log summary).

## Skill

`skills/wtm/SKILL.md`, section "Waiting on CI and other slow external checks":

- After a push or opening a PR: run `wtm ci watch --json` once (`--worktree <branch>` for another
  worktree), then move to the next independent piece of work.
- Check `wtm ci status --json` once at each work boundary. It replaces `gh pr checks`, `gh run view`
  and `gh run view --log-failed`; the failed job's log summary is in the result.
- `pending`: keep working. `failure`: read `jobs[].logSummary`, fix, push, `wtm ci watch` again.
  `unavailable`: follow `remediation`, or tell the user when `gh` is missing.
- When the check is the only thing left, report it and end the turn. Never wait inside a tool call.
- The command map lists `ci watch`, `ci status`, `ci unwatch`; the 24 KiB budget holds.

## Documentation

- `docs/04-cli-reference.md`: the `ci` command group.
- `docs/18-errors-json-contract.md`: `WTM_CI_UNAVAILABLE` and the `ci status` data schema.
- `docs/11-ai-first-skill-integration.md`: the agent flow; remove "WTM does not yet follow CI itself".
- `docs/14-testing-performance-security.md`: `ci watch` is an explicit network operation, alongside
  the existing rule that network-affecting Git commands are explicit; CI tests use a fake `gh` and
  never need network access; no timer runs while no watch is pending.
- `CHANGELOG.md` and `todo.md` item 54, with a note that delivery is command-only and why.

## Testing

- **Core, pure:** remote URL table (HTTPS, SSH, `ssh://`, Enterprise, `.git` suffix, GitLab, none);
  run and job aggregation into each state; log summary (prefix stripping, `##[error]` windows of 20
  lines merged when overlapping, test-runner failure markers, the 40-line fallback without any
  marker, ANSI removal, the 8 KiB cap keeping the end, every mask pattern), with a trimmed fixture
  taken from a real `--log-failed` output whose failure is far from the end; polling schedule (15 s, ×1.5, 2 min cap, reset on change, rate-limit delay).
- **Provider:** a fake `gh` executor returning recorded JSON and logs; argv shapes; timeouts;
  rate-limit and 5xx classification; unauthenticated and missing `gh`. No network.
- **Daemon watcher, fake clock:** push and pull-request runs of one commit aggregated; `no_runs` at
  3 min; `timed_out` at 2 h; `superseded`; 20-watch limit; 30-calls-per-minute budget; restart
  resumes a pending watch and times out an expired one; retention after 7 days; no timer while idle.
- **Store:** migration 015 and the watch and run operations.
- **CLI:** envelopes of the three commands, `WTM_CI_UNAVAILABLE` cases, `--worktree`/`--repo`
  targeting, `data.watch: null`; every test passes explicit temporary state and config paths.
- **Scenario under `runScenario`:** a real Git repository with a GitHub-style `origin`, a fake `gh`
  executable on `PATH` that serves a pending, then failed run with a failed-step log; `wtm ci watch`
  → polls → `wtm ci status` reports `failure` with a masked log summary. State paths in a temporary
  directory; no network.
