# First-class PR Review mode with quality hardening

### What changed
- Added `MODE: PR_REVIEW` as a first-class mode in the architect prompt (`src/agents/architect.ts`). The mode activates via `[MODE: PR_REVIEW pr="..." council=true/false]` signal from the existing `pr-review` command handler and loads the `swarm-pr-review` skill.
- Hardened both `.opencode/skills/swarm-pr-review/SKILL.md` and `.claude/skills/swarm-pr-review/SKILL.md` with quality-over-speed mandates:
  - **Quality is the only metric** — explicit operating stance and Hard Rule #0
  - **Universal validation** — all non-suppressed candidate findings must be reviewer-validated regardless of severity
  - **Noise budget** — 3 strict suppression criteria (purely stylistic, exact duplicate, confidence=LOW with zero structural evidence) with mandatory disclosure of every suppressed candidate
  - **Expanded critic scope** — borderline MEDIUM findings involving security, state machines, write authority, evidence integrity, model/tool permissions, git safety, or config ratcheting now get critic-challenged alongside HIGH/CRITICAL
  - **Council-mode parity** — Claude council agents return `EVIDENCE_FOUND` (not `CONFIRMED`) and critic challenge includes borderline findings, matching the `.opencode` anti-self-review rule

### Why
The PR review skill previously prioritized speed over thoroughness. Deep-dive audits showed that LOW-severity findings were sometimes skipped, borderline MEDIUM security findings escaped critic challenge, and council-mode agents could self-confirm findings. These gaps undermined review quality.

### Migration
No migration required. The `MODE: PR_REVIEW` signal is emitted by the existing `/swarm pr-review` command. The quality mandate applies automatically to all future PR reviews.

### Known caveats
- The `.opencode` skill references `prm_scorer` in Phase 5 verifier routing — this is aspirational/planned and not yet implemented in the codebase (pre-existing, not introduced by this PR)
- No feature-flag strip path for `MODE: PR_REVIEW` in architect.ts (unlike `DESIGN_DOCS`); the pr-review command is unconditionally registered so this has no current impact
- `.claude/skills/swarm-pr-review/SKILL.md` is an intentionally condensed 6-phase variant (~377 lines) for Claude Code sessions. `.opencode/skills/swarm-pr-review/SKILL.md` is the full 12-phase operative protocol (~883 lines) loaded by `architect.ts MODE: PR_REVIEW`. Both receive the same quality hardening additions; the structural difference is pre-existing design. The divergence is explicitly acknowledged in `tests/unit/skills/skill-mirrors.test.ts` under `DIVERGENT_ARCHITECT_MODE_SKILLS`.
