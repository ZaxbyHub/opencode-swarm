# PR review lane coverage now blocks degraded reviews

## Summary

- Strengthened `/swarm pr-review` guidance so the architect launches all six fixed base lanes, evaluates triggered micro-lanes, keeps working while async lanes dispatch/collect, and does not synthesize while lane coverage is open.
- Clarified fallback order across PR review and related async review modes: retry/re-collect async lanes, use blocking `dispatch_lanes`, then use Task-tool dispatch only as a verified-equivalent final fallback when lane tools do not work.
- Replaced partial/INCOMPLETE review allowances with a hard BLOCKED stop: if required lane coverage cannot be closed or equivalence cannot be proven, the architect surfaces the lane failure to the user instead of producing a degraded review.

## Testing

- Updated focused prompt/skill/help regression tests for PR review lane coverage, Task fallback, and non-idling async collection guidance.
