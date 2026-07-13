# Finalize/reset lifecycle fixes, `finalize --dry-run`, portable bundled commit-pr (#1692)

## What

Resolves the seven concerns bundled in issue #1692 across the swarm lifecycle
commands, the bundled skill set, and the destructive-command guardrail.

### `/swarm finalize` (close)

- **Honest WAL sidecar handling.** `swarm.db-shm` / `swarm.db-wal` are removed
  from `ARCHIVE_ARTIFACTS` and `ACTIVE_STATE_TO_CLEAN` (and the now-redundant
  `WAL_SIDECAR_FILES` skip is deleted). Behavior is unchanged — the sidecars
  were always skipped and left in place — but the arrays, docblock, and the
  new `--dry-run` report no longer misrepresent them as "cleaned"/"must be
  removed." The misleading "Preserved … because it was not successfully
  archived" warning no longer has any path to fire for an absent sidecar.
- **Teardown no longer masks a successful run.** The end-of-run session
  teardown (`endAgentSession` loop + `resetSwarmStatePreservingSingletons`) is
  wrapped so a late throw is surfaced as a warning instead of escaping as a
  generic dispatcher error after all four stages and the summary succeeded.
- **`finalize --dry-run`.** New read-only mode that reports what finalize would
  archive, clean, and align — taking no lock and mutating nothing.

### `/swarm reset` and `/swarm reset-session`

- **Auto-backup before deletion.** Both commands now copy the state they are
  about to delete into a durable, timestamped `.swarm/reset-backups/<kind>-<ts>/`
  directory (newest 5 retained) before deleting, replacing the manual-only
  "run `/swarm export` first" tip. Restore by copying the files back. Fail-open:
  a backup failure never blocks the reset.

### Bundled `commit-pr` skill

- The `commit-pr` skill shipped to end-user projects (`.opencode` copy) is now
  a portable, project-agnostic commit/PR workflow with no opencode-swarm
  internals (no `AGENTS.md`, bun/biome, `docs/releases/pending`, release-please,
  or `ZaxbyHub`/`zaxbysauce` references). The repo-internal `.claude` copy is
  unchanged and remains the source of truth enforced by
  `.github/workflows/pr-standards.yml`. The mirror pair is reclassified
  `identical` → `divergent` in `src/config/skill-mirrors.ts`.

### Guardrail

- `git push --force-with-lease` is now allowed by the destructive-command
  guardrail (bare `git push --force` / `-f` stay blocked), resolving the
  contradiction with the publication protocol and aligning with
  `full-auto/policy.ts`, which already exempted it. The guardrail-explain
  service mirrors the change.

### Docs

- `docs/commands.md` finalize/reset drifts fixed: the fictional `--force`
  "guard against closing active work," the WAL-deletion claim, and the `locks/`
  cleanup claim are corrected; `--dry-run` and the reset auto-backup are
  documented.

## Why

The WAL warning, teardown gap, and docs drifts were misleading operators every
run; the bundled `commit-pr` skill was shipping this repo's internal protocol
into unrelated projects and re-materializing even after deletion; and the
guardrail hard-blocked a push the publication protocol requires.

## Scope notes

Respects #1647 (no `close.ts` module split) and #1648 (no docs↔registry drift-gate
generator) — only the concrete drift instances are fixed here.
