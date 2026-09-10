# Docker Compose Example

Copy `wtm.toml` to a project with a Docker Compose file at its root and Docker Compose available. The Compose project name includes the workspace, repository, and worktree ID. WTM resolves `{port.web}` and `{port.api}` in task argv/environment, but the Compose file must consume the variables you map to those templates. A port declaration alone does not rewrite Compose service ports.

```bash
cp examples/docker-compose/wtm.toml ./wtm.toml
wtm resolve compose-up
wtm run compose-up
```

`compose-up` runs the finite `docker compose up -d` command; Docker keeps the containers running
after that command exits. It does not need a WTM background-process slot. Initialization and
daemon installation do not start containers. Stop the stack explicitly when finished:

```bash
wtm run compose-down
```

The file-copy example uses Bash syntax. In PowerShell, copy the same TOML file with the shell's
native file-copy command; the WTM task argv remains an array on either platform.
