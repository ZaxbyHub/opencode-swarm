docs(skills): align lane-dispatching skills with the async fan-out SOTA pattern

What changed:
- Propagated the async-lane + complexity-scaled fan-out + disjoint-partition
  pattern (established for the codebase reality check in
  async-fanout-codebase-reality-check) to the other skills that dispatch
  read-only lanes. These are documentation/guidance edits — no code or tool
  changes; the lane tools already support every pattern referenced.
- swarm-pr-feedback: verification lanes now state a MAX_LANES=8 cap with
  sequential batching beyond 8, scale the lane count to ledger size, partition
  the ledger so each FB-### item is owned by exactly one lane (union covers the
  whole ledger), and poll `collect_lane_results` incrementally before the
  terminal `wait: true` settle.
- deep-research: the sme-synthesis collect now polls incrementally
  (`collect_lane_results` with wait omitted/false) before the terminal
  `wait: true` join, instead of jumping straight to a blocking join; the hard
  "do not advance to Step 5 until every synthesis lane is settled" barrier is
  preserved.
- deep-dive: `max_explorers` is reframed as a CAP (not a fixed default) with
  explicit complexity scaling (trivial 1–2, typical 3–5, large up to the cap),
  and explorer file-missions now carry a disjoint-partition + union-coverage
  contract (no file in two missions; every scope-map file assigned).
- swarm-pr-review: documented WHY the base wave is a fixed six check-type lanes
  (correctness/security/deps/docs/tests/performance) that deliberately overlap
  by file — the deliberate exception to surface-scaled fan-out — and why the
  disjoint-partition rule does not apply to these lanes. The count stays a fixed
  six by design (consistent with the existing /6 Mandatory Pre-Synthesis Gate
  and zero-tolerance COVERAGE GATE).
- codebase-review-swarm/references/review-protocol-v8.2.md: justified the
  Phase-0 two-agent concurrency cap (the 0A→0J inventory units form a largely
  sequential dependency chain, so concurrency is capped at 2 by design rather
  than scaled toward the 8-lane limit).

Why:
- After making the codebase reality check async-by-default and fanned-out, an
  audit found the other lane-dispatching skills were inconsistent with that
  pattern: some lacked a fan-out cap or scaling, some jumped to a blocking join
  without the incremental-poll lever, and some had unjustified fixed lane counts
  that read as magic numbers. Aligning them keeps the dispatch discipline
  consistent across the architect's read-only fan-outs.

Scope: documentation/skill guidance only. Files:
`.opencode/skills/swarm-pr-feedback/SKILL.md`,
`.opencode/skills/deep-research/SKILL.md`,
`.claude/skills/deep-research/SKILL.md` (mirror),
`.opencode/skills/deep-dive/SKILL.md`,
`.claude/skills/deep-dive/SKILL.md` (mirror),
`.opencode/skills/swarm-pr-review/SKILL.md`,
`.opencode/skills/codebase-review-swarm/references/review-protocol-v8.2.md`.

Deliberately left unchanged (intentional-by-design, not gaps): council's fixed
three-member General Council (the size is fixed by the NSED peer-review
protocol: generalist/skeptic/domain-expert triad), deep-research's bounded
max_researchers (defined as integer 1..6 by the deep-research protocol, below the
8-lane dispatch cap), and codebase-review-swarm's already-SOTA async/settlement
discipline.

Migration: none. All settlement gates, COVERAGE GATEs, and fixed-count
invariants (e.g. swarm-pr-review's six base lanes) are preserved; the edits are
additive clarifications.
