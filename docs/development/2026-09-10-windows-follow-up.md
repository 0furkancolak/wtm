# Windows native follow-up — 2026-09-10

The [baseline run](https://github.com/0furkancolak/wtm/actions/runs/34457543774) failed on
Windows x64 with 1327 passed, 115 failed, 200 skips and one between-tests error. Its logs
show 23 `LOG_SETUP_FAILED` starts at the anchor's POSIX directory-mode check. This note
records concrete follow-up work; it does not claim native Windows acceptance.

## Decisions and regressions

- Malformed ACEs must invalidate the complete ACL read instead of disappearing. Owner/current
  SID syntax and control types are checked. Unknown/numeric rights do not prove read-only
  access under the weaker no-write mask. Six behavioral regressions failed before repair.
- PowerShell explicitly reports whether the raw security descriptor has a DACL. A NULL DACL
  and an empty DACL have opposite access meanings; missing/false/invalid evidence is rejected.
  This distinction follows [Microsoft's authorization documentation](https://learn.microsoft.com/en-us/windows/win32/secauthz/null-dacls-and-empty-dacls).
  The parsed policy shape remains unchanged. Existing explicit module import, command bounds,
  trusted SYSTEM/Administrators allowance and hard-link checks remain.
- A custom Windows data root derives a bounded named-pipe name through the same hash as the
  default root. Client and server use the same pipe separators, including when Windows paths
  are inspected from another host. Default POSIX/XDG addresses and explicit overrides retain
  their contracts. Regression tests failed on the old file path and mixed-separator address;
  the complete path/socket group passed 33/0.
- Test homes now isolate USERPROFILE/LOCALAPPDATA/APPDATA as well as HOME/XDG. Real IPC tests
  use Unix sockets or named pipes as appropriate, without substituting TCP or mocked servers.
  Pipe absence requires actual connection refusal; permission errors and timeouts remain
  unknown failures. Home regressions failed 0/2 before repair; home/IPC group then passed 8
  and failed one actual local Unix bind. This container cannot supply native pipe evidence.
- Filesystem fault fixtures now obtain their roots with the same async realpath primitive as
  production and assert that fault injection actually ran. Native short/long-path spelling
  was a hypothesis from earlier Windows failures, not a proven cause. Their local group
  passes 18/0; new native results must determine the effect. No product check was relaxed.
- The log privacy fixture checks real platform ownership/privacy/hard-link policy, retains
  exact POSIX 0600 assertions, and uses path-aware containment. ACL/parser/log regressions
  currently pass 53/0 locally. This does not measure a real Windows ACL.

## Anchor authorization work

The anchor must inspect Windows SID/ACL evidence instead of exact Unix mode bits. Its log
authorization must remain asynchronous and bounded, so deadline and cancellation handling can
run during inspection. New files must remain empty until their own ACL and path/descriptor
identity are verified. Parent identity, symlink/hard-link refusal and serialized rotation
must remain intact. Normal output chunks must not launch PowerShell.

The initial capability/deadline regressions failed 0/3 against the old anchor. The typed log
capability now carries the existing phased rotation algorithm and verifies new empty files before
writing. Independent review found two descriptor ownership-transfer leaks; injected first-stat
and post-rename-stat failures both reproduced them (0/2), then passed after repair. A further
review found that a canceled PowerShell request could return before its child closed; a local
permit now remains held until the close event, even when kill fails. Native process cleanup is
still verified separately by the supervisor before releasing a heavy-job slot.

Review also caught inconsistent archive/path bounds. All three runtime entry points now share
1–32 retained files; default 3 and queued-job override 1 are unchanged. The retained-count
regression failed on the old acceptance of 33, then passed. Maximum normal initial authorization
uses 85 of the 128 allowed paths. Inspection output is capped at 1 MiB with fatal UTF-8 decoding;
requests are capped at 128 paths/64 KiB and 15 seconds. An interrupted operation cannot use late
ACL evidence. There is no cross-operation ACL cache or additional daemon/service.

The combined helper/capability/deadline/batch group passed **22/0** (105 assertions), including
SIGTERM during pending authorization, delayed completion evaluation at timeout, backpressure,
parent/hard-link swaps, exact requested ACL evidence and helper close-before-reuse. Independent
batch/retention re-review is clear. Native PowerShell, actual NTFS access and complete native
process-tree behavior are not established by these portable tests. No native TODO acceptance
checkbox is closed by them.

The final expanded ACL/log/helper group passed **88/0** (326 assertions, seven files). It also
checks the maximum 32-file retention operation, eight persisted rotation phases with exact
byte/generation preservation on reopen, and invalid/ambiguous recovery refusal. The portable
phase fixtures retain the old rotation format; they are not a native Windows filesystem run.

Final lint, full package typecheck and a fresh pinned-Node SEA build passed before the frozen
full suite. That suite finished **1596 passed / 131 failed / 6 existing skips**, 1733 tests in
203 files, 701.55 seconds. The embedded skill test now passes with the rebuilt executable.
The earlier default-IPC test was renamed; the one new failing test exercises real fixture IPC
and fails at local Unix `listen EPERM`. The other 129 failure names are shared with the
pre-Windows follow-up run. This is not a green native acceptance result.

## Next multi-repository slice

Read-only analysis for TODO 6 found existing runtime grouping by workspace/full branch ref;
the missing feature is a persistent creation identity and recovery journal. A multi-repo
creation needs its own durable member stages plus a migration extending repository leases
to create. A creator that dies while Git/hook children may still run cannot safely replay an
`APPLYING` member from HEAD/path equality. Such evidence must remain `NEEDS_REVIEW` until
guarded process completion is available. Draft `--repos`/resume ideas are not registered CLI
commands or published working examples. Native runtime defects take priority over this slice.
