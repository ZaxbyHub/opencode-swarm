## Knowledge Learning Loop Remediation

Remediates 22 verified audit findings across the skills and knowledge learning loop,
enabling continuous agent performance improvement through a closed feedback system.

### Knowledge Store
- Add atomic `rewriteKnowledge` (temp+rename) and `bumpKnowledgeConfidenceBatch`
- Enforce configurable knowledge cap with FIFO eviction
- Add `resolveSwarmKnowledgePath` for safe path resolution

### Feedback Loop
- New `applySkillUsageFeedback` hook closes the skill→knowledge→skill loop
- Phase-complete feedback writes usage signals to knowledge confidence
- Idempotent processing via `.swarm/skill-usage-last-processed.json` marker
- Fail-open: feedback errors never block phase completion

### Curator Hardening
- Auto-retire skills when all source knowledge entries are archived
- Spec-based drift detection with `extractRequirementIds` for requirement coverage
- Persist curator findings per-phase to `.swarm/evidence/{phase}/curator-findings.json`
- Dual knowledge store reads (swarm+hive) for confidence aggregation

### Skill Lifecycle
- New `regenerateSkill` tool with archived-entry filtering before rendering
- New `retireSkill` tool with marker-based retirement (reversible)
- Skill descriptions dynamically read from SKILL.md frontmatter (with comma sanitization)
- `listSkills` excludes retired skills from active listing

### Knowledge Application Gate
- Configurable `high_risk_tools` via `config.high_risk_tools`
- Session-scoped warning events for high-risk tool usage
- Delta aggregation deduplicates by knowledge ID before applying

### Tool Wrapper Tests (265+ new tests)
- 167 tool wrapper tests across 6 tools (knowledge-ack, skill-list, skill-generate,
  skill-apply, skill-inspect, skill-improve)
- 18 regenerateSkill tests including archived-entry filter validation
- 8 integration tests for full learning loop pipeline
- 117 curator tests, 64 drift tests, 20 application-gate tests, 158 propagation-gate tests

### Remediation Matrix

| Finding | Description | Fix |
|---------|-------------|-----|
| A-001 | Knowledge store lacks atomic rewrite | `rewriteKnowledge` with temp+rename (F-001 fix) |
| A-002 | No batch confidence bump | `bumpKnowledgeConfidenceBatch` in knowledge-store.ts |
| A-003 | No knowledge cap enforcement | `enforceKnowledgeCap` with FIFO eviction |
| A-004 | No path resolution safety | `resolveSwarmKnowledgePath` |
| A-005 | No feedback loop | `applySkillUsageFeedback` in skill-usage-log.ts |
| A-006 | Phase-complete doesn't close loop | Feedback bridge in phase-complete.ts |
| A-007 | No idempotent processing | `.swarm/skill-usage-last-processed.json` marker |
| A-008 | Feedback errors could block | Fail-open try/catch around feedback |
| A-009 | No auto-retire for stale skills | `autoRetireSkills` in curator.ts |
| A-010 | No spec-based drift detection | `extractRequirementIds` + curator-drift.ts |
| A-011 | Curator findings not persisted | Per-phase `curator-findings.json` |
| A-012 | Single-store confidence read | Dual swarm+hive knowledge reads |
| A-013 | No skill regeneration tool | `regenerateSkill` tool (skill-regenerate.ts) |
| A-014 | Archived entries not filtered | Post-filter in regenerateSkill (lines 923-952) |
| A-015 | No skill retirement tool | `retireSkill` tool (skill-retire.ts) |
| A-016 | Skill descriptions hardcoded | Dynamic `readSkillMetadata` from frontmatter |
| A-017 | Comma parsing corruption | Comma sanitization in skill descriptions |
| A-018 | HIGH_RISK_TOOLS not configurable | `config.high_risk_tools` with fallback (F-004 fix) |
| A-019 | No session-scoped warnings | SessionID warn event in application gate |
| A-020 | Delta stacking on duplicates | Deduplicate by knowledge ID before applying |
| A-021 | Propagation gate section replacement fragile | Regex-based `## Available Skills` replacement |
| A-022 | Context.md section replacement fragile | Regex-based section replacement |
