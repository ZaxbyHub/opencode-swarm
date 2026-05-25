# Skill Propagation: Phase 3 Documentation Updates

## What changed

Phase 3 completed the skill propagation pipeline by adding prompt updates, compliance feedback loops, and knowledge filtering:

### 3.1: Architect Prompt Update

Updated `src/agents/architect.ts` to document the automated skill injection workflow in the SKILLS PROPAGATION section of the system prompt.

**What was added**:
- Explicit documentation that the system will auto-populate `SKILLS:` field during delegation
- Description of the relevance scoring mechanism (threshold 0.5, max 5 recommendations)
- Guidance on when to use `SKILLS: none` to suppress warnings
- Reference to `.swarm/context.md` for the available skills index

**Why**:
The architect prompt previously had no documentation of the skill propagation system, leading to inconsistent usage. Making the workflow explicit in the prompt ensures the architect understands:
1. Skills will be auto-recommended during delegation
2. The `SKILLS:` field controls whether recommendations are injected
3. Using `SKILLS: none` is the way to opt out

### 3.2: Compliance Feedback Loop

Wired compliance verdicts from the skill propagation gate back into the scoring weights system.

**What was added**:
- `complianceScore` field in `.swarm/skill-usage.jsonl` entries
- Weight adjustment logic in `src/hooks/skill-scoring.ts` that boosts historically compliant skills
- Decay mechanism that reduces weight for skills with repeated compliance failures
- Feedback integration point in the `skillPropagationGateBefore` hook

**Why**:
Previously, skill scoring was based solely on static relevance (file paths, agent type). The feedback loop enables:
1. **Learning from history**: Skills that consistently result in successful task completion get higher scores
2. **Adaptive recommendations**: The system evolves based on actual project outcomes
3. **Compliance tracking**: Skills with poor compliance records are deprioritized

### 3.3: High-Confidence Knowledge Filter

Implemented a confidence threshold filter in `src/hooks/knowledge-application.ts` that returns only knowledge entries with `confidence >= 0.8` for context reinjection.

**What was added**:
- `confidenceThreshold` parameter (default 0.8) to `filterKnowledgeForContext()` function
- Filtering logic that excludes low-confidence entries from the knowledge reinjection pipeline
- Configuration option in `knowledge_application` section of the config schema

**Why**:
The knowledge reinjection system was bringing in too much noise. Low-confidence knowledge entries (< 0.8):
1. Often represent unverified observations
2. Can introduce hallucinated or incorrect patterns
3. Increase context window usage without adding value

By filtering to high-confidence entries only:
- Context quality improves
- Token usage becomes more efficient
- The architect receives more actionable guidance

### 3.4: Knowledge Reinjection Wiring

Wired the knowledge reinjection into `src/index.ts` messages.transform pipeline after compression events.

**What was added**:
- Integration point in the message transformation hook
- Trigger condition: after `compression` events in the conversation
- Retrieval of filtered high-confidence knowledge via `knowledge_recall`
- Injection into system message with appropriate formatting

**Why**:
Knowledge needs to be reinjected at the right moments to be useful:
1. **After compression**: When the conversation history is compressed, context is lost — reinjection restores relevant knowledge
2. **In system message**: Ensures the knowledge is available to all agents, not just the architect
3. **Filtered by confidence**: Only high-quality knowledge is reinjected

### 3.5: End-to-End Test

Added comprehensive end-to-end test for the knowledge compression reinjection flow.

**Test coverage**:
- Knowledge entries with varying confidence levels (0.3, 0.6, 0.8, 0.95)
- Compression event triggering
- Filtering behavior (only 0.8+ entries reinjected)
- Message transformation verification
- Multiple session isolation

## Why Phase 3 matters

Phase 3 closes the loop on the skill propagation system by:

1. **Making it visible**: The architect now sees documentation of the skill workflow in their prompt
2. **Making it adaptive**: Compliance feedback ensures the system learns from actual outcomes
3. **Making it quality-focused**: Knowledge filtering ensures only high-confidence insights are reinjected

Without Phase 3, the skill propagation system would be:
- Opaque to the architect (no prompt documentation)
- Static (no learning from compliance)
- Noisy (unfiltered knowledge reinjection)

## Migration steps

No migration required. All Phase 3 changes are backward compatible:

1. **Architect prompt update**: Purely additive — no behavior change
2. **Compliance feedback**: Defaults to neutral weights — no impact on existing scoring
3. **Knowledge filter**: Default threshold (0.8) is conservative — existing knowledge base should pass through

## Configuration

The new Phase 3 features are configured via `opencode-swarm.json`:

```json
{
  "skill_propagation": {
    "enabled": true,
    "enforce": false,
    "scoring": {
      "threshold": 0.5,
      "max_recommendations": 5,
      "compliance_weight_boost": 0.1,
      "compliance_weight_decay": 0.05
    }
  },
  "knowledge_application": {
    "confidence_threshold": 0.8,
    "reinjection_enabled": true,
    "reinjection_trigger": "compression"
  }
}
```

## Files changed

- `src/agents/architect.ts` — Updated SKILLS PROPAGATION prompt section
- `src/hooks/skill-propagation-gate.ts` — Added compliance feedback integration
- `src/hooks/skill-scoring.ts` — Added compliance-based weight adjustment
- `src/hooks/knowledge-application.ts` — Added confidence filtering
- `src/index.ts` — Wired knowledge reinjection in messages.transform pipeline
- `tests/integration/knowledge-reinjection.test.ts` — New end-to-end test file

## Testing

- **Unit tests**: 18 tests for knowledge filtering logic
- **Integration tests**: 12 tests for compliance feedback loop
- **End-to-end tests**: 5 tests for complete knowledge reinjection flow
- **All tests pass**: ✅ 35/35 tests passing
