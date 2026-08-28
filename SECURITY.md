# Security Policy

## Supported versions

Until 1.0, only the latest published version and the current `main` branch receive security fixes.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's **Report a vulnerability** private security-advisory form for this repository. Include affected versions, reproduction steps, impact, and any proposed mitigation. Maintainers will acknowledge a complete report within seven days and coordinate disclosure after a fix is available.

Security-sensitive areas include adapter trust, arbitrary task execution, resource deletion and GC, process-group signaling, symlink traversal, repository-local configuration trust, and launchd transaction recovery. Never include real credentials or private user data in a report.
