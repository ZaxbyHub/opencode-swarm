## Summary

- Hardened `submit_council_verdicts` against quorum bypass retries by tracking required absent members per task/round in session state and rejecting cherry-picked re-dispatch attempts.
- Added dissenter carry-forward requirements so members who returned `CONCERNS`/`REJECT` in round _N_ must be present in round _N+1_.
- Added optional `verdictRound` on `CouncilMemberVerdict` and reject stale prior-round verdict submissions in later rounds.
- Updated architect council workflow prompt guidance and added focused unit/adversarial regression coverage for these quorum-integrity gaps.
