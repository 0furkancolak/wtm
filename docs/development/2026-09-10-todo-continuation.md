# TODO continuation — 2026-09-10

Working branch: `codex/todo-safety-docs-parity`; published baseline `f37a160`.
The worktree started clean. Changes in this wave are batched for one branch publication after verification.
No release, merge or PR is authorized. Existing queue and ignored/untracked safety remain.

The three-commit wave was subsequently published at `1956dd5`. Its native CI evidence,
macOS fixture correction and TODO 18 follow-up are recorded in
[`2026-09-10-endpoint-batching.md`](2026-09-10-endpoint-batching.md).
The original local verification ledger below is retained as historical evidence.

## Baseline and native evidence

Run 34366121974 at the published baseline: Linux x64 1525 passed / 0 failed / 14 existing
skips; macOS x64 1529 / 0 / 10, with e2e and binary smoke gates passing on both. macOS ARM64
was cancelled after about 30 minutes, with its last test output in the CLI entrypoint suite;
no child stack proves a root cause. Windows: 1223 passed / 107 failed / 199 skipped.
These baseline outcomes do not validate the new wave.

Four Windows native queue cases failed before queue launch: private-directory validation
passed no pathname to the ACL reader for the opened handle. The fix forwards canonicalPath
and makes the helper's pathname required, preserving identity/ownership checks. Six tests
failed before the fix and pass after it; the ACL port is a fixture, with real filesystem
operations. Another agent reviewed this fix independently without findings. This does not
prove the remaining Windows failures fixed. A source-parent rename scenario also recorded
EPERM on restoration; its fail-closed guard was not weakened.

This container still rejects native Unix socket listen with EPERM, freshly reproduced by
the readiness lifecycle scenario before it launched a managed task. Earlier PID/procfs
namespace inconsistency also prevents treating this as native process proof. TCP loopback
works and supports separate real HTTP/framed IPC tests. Test expectations are not skipped
or relaxed to turn unavailable native evidence into success.

## HTTP readiness implementation

- Shared strict start/restart arguments, HTTP healthcheck template/duration validation and
  readiness result/error vocabulary. Normal start adds NOT_CHECKED without performing HTTP.
- Wait observes the same live process identity and authenticated completion evidence before
  and after a 2xx response. Replacement, terminal state, missing evidence and identity doubt
  fail. Invalid wait configuration is rejected before restart stops an existing service.
- One monotonic observation after launch, maximum five minutes; interval 100ms–30s, default
  500ms; timeout default 30s. No redirect following, body buffering, secrets in errors,
  persisted health monitor or supervisor lifecycle lock held during observation.
- Per-request IPC deadline leaves ordinary five-second requests unchanged. Cancellation is
  scoped to a submitting connection; disconnect aborts observers. Control cancellation can
  pass even when normal request capacity is full. Observation cancellation never stops the
  service. Two independently reviewed P2 transport findings were reproduced and fixed.
- Protocol/config/CLI tests, observer/controller tests and real HTTP + framed TCP IPC tests
  pass, including a 5.5-second delayed endpoint and hanging HTTP cancellation. The separate
  production native process/IPC workflow is included in test:e2e; it fails here at EPERM.

Readiness is evidence at one instant, not future health or proof of exclusive endpoint
ownership. Observer/controller code was reviewed by the integrating root agent. A second
subagent's independent review remains unavailable after both agents hit their usage quota.

## Cleanup disk estimate

Metadata-only walk estimates allocated blocks of regular, single-link files, excluding Git
metadata, symlink targets, mounts and resource paths not owned by removal. Existing safety,
runtime, persistence and activity ranking tiers retain precedence. Partial/unavailable scans
use null; known zero and unknown are distinct. Allocation is not guaranteed freed space:
COW, snapshots, compression and directory/symlink overhead limit interpretation.

One shared cooperative 2s / 20,000-entry budget for all candidates, sequential path order,
depth at most 64. Inode pins and metadata rechecks invalidate detected races; portable
opendir is not an atomic snapshot. A pending OS read cannot be interrupted. No cache, service,
contents read or database migration. The removal policy itself selects retained exclusions.
Root reviewed the implementation; 31 walker/ranking tests and 10 CLI/integration tests passed.
Independent subagent review remains blocked by the usage quota. No removal behavior changed.

## RAM admission implementation

Keep one queue and its atomic SQLite FIFO claim. Add opt-in global jobs.memory with a budget
and headroom for other applications, explicit task memory estimates and optional queue-only
environment settings for the task's own worker controls. Defaults retain concurrency-only
operation. Estimate the entire worker tree; no universal worker flag or hard memory cap is
implied. A missing estimate or one that can never fit is rejected clearly.

Persist the estimate with acceptance and retain its reservation while slotHeld is true,
including uncertain cleanup and restart. Admission compares the configured estimate budget
and a fresh available-memory sample, minus headroom and all held estimates, within the same
claim transaction. Counting held estimates against already available memory is deliberately
conservative to leave space for future worker growth; it may underutilize memory. Memory
sampling failure blocks launches. FIFO does not bypass a memory-blocked head, avoiding
starvation by small followers; cancellation remains available. Changed policy cannot leave
an impossible queued job silently blocking forever. Use memory_budget as the wait reason.

