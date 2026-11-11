# issue-tracer parallel-session claim gate (v3.0.2)

## What changed

- Non-Negotiable Rules 13 (claim before you work; an active trusted-author claim is a live lock; lineage under one shared login and shared memory is undecidable) and 14 (collision handling: an open parallel PR halts; a branch-only collision renames, discloses, and asks; never force-push a parallel session's published head).
- Phase 0 claim gate in `references/phase-0-setup.md`: live thread fetch before `trace-init.sh`, claim patterns (`Agent claim`, `Working this issue`, `Claiming for active work` — a deliberate superset of the zaxbygraph parser, gap reported on ZaxbyHub/zaxbygraph #77), trusted-author requirement (`OWNER`/`MEMBER`/`COLLABORATOR`), ~72h active window, stop-and-ask on any active foreign claim (earliest claim wins), own-claim format `**Agent claim:** session=<token> issues=#a,#b` posted via `gh issue comment`, token reuse on resume, release (`**Claim released:**` forms) when a trace ends, and a `not_applicable` path (claims off / untrusted login / no write access).
- Phase 1 intake re-checks the claim state and reads the FULL comment thread (parallel sessions record decision proposals and owner confirmations in comments; an uninformed intake question can contradict a recorded owner decision).
- Phase 2.5 anchor publication gains a fetch-before-post check: a rival `issue-tracer-checkpoint-v1` anchor with a different slug, or an active foreign claim, halts before publishing.
- Phase 5 gains a pre-publication collision check (`gh pr list` + `git ls-remote`).
- `metadata.version` bumped 3.0.1 → 3.0.2 in the canonical skill and both adapter shims (`.claude`, `.agents`), per the install lockstep rule.

## Why

On 2026-11-11, two agent sessions sharing one login each ran a complete issue-tracer chain on the same collated issues (zaxbysauce/zmem #455/#366) for ~4 hours. The second session had READ the first's claim comment and misattributed it to its own earlier session — under one login and a shared memory store, lineage is undecidable. Both sessions published checkpoint anchors to the same issue sixteen minutes apart without noticing, and two PRs resulted. The protocol was adjudicated by two cross-model critics: a claim comment is an announcement, not a reservation; the missing primitive is an exclusive-assignment rule whose enforcement point is the process, not agent judgment.

## Migration steps

No migration required. The claim gate runs with `gh` alone; once ZaxbyHub/zaxbygraph #77 (`claim`/`release`/`claims --live`/`pr-guard`) and #74 (the `claimed` gate in `triage`/`bundle`) ship, prefer those commands — the skill text says so.

## Breaking changes

None. The progressive-disclosure ratchet baseline for the canonical `SKILL.md` moves 196 → 201 (five lines of binding protocol: rules 13-14 and three phase-bullet pointers), the same one-way-ratchet precedent as the earlier swarm-pr-review binding-policy bump.

## Known caveats

- The third claim pattern (`Claiming for active work`) is a superset of the zaxbygraph parser's built-ins; if zaxbygraph #77 declines to add it, the skill's manual gate stays broader than the tooling on purpose (real-world format, observed on zaxbysauce repos).
- Rule 13 asks the user on any active foreign claim; a stale claim from a dead session costs one user question by design (fail-closed), resolved by the stale-lock recovery question.
