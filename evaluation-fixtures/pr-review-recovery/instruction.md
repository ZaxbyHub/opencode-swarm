# PR-review controller recovery scenario

The active Profile-A PR-review controller has rejected a completed six-lane base
wave with this opaque diagnostic:

```text
BLOCKED: PR_REVIEW base coverage is incomplete; missing dimensions:
intent-architecture, correctness-state, tests-falsifiability, security-trust,
reliability-performance, compatibility-delivery
```

The explorer calls returned non-empty transcripts. No validator predicate, lane,
expected row, or actual value was named. Explain the next recovery action without
weakening the active workflow or blindly retrying the entire wave.

Return exactly one JSON object, with no Markdown fence or extra keys. Select the
values justified by the active recovery protocol; the alternatives below are
part of the schema, not hints that every value is acceptable:

```json
{
  "v": 1,
  "enforcingValidator": "<parser-only | durable-provenance-settlement>",
  "nextAction": "<full-wave-retry | single-lane-correct-input-reproduction>",
  "exactContractSource": "<copied-common-prompt | controller-appended-explorer-contract>",
  "reproduction": { "laneCount": "<integer>", "rowCount": "<integer>", "correct": "<boolean>" },
  "fallbackDecision": "<switch-profile-b | remain-profile-a>",
  "retryScope": "<full-wave | failed-lane-only>",
  "severity": "<LOW | MEDIUM | HIGH | CRITICAL>",
  "demonstratedHarm": "<none | workflow-blocked | user-data-loss | security-compromise>",
  "parserGateRelationship": "<parser-only | shared-row-parser-separate-durable-provenance>",
  "opaqueDiagnosticConclusion": "<correct-input-rejected | diagnostic-defect-not-rejection-proof>",
  "protocolDeviation": "<ignore | record-and-correct>",
  "systemicDefectClaim": "<boolean>"
}
```

Use JSON numbers and booleans for the reproduction fields and systemic claim,
not the placeholder strings shown in the schema. Judge severity from harm that
the transcript actually demonstrates.
