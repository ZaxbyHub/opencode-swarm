# PR review lane coverage now blocks degraded reviews

## Summary

- Strengthened `/swarm pr-review` guidance so the architect launches all six fixed base lanes and all 11 mandatory repository-agnostic micro-lanes, keeps working while async lanes dispatch/collect, and does not synthesize while lane coverage is open.
- Clarified that blocking `dispatch_lanes` and direct Task calls cannot replace structured PR-review lanes because they lose required workflow/head provenance.
- Replaced partial/INCOMPLETE review allowances with a hard BLOCKED stop: if required lane coverage cannot be closed or equivalence cannot be proven, the architect surfaces the lane failure to the user instead of producing a degraded review.

## Testing

- Updated focused prompt/skill/help regression tests for PR review lane coverage, Task fallback, and non-idling async collection guidance.
