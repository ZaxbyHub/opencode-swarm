# Disable contradiction detector false-positives (issue #1295)

## What changed

Disabled the `detectContradiction` function in the knowledge validator's Layer 3 semantic quality checks. The detector was incorrectly flagging semantically equivalent lessons as contradictions when they shared tags and contained opposite negation words.

**Example false positive:**
- "Always run tests before commit" 
- "Never commit without running tests"

These lessons agree semantically but were rejected as contradictions because they share the `testing` tag and contain opposite negation words (`always` vs `never`). The word-presence detection algorithm cannot distinguish between genuine contradictions and semantically equivalent reformulations.

## Why

The contradiction detector uses a naive word-presence heuristic that checks if candidate and existing lessons:
1. Share ≥1 inferred tag
2. Contain opposite halves of hardcoded negation pairs (`always/never`, `use/avoid`, `enable/disable`)

This approach lacks proposition-level semantic understanding. It flags any negation pair + shared tag as a contradiction, even when the negation words apply to different concepts or when both lessons express the same rule negatively vs positively.

Legitimate reinforcement of agreeing lessons was being lost, and false positives were polluting the rejected lessons log, actively teaching the architect to avoid correct lessons.

## How to use

**Behavioral change:** Lessons that were previously rejected as false-positive contradictions are now stored and available in the knowledge base. Architects may see fewer rejection warnings in rejected-lessons logs. The vagueness check (Layer 3 semantic quality) remains active for detecting overly vague lessons without concrete references.

## Migration

No migration required. The detector was not documented as a feature; it was an internal heuristic that could be safely disabled. If genuine contradictions need to be detected in the future, a smarter algorithm that understands semantic context (not just word presence) will be required.

## Known caveats

- The `detectContradiction` function definition remains in the code (commented out) for future re-implementation with a smarter algorithm.
- Genuine contradictions ("always use tabs" vs "never use tabs") are no longer flagged. This is acceptable because:
  1. True contradictions are rare in practice
  2. Curator/human adjudication can surface them when needed
  3. The existing mechanism provides no basis for automated detection without semantic analysis
