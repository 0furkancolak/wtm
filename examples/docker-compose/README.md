# Docker Compose Example

Copy `wtm.toml` to a project with a Docker Compose file at its root. The Compose project name includes the workspace, repository, and worktree ID, so linked worktrees do not share Compose resources accidentally.

```bash
cp examples/docker-compose/wtm.toml ./wtm.toml
wtm resolve compose-up
wtm start compose-up
```

Compose is deliberately opt-in: initialization and daemon installation do not start containers. Stop the stack explicitly when finished:

```bash
wtm start compose-down
```
