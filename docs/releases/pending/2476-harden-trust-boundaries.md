# Harden executable, git-ref, and config trust boundaries (#2476)

Workstream B, PR 3 of 3 — closes the remaining trust-boundary gaps from the
#2236 security sweep that were tracked in issue #2476.

## What changed

- **gh resolver parity (AC1):** new `src/utils/gh-executable.ts` mirrors the
  hardened git resolver for `gh` — env override (`OPENCODE_SWARM_GH_BINARY`),
  platform absolute candidates, probed PATH candidates with a
  `gh version N.N` pattern gate, bounded probe budgets, a 60 s negative cache
  with stale-probe generation guard, and a never-throw contract.
  `gh_evidence`, `pr.ts` (`ghExec`/`ghExecAsync`), and
  `pr-monitor-status` now spawn a resolved absolute `gh` instead of a bare
  name. Windows candidate ordering changed from "bare `gh` first" to
  "platform absolutes first, bare name last" — the runtime-friction fix the
  #2236 sweep predicted for stale-PATH plugin processes.
- **deepMerge prototype-pollution refusal (AC2):** `deepMerge` now performs a
  full recursive override scan and throws a typed `DangerousMergeKeyError`
  when the override contains `__proto__`, `constructor`, or `prototype` at
  any depth. The config loader catches it, warns (`⚠️ SECURITY: Ignoring the
  entire project config …`), and continues with user-level config only —
  fail-closed on the attack, fail-open for every benign config. This closes
  the residual `{"__proto__":{...}}` class the git.binary provenance gate
  could only neutralize after the fact.
- **git option-injection guards (AC3):** new `src/git/safe-ref.ts`
  (`assertSafeGitRefArg`) rejects option-shaped refs (a `..`-split side that
  begins with `-`) before they reach git argv; `branch.ts` ref sites now use
  `git branch -d -- <name>`, and `commitAndPush` pushes
  `git push -u origin -- <branch>`. `refs/heads/--evil`-style repo content
  can no longer become an option.
- **bare-spawn ratchet blind spots (AC4):** `scripts/check-bare-executable-spawn.ts`
  now also flags aliased callees, file-local wrapper functions that forward
  their first parameter to a spawn family call, and `__seed*ForTests` helper
  calls with literal flagged executables — closing the ratchet holes that let
  a bare spawn hide behind a local helper. The real sites it then caught
  (`co-change-analyzer.ts`, `pr.ts` git calls) were fixed to use the
  resolvers.
- **Windows .cmd execution for pkg-audit (AC5):** `runNpmAudit`/`runCargoAudit`
  now resolve npm/cargo up front. On win32, `.cmd`/`.bat` hits (Node cannot
  spawn them directly since the CVE-2024-27980 hardening) are routed through
  `cmd.exe /d /s /c call "<absolute path>"` with verbatim arguments — a form
  empirically verified on Windows for space-containing paths such as
  `C:\Program Files\nodejs\npm.cmd`. `.exe` hits spawn directly; POSIX and
  resolution-failure paths keep the historical bare-name behavior.
- **Bounded council fetches (AC6):** Tavily and Brave provider searches in
  `src/council/web-search-provider.ts` pass `AbortSignal.timeout(6_000)` so a
  never-responding provider can no longer hang a council web search.

## Migration

No migration required. The one intentional behavior change users may notice:
a project config carrying `__proto__`/`constructor`/`prototype` keys is now
rejected wholesale (with a SECURITY advisory) instead of being merged and
partially neutralized.

## Known caveats

- `pkg-audit` still spawns the bare name when the tool cannot be resolved at
  all (tool absent) — the spawn then fails into the existing
  "not installed" reporting, unchanged.
- The bare-spawn wrapper detection is one-hop/file-local by design; the
  limitation is documented in the scanner.