Use Node 24's availableMemory/constrainedMemory and OS total memory, with injectable readers,
no process-tree RSS walk and no additional polling service. Node describes availableMemory
as free memory available to the current process, not a system-enforced budget:
[Node 24 process API](https://nodejs.org/docs/latest-v24.x/api/process.html#processavailablememory).
Native platform budget evidence and real two-AI before/after RAM/swap measurements remain
separate requirements. The existing measurement recipe remains the source for that experiment.

## Verification ledger

- New-wave lint: passed.
- Final lint and typecheck: passed. Fixture typing errors were corrected without changing
  production checks; the repository skill validator also passed.
- Six private-directory regressions: RED 0/6, GREEN 6/0.
- Readiness observer/controller/protocol/transport selected group: 58 passed, 0 failed.
- Real HTTP/TCP IPC + CLI selected group: 8 passed, 0 failed.
- Disk walker/ranking: 31 passed, 0 failed; CLI estimates/ranking: 10 passed, 0 failed.
- Native readiness workflow: failed at Unix socket listen EPERM, before managed launch.
- Full test: 1488 passed, 128 failed, 15 existing skips (1631 cases, 598.35s). One failure
  was a stale CLI fixture treating the now-implemented memory_budget reason as unknown.
  Unknown/contradictory rejection remains tested; memory_budget positive rendering and
  terminal-state contradiction cases were added. Those two tests pass after correction.
- E2E: 0 passed, 3 failed. Registered removal refuses with GIT_REPOSITORY_DEGRADED before
  deletion; queue and readiness workflows cannot publish their native Unix socket.
- Performance: 19 passed, 2 failed. Investigation found a real, pre-existing bad import in
  scripts/performance-report.ts (./packages instead of ../packages). Direct execution proved
  ERR_MODULE_NOT_FOUND. New entrypoint tests failed twice before the fix, then passed twice;
  they use fixture measurements but real imports, report assembly/writes and exit status.
  A rerun of test:perf still has 19/2: native idle startup fails at Unix socket listen, so the
  aggregate report is not produced. This is not a passed performance budget or RAM measurement.
- Package verification: build and npm dry-run passed, 68 packaged files, including migration
  013 and the skill. Static SEA asset tests also prove every canonical migration is included.
- Binary verification: refused the host's Node 24.19.0 because the standalone build requires
  pinned Node 24.18.0. The pin was not bypassed; new native binary smoke evidence is absent.
- Follow-up targeted checks: 28 passed / 0 failed for report entry, portable completion and
  foreground CLI fixtures, documentation parity, SEA assets and memory claims; 3 passed for
  corrected CLI memory vocabulary and conservative held-state filtering.

The full suite ran once; later targeted corrections are listed separately, not subtracted
from its failure count or presented as a second green full run. Native failures include Unix
IPC, process supervision, lease-backed removal/service lifecycle, socket boundaries, and a
permission test requiring a non-root uid. A fresh Node probe observed process.pid=5 but
/proc/self/stat PID=102730 and start=600098, while /proc/5/stat start=365: visibility of the
numeric PID path does not prove it is the child. No identity checks, expectations or gates
were weakened. These constraints do not prove every remaining failure is environment-only;
this exact code still needs native CI and its results must be assessed independently.

No completion percentage represents engineering effort. Checked boxes must match implemented
and observed criteria. Native platform, external publication and real-host measurements are
not inferred from passing injected-port tests.

RAM implementation now includes migration 013, strict global/task config, queue-only worker
environment resolution, production daemon composition, memory_budget diagnostics and two
explicit admission error codes. The same claim transaction prunes permanently unfit queued
requests and reserves estimates. Legacy null estimates are preserved, never fabricated.
27 selected queue/config/state/protocol tests passed, including two independent Node SQLite
claimants; migration preservation and three reader/production-composition checks also passed.
The production composition test uses real config/Git/SQLite, deliberately before starting
native IPC or tasks; it proves wiring and acceptance, not native task execution.
The root implemented/reviewed this slice; independent subagent review remains unavailable.

## Additional review and follow-up

- Root review found that filtering an impossible queued estimate could omit slotHeld=true
  from an inconsistent historical row. A direct SQLite fixture reproduced admission despite
  that unknown reservation (RED), then passed after retaining every held row in the snapshot.
  The fixture is not evidence of a real process stopping.
- Windows logs proved /usr/bin/git ENOENT in completion, production CLI and reconcile
  fixtures. They now resolve Git from PATH; foreground output is produced by Node instead
  of /bin/echo. Assertions still verify actual output/exit/registration. Native Windows
  execution and the unrelated adapter execution/ACL failures remain open.
- Independent review completed for the private-directory change and the root's readiness
  transport/config wiring (two transport findings fixed). The observer/controller and disk
  estimator received integrating-root review; the memory slice received root review. Both
  subagents remain quota-blocked, so these are not substituted for the requested independent
  review. No attempt was made to evade that quota.
- TODO count after this wave: 14/45 numbered headings, 188/359 sub-checkboxes checked,
  five partial sub-checkboxes. These are checklist ratios, not an engineering effort estimate.
  Headings 7, 10 and 50 remain open for their documented proof/review requirements.
- Remaining work includes native Windows/macOS ARM64 and Linux ARM64 proof, real two-AI
  memory/swap measurements, multi-repo create/recovery, batched endpoint probing, symlink
  policy, local domains, PR awareness, idle runtime suspension, TUI, presets and adapter work.
  Signing/notarization, distribution and real registry publication require their separate
  credentials/authorization. Push authorization is not release/merge authorization.
