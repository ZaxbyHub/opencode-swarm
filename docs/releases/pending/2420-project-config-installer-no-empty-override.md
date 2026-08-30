# Installer no longer auto-creates empty project override (issue #2420)

## What

`opencode-swarm install` and first-run plugin initialization no longer auto-create
`<workspace>/.opencode/opencode-swarm.json` when there is nothing to seed.

## Why

Auto-writing an empty project override (`{}` or `{ "agents": {} }`) caused
configuration confusion because users could misread it as an active project-level
replacement of global agent settings.

## Fix

- Skip automatic project override file creation in installer and runtime startup.
- Keep global `~/.config/opencode/opencode-swarm.json` as the single active config
  unless a user explicitly creates a project override file.
- Update tests to assert no project override file is auto-created.

## Migration notes (existing installs)

Installs made before this change may still carry an empty
`<workspace>/.opencode/opencode-swarm.json` written by a prior `install`. The
file is harmless — an empty override (or `{ "agents": {} }`) merges over the
global config without replacing it — but you can delete it to keep the project
clean. Keep a project override file only if you intentionally maintain
project-specific settings there.

## Scope note

Issue #2420 also reported that `/swarm agents` could display inherited model
values that differ from what dispatch actually resolves. This change does not
address that roster-vs-dispatch observability discrepancy; it removes the
auto-created override that triggered the reporter's case. If you can still
reproduce a roster/dispatch mismatch with a manually authored project config,
please open a follow-up issue.
