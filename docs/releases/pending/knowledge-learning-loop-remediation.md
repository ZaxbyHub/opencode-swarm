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
