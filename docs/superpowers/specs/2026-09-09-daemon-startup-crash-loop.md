# Item 45 — a daemon that cannot start, forever, quietly

## Status

Implemented — 2026-09-11, on `claude/item-45-daemon-crash-loop` (plan:
`docs/superpowers/plans/2026-09-09-daemon-startup-crash-loop.md`). Drafted 2026-09-09, revised
2026-09-11 (see "Revisions after reading the code"). Covers `todo.md` item 45, which the pre-tag list names alongside item 36 as the
last code work before the next tag. Not part of any increment in
`docs/superpowers/specs/2026-08-31-v1-stable-program-map.md`: it is a field defect found after
Increment B closed, in the same class as items 39, 41 and 43 — a condition WTM diagnoses correctly
inside itself and reports to the user as a shrug.

## Problem, with real evidence

A 0-byte regular file sat at `~/Library/Application Support/WTM/.tmd.sock`. The daemon refused to
start, launchd restarted it, and that repeated for seven days. `daemon.error.log` reached 162 MB.
The user's whole view of this was `reachable: false`.

The report is in `todo.md` item 45. Reading the code for this spec confirmed both defects it names
and turned up two things it did not.

### Defect 1 — a non-socket path gets no recovery, and no advice

`prepareSocketPath` (`packages/platform/src/ipc/unix.ts:295`) carries a complete recovery for a
stale *socket*: ownership check, liveness probe, identity-verified quarantine, unlink. Its first
statement forecloses all of it for anything else:

```ts
if (!initial.isSocket()) throw new Error(`IPC path exists and is not a Unix socket: ${path}`);
```

The message names no remedy, suggests no command, and carries no stable code — so `--json` callers
see a bare `WTM_DAEMON_*` wrapper and a human sees a sentence that does not say the file can simply
be deleted.

### Defect 2 — a permanent failure is retried like a transient one

`darwin.ts:167` writes `KeepAlive{SuccessfulExit:false}` with **no `ThrottleInterval`**, so launchd
applies its 10-second default. 162 MB at ~2.7 KB per attempt is ~60,000 attempts, and 60,000 × 10 s
is 6.9 days — the file size and the calendar agree, which is what makes the count evidence rather
than arithmetic. stderr is wired straight to `daemon.error.log` (`service-lifecycle.ts:336`) with no
rotation and no ceiling.

**New finding: the two platforms already disagree.** `linux.ts:188` sets `Restart=on-failure` and
`RestartSec=1` and states neither `StartLimitIntervalSec` nor `StartLimitBurst`, so the unit
inherits systemd's distro defaults for start rate limiting — which, unlike launchd, stop a unit
that keeps failing. So the same defect is bounded on Linux and unbounded on macOS, by accident, and
on a default this repository does not set. Whatever the fix is, both files must state the policy
rather than inherit one.

### New finding: the origin is inside WTM's own shutdown path

Item 45 records the file's origin as unknown. It is very likely ours.
`closeServerWithPrivatePathShield` (`unix.ts:169`) deliberately creates a **regular file** at a
socket path — `installClosePlaceholder` opens it `wx` at mode 0600 — as a shield so that
`server.close()` cannot unlink a path something else has since taken. A process killed between
installing that placeholder and removing it leaves exactly a 0-byte, 0600, current-user regular
file behind. The observed file was 0 bytes and `-rw-------`.

*Which* path fits too. The first draft of this spec had the derivation backwards. The published
name is `wtmd.sock` (`daemonSocketFileName`). `boundDaemonSocketPath` (`socket-path.ts:54`)
substitutes its first character, so the private bound path is `.tmd.sock`. That is exactly where
the file was found, and it is exactly the path the close shield writes its placeholder to. Three
properties match: the size, the mode and the path. That is still not proof of how the process was
killed, but it leaves no competing explanation.

It settles the design question: **WTM itself creates 0-byte 0600 regular files at the bound socket
path on purpose.** Treating one as an unrecoverable foreign object is the wrong default. The
recovery below is reclaiming our own litter. It also sets the limit on that recovery. The same
placeholder exists for a few milliseconds during every clean shutdown, so a daemon that starts
while another is closing must not reclaim it. See Revision R1.

### New finding: `wtm doctor` cannot answer this even in principle

`state-diagnostics.ts:371`'s `daemonReachable` is a bare `connect()`. That is the right question for
"is it up", and it is structurally incapable of answering "why not": the daemon's reason for dying
exists only in a log the diagnostic never reads, and by then that log is 162 MB. Item 45's third
task therefore needs somewhere for the reason to *be*, not just a new call site.

