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
