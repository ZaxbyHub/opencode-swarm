---
issue: 2962
---

## Lean Turbo lane planning now applies the Rule-3 upstream-commit gate under Epic Mode

Under Epic Mode, Lean Turbo lane planning now refuses to place a task in a parallel
lane when its cross-phase `depends:` upstream has no `swarm(task <id>):` landing
commit in the open Epic's commit range for the current plan — the task is degraded
with a named remediation (`cross-batch upstream not committed (greenfield-smart
Rule 3): <id>`) instead of being dispatched against missing work. The predicate was
always reserved as the planner's final parameter but no production caller supplied
it, so every cross-batch dependency was silently treated as satisfied.

The evidence reuses the current Epic marker machinery (`findTaskCommits`):
merge-inclusive (coder landings are `--no-ff` merges), filtered by the
`Swarm-Plan:` trailer (task ids repeat across plans), and scrub-id aware. The wiring
is epic-gated through `isEpicOpenForProject` — pure Lean Turbo behavior is
unchanged (predicate `undefined`, byte-identical placement), and the affected path
is direct/composition Lean invocation while an Epic is open (sanctioned flows keep
Epic and Turbo mutually exclusive). An unborn HEAD (empty repository) yields a
defined predicate with an empty committed set; a genuine git failure degrades to
the disclosed legacy behavior with an operator-visible warning.

Also corrected: the stale `planLeanTurboLanes` JSDoc claim that production callers
build the predicate from a builder that was deleted from the tree, and the Epic
maintainer guide now documents the new Lean→Epic consumer seam.