## Decision

### 1. Classify the occupant, then route it

Replace the single `isSocket()` guard with an explicit table. Every row is decided under a parent
directory `secureSocketParent` has already proven is a non-symlink directory, owned by the current
user, at mode 0700 (`unix.ts:252`) — which is what makes "ours" mean something here.

| Occupant | Decision | Reason |
| --- | --- | --- |
| absent | proceed | unchanged |
| socket, ours, dead | quarantine + unlink | unchanged |
| socket, ours, answering | refuse: already running | unchanged |
| socket, not ours | refuse, fail closed | unchanged |
| **regular file, ours** | **quarantine + unlink** | A regular file cannot be a listening endpoint, so removing it cannot disconnect a running daemon — the one risk the liveness probe exists to prevent. It is inside a 0700 directory we own, and WTM is known to create exactly this shape itself. |
| **regular file, not ours** | refuse, fail closed | Another user's file inside our private directory is a security event, not litter. |
| **directory** | refuse, fail closed | Recovery would mean recursive deletion; a daemon start is not the place to decide that. |
| **symlink** | refuse, fail closed | What was inspected is not what would be unlinked. |
| **FIFO, device, anything else** | refuse, fail closed | Never something WTM creates; no basis for reclaiming it. |

Recovery reuses `quarantineAndUnlink` unchanged, with the identity matcher generalised from
"is a socket with this dev/ino/uid" to "is the same file this decision was made about" — the
rename-verify-unlink sequence is what makes the decision race-proof, and it is not socket-specific.

### 2. One actionable refusal, with a stable code

Every fail-closed row above produces `WTM_IPC_PATH_UNUSABLE`: a new stable code registered in
`packages/protocol/src/errors.ts` and documented in `docs/18-errors-json-contract.md`. `context`
carries `path`, `occupant` (`directory` | `symlink` | `foreign-file` | `foreign-socket` | `other`),
and `ownerUid` where it is knowable; the remediation names the file and the command that removes it
where removing it is in fact the remedy. A refusal that cannot be remedied by the user (a foreign
socket that is answering) says that instead of suggesting a command that will not help.

### 3. A permanent failure must stop being retried

The mechanism is the exit code, because that is the only thing both service managers read.

- A **permanent** startup failure — an unusable IPC path, a socket path over the platform limit, an
  unsupported platform — writes its diagnosis once and exits **0**. `KeepAlive{SuccessfulExit:false}`
  and `Restart=on-failure` both mean "restart unless it exited cleanly", so exiting 0 is how a
  process tells either manager not to bother. Nothing else in either file has to change for the
  loop to stop.
- A **transient** failure keeps today's non-zero exit and keeps being retried.
- Both service files state their restart policy explicitly instead of inheriting one:
  `ThrottleInterval` in the plist, `StartLimitIntervalSec`/`StartLimitBurst` in the unit. This does
  not fix anything on its own — it removes the platform asymmetry noted above, so the two backends
  are bounded by the same stated numbers rather than by two vendors' defaults.

### 4. Somewhere for the reason to live

The daemon writes a small `daemon-status.json` beside its logs on every startup outcome: the
timestamp, whether it started, and for a failure the stable code, the message and the remediation.
It is one document, rewritten, never appended — so it cannot grow, and reading it costs nothing.

This is what closes the last two acceptance criteria: `wtm doctor`'s registration finding reads it
when `daemonReachable` is false and reports the recorded reason instead of a generic "start it with
`wtm daemon start`", and the installer reads it after starting the service so a fresh `make install`
says the daemon did not come up.

### 5. Bound the daemon's own stderr

Two independent bounds, because either alone leaves a hole:

- **At startup**, before anything is written: if `daemon.error.log` is over the cap, rotate it the
  way `ManagedLogStore` rotates a managed task's log (`logs.ts:16`, 20 MB, 3 retained). Both
  managers reopen the path per launch, so a rotation between launches is well defined. This is what
  bounds a loop that predates the fix — including the 162 MB file already on the reporter's disk.
- **Within a run**, a repeated identical startup failure prints its stack trace once and afterwards
  prints a single line. A stack trace is worth 2.7 KB the first time and nothing the ten-thousandth.

Registered repositories missing from disk stop printing stack traces entirely: they are a warning
about the workspace, not a fault in the daemon, and one line each is the whole of what a reader
needs.

