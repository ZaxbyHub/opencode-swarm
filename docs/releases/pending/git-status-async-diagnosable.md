# /swarm close and rollback gate reads are async and say why they failed

## What

The git-status gate reads behind `/swarm finalize` (alias `/swarm close`),
`/swarm rollback`, the pre-destruction re-check, and the `/swarm diagnose`
"Git Repository" check now run through one shared async, bounded, killable
reader instead of private blocking `spawnSync`/`execFileSync` wrappers, and
every converted status read passes `--no-optional-locks` so a read-only check
never contends on the git index write lock.

When a gate read fails, the refusal text names the cause instead of the old
generic "Ensure git is available and the repository is readable" hint:

- a timed-out read reports `ETIMEDOUT` and advises restarting the OpenCode
  host (or inspecting the host runtime / security software) — the right
  remedy when git is present and the host could not complete the child spawn;
- a nonzero exit reports the exit status and the git stderr tail (for
  example a damaged `.git/index`), with a repair-the-repository remedy;
- a missing git binary reports `ENOENT` with the install hint (git.binary is
  honored from your USER-level config only);
- output larger than the read safety bound reports `EOUTPUT` and advises
  shrinking the change footprint, and a signal-terminated child reports
  `ESIGNAL` (POSIX signal deaths surfaced through `signalCode` or bun-compat's
  `-1` sentinel) — neither is ever reported as a successful `status 0` exit or
  a repository verdict;
- `/swarm diagnose` distinguishes all of these rows honestly — a hang or a
  signal kill shows as "git state unknown" with the actual cause, a spawn
  failure shows as "could not be spawned", a missing binary names `ENOENT`,
  and a nonzero `git rev-parse` answer says "Not a git repository".

The fail-closed contracts are unchanged: an unreadable status still refuses
the destructive pipeline with "Nothing was closed, archived, or destroyed",
the close gate and the pre-destruction re-check still share one argv and one
parser, and an unreadable rollback measurement still refuses the restore.

`/swarm finalize --dry-run`'s repository probe is a single bounded async
attempt — it no longer falls into the blocking 5-attempt synchronous retry
chain (up to ~150 s of frozen host event loop when git hangs), and the report
now says the probe is a read-only `git rev-parse`, not that "no git command
runs". The git executable resolver's async entry now probes candidates
through an async spawn (never the synchronous probe), and a probe cycle that
timed out is no longer negative-cached as the 60-second bare-`git` fallback.

The no-sync-spawn ratchet now also covers the four converted files
(`src/commands/close/orchestrator.ts`, `src/commands/destructive-purge.ts`,
`src/commands/rollback-gate.ts`, `src/services/diagnose-service.ts`), so the
blocking wrappers it replaced cannot return.

### Known residual (not fixed here)

> **Superseded in this same release by the #3427 follow-up (PR #3441):
> both probe sites below now ride the shared async reader — the checkpoint
> tool's entry preflight and `saveCheckpointRecord`'s probe use
> `readGitRepositoryStatusAsync`/`readGitStatusAsync`, and the align stage's
> mid-finalize probe uses the new `readGitRepositoryStatusDetailedAsync`.
> The residual described here no longer exists once that PR lands.**

Two synchronous git probes remain on adjacent paths and are tracked in
follow-up issue #3427: the checkpoint tool's `isGitRepo` preflight (every
git-checkpoint `/swarm rollback` crosses it first) and the align stage's
mid-finalize `getGitRepositoryStatus` call — both still use the blocking
retry chain and can wedge on a host where synchronous spawns stall. This
change makes the GATE READS async and diagnosable; it does not make those
two probes non-blocking.

A probe terminated EXTERNALLY on Windows (taskkill, Stop-Process, EDR
intervention) exits 1 or 255 with no signal code — indistinguishable from a
plain nonzero exit at the process level — so it renders under the nonzero
path (repair remedy; "Not a git repository" at diagnose) rather than
`ESIGNAL`. The refusal stays fail-closed either way; only the cause label is
coarse for that shape (measured 12/12 at the review round; the
signal-reporting paths above all classify correctly).

## Why

On a loaded Windows OpenCode host (issue #3275 field report), every
synchronous child spawn inside the host timed out while async spawns worked;
`/swarm close` aborted with no cause named and advice that blamed git
availability. The same detail-collapsing wrapper sat in front of the
rollback gate, the diagnose repository check, and the dry-run probe.
