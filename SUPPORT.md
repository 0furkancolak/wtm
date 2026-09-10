# Support

Use GitHub Issues for reproducible bugs and feature requests. Include the WTM version, Node and Bun versions, your operating system and its version (and on Linux, whether `systemctl --user` reaches a user manager), the command, sanitized JSON output, and a minimal reproduction. Do not post secrets, credentials, private repository content, or vulnerability details; use the private process in [SECURITY.md](SECURITY.md) for security reports.

| Platform | Source backend and native evidence | Published standalone distribution |
| --- | --- | --- |
| macOS arm64 / x64 | launchd, Unix sockets and process-group supervision; CI covers both architectures | `v0.1.0-rc.1` archives and checksums |
| Linux x64, glibc | systemd user backend, Unix sockets and process-group supervision; native CLI/daemon evidence exists, full systemd lifecycle verification remains open | No Linux release archive |
| Windows x64 | Experimental Scheduled Task, named-pipe and process-tree backend; CI is configured, native acceptance remains incomplete | No Windows release archive or published installer |
| Linux arm64 / musl and other targets | No complete native acceptance evidence | No release archive |

This table describes the repository's implementation and known release artifacts. The source manifest permits `darwin`, `linux` and `win32`; package eligibility does not establish a passing native gate or a published binary for that platform. Check the [CI run for your revision](https://github.com/0furkancolak/wtm/actions/workflows/ci.yml) and [release assets](https://github.com/0furkancolak/wtm/releases) when reporting a failure. Minimum operating-system versions have not been established across all targets.

Include sanitized `wtm doctor --json` output so the report identifies the selected backend and actual state paths. On Windows, name the shell (PowerShell or Git Bash), whether native Windows Node is used, and any Task Scheduler error. For queue problems, include the job's status/result and relevant bounded logs; durable acceptance of a job does not mean that its command succeeded.

The project is community-supported and provides no guaranteed response time or service-level agreement.
