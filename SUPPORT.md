# Support

Use GitHub Issues for reproducible bugs and feature requests. Include the WTM version, Node and Bun versions, your operating system and its version (and on Linux, whether `systemctl --user` reaches a user manager), the command, sanitized JSON output, and a minimal reproduction. Do not post secrets, credentials, private repository content, or vulnerability details; use the private process in [SECURITY.md](SECURITY.md) for security reports.

| Platform | CI | Source backend and native evidence | Published standalone distribution |
| --- | --- | --- | --- |
| macOS arm64 / x64 | Decides the run | launchd, Unix sockets and process-group supervision; CI covers both architectures | `v0.1.0-rc.1` archives and checksums |
| Linux x64, glibc | Decides the run | systemd user backend, Unix sockets and process-group supervision; native CLI/daemon evidence exists, full systemd lifecycle verification remains open | Release workflow builds and publishes an archive on a tag; none has shipped yet — build from source |
| Linux arm64, glibc | Decides the run | Native `ubuntu-24.04-arm` CI and local ELF archive construction are configured; passing native acceptance remains pending | Same as Linux x64: buildable and publishable, none shipped yet |
| Windows x64 | Informational only | Experimental Scheduled Task, named-pipe and process-tree backend; CI is configured, native acceptance remains incomplete | Release workflow builds, zips and gates `wtm-windows-x64.zip` on a tag; its job does not block a release the way the macOS/Linux jobs do, and none has shipped yet |
| Linux musl and other targets | Not run | No complete native acceptance evidence or configured native CI | No release archive |

This table describes the repository's implementation and known release artifacts. The source manifest permits `darwin`, `linux` and `win32`; package eligibility does not establish a passing native gate or a published binary for that platform. Check the [CI run for your revision](https://github.com/0furkancolak/wtm/actions/workflows/ci.yml) and [release assets](https://github.com/0furkancolak/wtm/releases) when reporting a failure.

**Minimum operating-system versions.** This project has no verified floor below what its own CI
actually runs on — it has not been tried anywhere older. The gating jobs currently run on
`macos-15` (Apple silicon) / `macos-15-intel`, `ubuntu-24.04` / `ubuntu-24.04-arm`, and
`windows-latest` (a GitHub-managed alias for whichever Windows Server image GitHub currently ships
under that name — see [GitHub's runner-images project](https://github.com/actions/runner-images)
for the exact build). Treat any earlier OS release, or any Linux distribution other than the glibc
one CI runs, as unverified rather than unsupported: it may well work, nobody has confirmed it.

Include sanitized `wtm doctor --json` output so the report identifies the selected backend and actual state paths. On Windows, name the shell (PowerShell or Git Bash), whether native Windows Node is used, and any Task Scheduler error. For queue problems, include the job's status/result and relevant bounded logs; durable acceptance of a job does not mean that its command succeeded.

The project is community-supported and provides no guaranteed response time or service-level agreement.
