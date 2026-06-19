# Outcome-Based Skill Maturity Gates

## What changed

- **Outcome-track maturity**: Knowledge entries with a positive outcome track record can now bypass the previous confidence/confirmation floors, accelerating skill compilation for proven content.
- **Negative outcome blocking**: Any entry carrying a negative outcome signal always blocks promotion, regardless of confidence or confirmation counts.
- **Phase-aware confirmation counting**: Confirmation counting now uses distinct phase numbers to avoid double-counting across maturity phases.
- **Configurable confidence floor**: Replaced the hardcoded `0.85` fallback with `DEFAULT_SKILL_MIN_CONFIDENCE` (0.7), making the threshold explicit and centrally configurable.
- **Documentation refresh**: Updated docs to reflect the accurate outcome-aware gate logic.

## Why

PR #1378 introduces outcome-based maturity gates for knowledge-to-skill compilation. The previous static confidence/confirmation floors were too conservative for proven content and did not distinguish between positive and negative outcome signals. These changes let reliable knowledge compile faster while keeping the safety floor for anything that has ever produced a negative outcome.
