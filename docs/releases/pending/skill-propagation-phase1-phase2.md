# Skill Propagation: Phase 1 & Phase 2 Enhancements

## What changed

### Phase 1: Enhanced Skill Propagation Gate

Extended the `skillPropagationGateBefore` function to provide intelligent skill recommendations and auto-injection:

- **Extended return type**: `skillPropagationGateBefore` now returns `recommendedSkills` array alongside `blocked` and `reason` fields, providing ranked skill recommendations based on relevance scoring
- **Auto-injection of SKILLS field**: When delegating to skill-capable agents without a `SKILLS:` field, the system now auto-populates skill recommendations that can be injected into the delegation prompt
- **Guardrails added**:
  - Relevance scoring threshold: 0.5 (skills below this score are not recommended)
  - Maximum recommendations cap: 5 skills per delegation
  - Fallback behavior: When `SKILLS: none` is explicitly set, warnings are suppressed
- **Audit logging**: All skill delegations are now recorded to `.swarm/skill-usage.jsonl` with:
  - Skill path
  - Agent name
  - Task ID
  - Compliance verdict
  - Session ID
  - Timestamp

### Phase 2: Skill Routing Configuration

Created a companion routing system for explicit agent-to-skill mapping:

- **New file**: `.opencode/skill-routing.yaml` — maps agent types to skill paths that should be auto-injected
- **Companion file reader**: Added `loadRoutingSkills()` function that reads the routing configuration at delegation time
- **Skill descriptions**: Enhanced the routing format to include optional `keywords` array for each skill entry, providing context for when the skill is most relevant
- **Integration with scoring**: Routing skills are merged with scored recommendations, with explicitly routed skills receiving a boosted score (0.9) to prioritize them

## Why

**Phase 1** addressed the gap between skill discovery and skill usage. Previously, the skill propagation gate only warned when skills were missing but provided no guidance on which skills to use. The enhanced gate now:

1. Scores all available skills by relevance to the task
2. Returns the top 5 recommendations with scores and usage counts
3. Auto-populates `.swarm/context.md` with an "Available Skills" section
4. Provides visible warnings when delegations lack the `SKILLS:` field

**Phase 2** added an explicit routing layer for teams that want deterministic skill assignment. The `skill-routing.yaml` file allows:

1. **Agent-specific skill routing**: Define exactly which skills each agent type should receive
2. **Keyword-based filtering**: Optional keywords help document when each skill is most relevant
3. **Priority boosting**: Routed skills get a high score (0.9) to ensure they appear in recommendations
4. **Graceful degradation**: When the routing file is absent, the system falls back to scoring-only

## Migration steps

No migration required. Both phases are backward compatible:

1. The `recommendedSkills` return value is optional — existing callers can ignore it
2. The routing file is optional — the system works in scoring-only mode when absent
3. Guardrails default to sensible values (threshold 0.5, cap 5)

## Configuration

The skill propagation system is configured via `opencode-swarm.json`:

```json
{
  "skill_propagation": {
    "enabled": true,
    "enforce": false,
    "scoring": {
      "threshold": 0.5,
      "max_recommendations": 5
    }
  }
}
```

## Known caveats

- **Scoring budget safeguard**: When a session exceeds 500 skill-usage entries, scoring is skipped to prevent unbounded file reads. Skills are sorted alphabetically as a fallback.
- **Enforce mode**: Currently requires programmatic configuration — not yet wired to the project config schema.
- **Routing file format**: Only supports a simple YAML structure. Complex nested configurations are not yet supported.

## Files changed

- `src/hooks/skill-propagation-gate.ts` — Extended `skillPropagationGateBefore` return type, added `loadRoutingSkills()` function
- `src/hooks/skill-scoring.ts` — Added relevance scoring with threshold and cap
- `.opencode/skill-routing.yaml` — New companion routing configuration file

## Testing

- Unit tests for `loadRoutingSkills()` — 15 tests covering YAML parsing, error handling, and agent routing
- Integration tests for skill recommendation flow — 22 tests covering scoring thresholds, caps, and merge behavior
- Adversarial tests for guardrail enforcement — 8 tests covering edge cases and failure modes
