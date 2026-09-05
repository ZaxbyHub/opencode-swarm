# ADR 0002: opencode-ensemble adoption — license, provenance, and adopt-or-reimplement

- **Status:** Accepted
- **Date:** 2026-09-05
- **Deciders:** opencode-swarm maintainers (workstream G, issue #2505)
- **Resolves:** #2505; unblocks #2506 (G2), #2507 (G3), #2508 (G4), #2509 (G5)

## Context

Workstream G ("Parallel execution and ensemble operations", slots G1–G6) was planned against the
multi-agent orchestration ideas popularized by
[opencode-ensemble](https://github.com/hueyexe/opencode-ensemble) — an OpenCode plugin ("Agent
teams for OpenCode. Run multiple agents in parallel with messaging, shared tasks, and coordinated
execution."). G2–G5 each name this ADR (#2505) as a dependency: before any of those issues may
merge ported upstream material, the license, provenance, and per-capability adopt-or-reimplement
decision must be recorded here (issue #2505: "No code port before license verification. Ideas are
fine; code requires compliance.").

The five capabilities under evaluation — named by #2505 and mirrored by the G2–G5 tracking
issues — are: watchdog (lane liveness / stall detection), breaker/rate-limit (dispatch
protection), merge safety (settlement), purge pattern (two-step destructive operations), and
dashboard (local mission-control view).

## License and provenance

All facts below were verified from primary sources (GitHub REST API and raw file blobs at the
pinned commit) on 2026-09-05:

- **Upstream:** `https://github.com/hueyexe/opencode-ensemble`, default branch `main`, not a
  fork, not archived (212 stars at verification time).
- **License:** MIT (SPDX `MIT`). The upstream `LICENSE` file carries exactly this copyright line
  (quoted verbatim below); the repo has no NOTICE file, and the only attribution obligation is
  MIT's: retain the copyright and permission notice in all copies or substantial portions of any
  ported material.

```text
Copyright (c) 2026 opencode-ensemble contributors
```
- **Pinned commit:** `eaf9e84a6e872e6af9ad8bb5a8fd274ce926a878` (2026-08-25, "fix: watchdog
  re-nudge suppression, retry payload coercion, spawn rollback status guard"). Any ported code,
  strings, or UI assets must be taken from — and cite — this commit, or from a newly verified
  commit recorded in a superseding ADR.
- **Dependency licenses:** upstream's only runtime dependencies are `@opencode-ai/plugin` and
  `@opencode-ai/sdk` (both `^1.17.18`, both MIT — this repository already depends on the same
  packages at `^1.18.3`, verified against our own `node_modules` copies). Dev/peer tooling:
  `@biomejs/biome` (MIT), `@types/bun` (MIT), `typescript` (Apache-2.0, toolchain-only). No
  copyleft dependency exists anywhere in the upstream tree; a port would introduce no new
  third-party license beyond MIT attribution.
- **Binary/UI assets:** `social-preview.png` and `docs/dashboard.png` are upstream documentation
  assets covered by the same MIT grant; this repository does not redistribute them, and a future
  port must not copy them without the same attribution as code.
- **Owner risk acceptance (context, not verification):** the repository owner has stated that
  licensing is not a commercial concern for this MIT-licensed, never-sold plugin. That statement
  is recorded for context only — this ADR's obligations rest on the primary-source verification
  above, which independently closes the issue's adversarial branch ("non-permissive license
  forces reimplementation"): upstream is permissive.

## Decision

**Reimplement every capability on this repository's own substrate; adopt upstream ideas,
patterns, and parameter defaults with credit; port no upstream code, strings, or UI assets in
this ADR or in G2–G5 as currently scoped.** The license is verified MIT, so a future targeted
port is permissible — but engineering fit, not license, is the binding reason for
reimplementation-first: each upstream implementation either fights this repository's execution
model or violates its engineering invariants (see the table and AGENTS.md invariants 1, 3, 4, 9).

## Per-capability decisions

| Capability | Decision | Adopted from upstream (idea, with credit) | Why not port the code |
|---|---|---|---|
| watchdog | REIMPLEMENT | Stall-parameter surface (timeoutMs 30 min, stallThresholdMs 5 min, stallMinSteps, stallTokenThreshold, 0-disables) and the re-nudge-suppression idea (persist last-nudge time; do not re-nudge a member that has had no activity since the last nudge) | Upstream `src/watchdog.ts` is member/worktree-centric and drives the host PluginClient directly (`session.promptAsync`, `session.abort`, `tui.showToast`); our lanes settle through the dispatch-lane/settlement substrate with one existing horizon (`PR_WORKFLOW_STALE_LANE_TIMEOUT_MS`) that #2506 requires unifying with, not duplicating beside |
| breaker/rate-limit | REIMPLEMENT | Token-bucket dispatch limiting with capacity 10/sec default and 0-disables; spawn-failure loop detection concept | Upstream ships no circuit breaker at all (only a token bucket that is not wired to spawn, plus host retry-event persistence); this repository already has a richer versioned circuit machine (`src/pr-review/circuit.ts`, CLOSED/OPEN/HALF_OPEN with generations, waterlines, bounded contributors, atomic single half-open probe) and AGENTS.md invariant 9 mandates action-local keying upstream does not implement |
| merge safety | REIMPLEMENT | Squash-merge-unstaged settlement shape (lane results land as unstaged reviewable changes) and overlap blocking with a typed diagnostic and recovery hint | Upstream `src/tools/merge-helper.ts` runs git with no subprocess timeout (AGENTS.md invariant 3) and proceeds with the merge when its own overlap check throws (fail-open, contrary to invariant containment posture); its lead-worktree merge model does not map onto our lane settlement substrate (`src/background/completion-observer.ts`, `pending-delegations.ts`) |
| purge pattern | REIMPLEMENT | The two-step destructive-purge design itself — first call returns a side-effect-free preview (counts, exact option labels, confirm_token); destructive execution requires the exact token, one-shot consumption, re-validation of targets, and a bounded TTL | The design is the contribution (#2508 already encodes it as "ensemble two-step purge pattern"); the implementation is bound to upstream's team/SQLite model and in-memory token store — our destructive surfaces are `/swarm close` (`src/commands/close.ts`) and `reset-session`, whose preview/confirm must compose with our evidence and telemetry invariants |
| dashboard | REIMPLEMENT | The inline-asset architecture: HTML/JS served from TS string modules with no frontend build step and no framework dependency (explicitly cited by #2509 as the ensemble precedent) | Upstream `src/dashboard.ts` auto-starts an HTTP server on the plugin init path unless port is 0 (AGENTS.md invariant 1), serves with `Access-Control-Allow-Origin: *`, has no capability token, no Host/Origin validation, and renders raw prompts/outputs unfiltered; #2509 requires opt-in default-off, per-session capability token, origin/CSRF defenses, bounded responses, and sanitized rendering — a port would import every one of those violations |

## G2-G5 port gate

None of #2506 (G2 watchdog/stall), #2507 (G3 spawn breaker + token bucket), #2508 (G4 merge
safety + two-step purge), or #2509 (G5 dashboard) may merge ported opencode-ensemble code,
strings, or UI assets before this ADR lands — and this ADR is the decision that gate protects:
it lands together with the executable checklist test
(`tests/unit/docs/ensemble-adr-2505.test.ts`) that mechanically holds this record honest.
Because the decision is REIMPLEMENT for every capability, the gate resolves to "reimplement as
scoped"; the port obligation below survives the gate permanently. #2532 (G6, parallel-first
scheduling) declares no #2505 dependency and is not a capability port, so it is outside this
gate. Superseding any decision in this ADR requires a new ADR (`docs/decisions/000N-...md`)
recording fresh primary-source license verification at the then-current pinned commit.

## Port obligation for future adoption

If any future change adopts (ports) upstream code, strings, or UI assets — regardless of which
issue carries it — it must satisfy all of the following, enforced by the checklist test and by
review:

1. Pin and cite the exact upstream commit (the verified
   `eaf9e84a6e872e6af9ad8bb5a8fd274ce926a878`, or a newly verified commit recorded in a
   superseding ADR).
2. Carry a provenance header comment in every ported file:
   `ported-from: opencode-ensemble <commit-sha> <upstream-path>` as the file's first comment
   line.
3. Create or extend `THIRD_PARTY_NOTICES.md` at the repository root, reproducing the upstream
   MIT notice — `Copyright (c) 2026 opencode-ensemble contributors` — with the permission text
   and the pinned commit.
4. Update this ADR (or its successor) with the ported surface.

The mechanical contract is symmetric: while no port exists, no file under `src/` may carry the
`ported-from: opencode-ensemble` marker and `THIRD_PARTY_NOTICES.md` is intentionally absent;
once a marker exists, the notice file must exist and carry the copyright line, or the checklist
test fails.

## Re-evaluation triggers

Revisit this decision (new ADR required) when any of the following holds:

- Upstream ships a large, invariant-clean surface that this repository would otherwise rebuild
  at material cost (for example: a bounded-timeout, fail-closed merge engine; a dashboard server
  with origin validation and sanitized rendering).
- G2–G5 implementation reveals a capability where a verified port would be materially safer or
  cheaper than reimplementation.
- Upstream changes its license, or a new dependency introduces a non-permissive obligation.

## Consequences

- G2–G5 proceed as reimplementations on the lane/settlement substrate, with upstream ideas and
  defaults credited in their issues and release fragments.
- No `THIRD_PARTY_NOTICES.md` ships with this change (nothing is ported); the file becomes
  mandatory the moment the first port lands.
- Future ports are mechanically discoverable via the `ported-from: opencode-ensemble` marker,
  and the ADR checklist test keeps this record's license, provenance, decisions, and gate
  sections pinned and current.
- The MIT verification removes license risk for any such future port; the remaining risk is
  engineering fit, which each porting PR must argue on its own merits.
