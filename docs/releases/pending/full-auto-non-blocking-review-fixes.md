# Full-Auto non-blocking review fixes

## Overview

Addresses medium-severity follow-up findings from the full-auto v2 review.

## Fixes

- Tightened phase-approval evidence matching so records without an explicit `phase` no longer satisfy phase-boundary approval checks.
- Aligned legacy full-auto intercept event persistence to fail closed: event write failures are now propagated instead of silently swallowed.
- Updated full-auto delegation warning-event persistence to propagate write failures so audit loss cannot fail silently.
- Extracted a shared critic response parser used by both legacy intercept and v2 oversight paths, and aligned verdict parsing so `PENDING` is accepted consistently.

## Tests

- Added phase-approval regression coverage for missing-phase evidence.
- Added intercept parser coverage for `PENDING` verdict.
- Added failure-path tests ensuring intercept/delegation event writer failures are surfaced.