## Revisions after reading the code (2026-09-11)

The plan was written against the code as merged with the heavy-job queue branch. Reading that code
changed five decisions above. Where this section and an earlier one disagree, this section wins.

**R1 — only the shape WTM creates is reclaimed, and only once it is stale.** Decision 1's row
"regular file, ours → quarantine + unlink" is too wide. The close shield
(`closeServerWithPrivatePathShield`) installs exactly this kind of file at the bound path while the
server closes. A daemon that reaches the bound path during that window finds the published socket
already refusing connections, and it would reclaim the other daemon's shield. That reopens the race
the shield exists to close. Two existing tests pin the fail-closed behaviour for arbitrary
non-socket occupants: `server.integration.test.ts` "preserves a non-socket deterministic private
bind path" and "does not replace a non-socket path". So the row becomes:

| Occupant | Decision |
| --- | --- |
| regular file, ours, size 0, mode 0600, one link, mtime older than 30 s | quarantine + unlink |
| the same, but younger than 30 s | refuse as **transient** (plain error, non-zero exit, retried) |
| any other regular file, ours | refuse: `WTM_IPC_PATH_UNUSABLE`, occupant `file`, remediation `rm <path>` |

A shield lives for milliseconds, and the service manager's retry interval is 10 s. So a young
placeholder costs at most a few retries and is then reclaimed. The two existing tests keep passing
in substance: both occupants are non-empty. Only the expected message changes.

**R2 — exit 0 only when a service manager is watching.** Decision 3 has every permanent failure
exit 0. For `wtm daemon serve` run by hand, that tells a script the daemon failed successfully.
Both service definitions now set `WTM_DAEMON_SUPERVISED=1`. A permanent failure exits 0 only when
that variable is set, and exits with its normal class (2) otherwise. "Permanent" is not a second
list: it is a coded failure that `exitCodeForError` already puts in class 2, the class for
"configuration a person has to change".

**R3 — the stated restart policy.** launchd gets `ThrottleInterval` 10, which is its default,
now written down. systemd gets `RestartSec=10` and, in `[Unit]`, `StartLimitIntervalSec=0`. With
permanent failures no longer retried, what remains is transient by definition, and it should be
retried on both platforms at the same interval. The distro rate limit is not a policy anyone chose.

**R4 — the frames are already one line; the loop defeats the de-duplication.**
`createDaemonErrorReporter` (`packages/cli/src/commands/daemon.ts`) already writes one line to
stderr and keeps frames in `daemon.error.log`. Its repeat window already exists. But the window
lives in memory, and a crash loop is a new process every time, so every launch wrote its frames.
`daemon-status.json` (decision 4) therefore also carries the last failing condition, its first
occurrence and an attempt count. A launch that fails with the same condition as the recorded one
does not retain frames. Missing registered directories are raised with `retainFrames = false`.

**R5 — there is no `wtm daemon start`.** The registration finding tells users to run it, but
`daemon` has only `install`, `uninstall`, `status` and `serve`. After this change a permanently
failed daemon stays stopped until someone acts, so the remedy must be a command that exists.
Doctor names the recorded remediation, then `wtm daemon install`, which rewrites the definition
and bootstraps the service again.

## Acceptance criteria (verbatim from `todo.md` item 45)

- [ ] IPC yolunda soket olmayan bir dosya varken daemon ya kendiliğinden toparlanıyor ya da ne
      yapılacağını söyleyen tek bir hata veriyor.
- [ ] Hiçbir açılış hatası sınırsız log büyümesi üretmiyor.
- [ ] `wtm doctor` ulaşılamayan bir daemon'ın sebebini söylüyor.
- [ ] Yeni kurulum yapan kullanıcı, daemon ayağa kalkmadığında bunu kurulum çıktısından anlıyor.

## Out of scope

- Windows IPC. `NamedPipeTransport` has no filesystem occupant to classify, and Increment D2 is
  paused; the classification lives in the Unix publisher and the Windows transport is untouched.
- Removing the close-shield placeholder mechanism. It exists for a real race (`unix.ts:169`), and
  the origin finding above is a likelihood, not a proof — changing shutdown on the strength of it
  would be trading a diagnosed defect for an undiagnosed one.
- Log *reading* commands for the daemon's own stderr. Rotation bounds the file; a `wtm daemon logs`
  is a separate feature nobody asked for.

## Plan

See `docs/superpowers/plans/2026-09-09-daemon-startup-crash-loop.md`.
