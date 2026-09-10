# Security Policy

## Supported versions

Until 1.0, only the latest published version and the current `main` branch receive security fixes.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's **Report a vulnerability** private security-advisory form for this repository. Include affected versions, reproduction steps, impact, and any proposed mitigation. Maintainers will acknowledge a complete report within seven days and coordinate disclosure after a fix is available.

Security-sensitive areas include adapter trust, arbitrary task execution, resource deletion and GC, process signaling, symlink traversal, repository-local configuration trust, and service-definition transaction recovery. Never include real credentials or private user data in a report.

## Platform boundaries

| Boundary | macOS / Linux | Windows, experimental |
| --- | --- | --- |
| File trust | Current-user ownership, mode checks, hard-link and path-identity checks | Owner SID and ACL checks, hard-link and path-identity checks; POSIX mode bits do not establish Windows ownership |
| Daemon IPC | Private Unix socket and guarded publication | Named pipe selected from the state path; the pipe name itself is not an authorization credential |
| Process cleanup | Start identity and command fingerprint before process-group signaling | CIM creation-time identity and command fingerprint, validated parent/child relationships and taskkill-based cleanup; no Job Object containment guarantee |
| Per-user service | launchd or systemd user definition with transactional recovery | Scheduled Task registration and guarded XML staging; staging-file safety does not by itself prove the live scheduler's definition |

Windows native cleanup, service recovery and cross-account named-pipe isolation still require complete acceptance evidence. Parser fixtures or successful installation alone do not establish those properties. All backends must treat failed identity inspection as uncertainty, rather than evidence that a process has disappeared.

## Queue and source boundaries

The heavy-job queue is shared by sessions using the same host, operating-system user and state database. Separate state directories and commands run outside WTM do not share its limits. Optional memory admission uses declared task estimates and available-memory samples; it is not an operating-system memory limit or a sandbox for configured commands.

Cancellation and timeout retain a slot until process cleanup is proved. Uncertain commands are not automatically replayed after restart. Job source checks cover bounded Git-visible content and metadata, not ignored files, external dependencies or an immutable filesystem snapshot. A successful command result with invalid source evidence must not be presented as verification of the current checkout.
