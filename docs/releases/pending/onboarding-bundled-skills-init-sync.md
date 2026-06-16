# Fresh-project onboarding: materialize architect mode skills at plugin init

## What

On a brand-new project, the architect now follows the swarm workflow out of the
box — no manual `/swarm` command and no session restart required.

- The bundled architect MODE skills (`.opencode/skills/<mode>/SKILL.md` for all
  20 modes: specify, plan, execute, critic-gate, brainstorm, clarify, …) are now
  materialized into the project during plugin initialization via a new
  bounded, fail-open async sync (`syncBundledProjectSkillsIfMissingAsync`).
  Per AGENTS.md invariant 1 / issue #704 the sync is **deferred** off the
  `server()`-resolution path via `queueMicrotask` (not `await`ed inline) and
  bounded by `withTimeout`, so plugin init stays fast even on cold Windows
  filesystems while the sync completes in the background before the architect
  reads any `SKILL.md` at runtime.
- Previously these files were copied only as a side effect of a subset of
  `/swarm` mode commands, so a fresh project's architect hit missing skill files
  on its first auto-entered mode (e.g. SPECIFY for a new project) and a weaker
  architect model would narrate/hallucinate the workflow instead of executing
  it. The command-path sync is retained as a backstop for pre-existing projects.
- Fixed `/swarm doctor-tools` returning "command not found": the hyphenated form
  is now a registered alias of `doctor tools` (with its own handler, since
  `aliasOf` is warning text only).

## Why

The architect's system prompt delegates every mode's protocol to a project-local
`SKILL.md`. Because those files were only installed by certain `/swarm` commands,
a freshly installed swarm on a new system did not follow the swarm workflow until
the user happened to run a mode command and restart the session — a serious
onboarding gap, especially with non-frontier architect models.

## Migration

No breaking changes. All changes are additive:
- The init-time sync is missing-only and never overwrites user-customized skill
  files (COPYFILE_EXCL + existence checks, symlink-guarded, byte/file-bounded,
  rollback-on-error). It is a no-op after first run and on every supported
  platform fails open without blocking plugin init.
- The `doctor-tools` alias is a convenience redirect to `doctor tools`.

## Caveats

- The fix removes the restart requirement for the architect runtime-read path
  (the architect reads the materialized `SKILL.md` via its `read` tool). The sync
  is dispatched at plugin init on the next microtask and runs in the background;
  because the architect cannot read a `SKILL.md` until the user sends a turn
  (seconds later), the deferred sync has completed by then, and the command-path
  sync remains a backstop. Whether OpenCode's own native skill-discovery picks up
  files written during the same boot is external to this repo and unverified
  here; the runtime-read path is demonstrated by a fresh-project materialization
  check (20/20 mode skills present, incl. `specify/SKILL.md`).
