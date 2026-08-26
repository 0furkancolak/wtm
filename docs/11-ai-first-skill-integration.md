# AI-First Integration and Agent Skill

## Goal

An agent should not reverse-engineer workspace conventions on every task. WTM provides both stable machine-readable commands and a reusable Agent Skill.

The canonical skill is shipped at:

```text
skills/wtm/SKILL.md
```

## Why a Skill

Agent Skills use a portable `SKILL.md` playbook. WTM's skill teaches an agent how to inspect context, run development tasks, avoid manual env/port changes and safely handle worktree cleanup.

## Agent command contract

Preferred agent flow after entering a repository/worktree:

```bash
wtm doctor --json
wtm status --json
```

To run project operations:

```bash
wtm dev
wtm test
wtm run <task>
```

To understand decisions:

```bash
wtm explain --json
wtm plan --json
```

Before cleanup/removal:

```bash
wtm analyze --json
```

## Rules taught to agents

1. Do not manually choose a dev port when WTM manages the task.
2. Do not copy `.env` files between worktrees unless the WTM config explicitly instructs it.
3. Do not share `node_modules`, `.venv`, `.next`, `target` or build directories manually.
4. Prefer exposed WTM tasks over raw parent Makefile commands.
5. Use `wtm resolve <task>` when debugging what WTM will run.
6. Use `--json` for reasoning/automation.
7. Never use `git worktree remove -f` to bypass WTM safety.
8. Never auto-commit/push/reset merely to satisfy deletion; report blockers unless the user explicitly asked for that Git action.
9. If WTM is unhealthy, run `wtm doctor --json` and `wtm reconcile` before inventing local workarounds.

## Skill installation

Commands:

```bash
wtm skill print
wtm skill install
wtm skill install --global
```

`skill install` should support the Agent Skills `SKILL.md` format and copy/symlink the canonical skill to a supported agent-skill location selected by the installation adapter. Exact vendor locations stay outside the core business logic because they can evolve independently.

## AGENTS.md integration

WTM should not rewrite a user's `AGENTS.md` automatically.

During `wtm init`, WTM may print an optional snippet:

```md
## Worktree runtime

This workspace uses WTM. Before running development/test commands, use `wtm doctor --json` and prefer WTM tasks such as `wtm dev` and `wtm test`. Do not manually select ports or remove worktrees with force.
```

An explicit future `wtm ai instructions --append-agents` command can update the file with user approval.

## AI-friendly output design

Every JSON payload has:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "status",
  "data": {},
  "warnings": [],
  "errors": []
}
```

Errors use stable codes and structured remediation fields. The agent must not need to parse ANSI/human prose.

## AI safety advantage

WTM centralizes destructive preflight. An agent can be highly autonomous in creating/running worktrees while still being unable to accidentally remove local-only work through the normal WTM command path.
