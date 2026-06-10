### Council: HIGH/CRITICAL concerns are now blocking

Council members returning `CONCERNS` with HIGH or CRITICAL severity findings now have those findings promoted from `advisoryFindings` to `requiredFixes`. When blocking concerns exist, the council tools (`submit_council_verdicts`, `submit_phase_council_verdicts`, `write_final_council_evidence`) return `success: false` with `reason: 'blocking_concerns_unresolved'` — no evidence file is written and the architect must resolve all promoted findings before resubmitting.

- Added `CRITICAL` severity level to `CouncilFindingSeverity`
- Added `blockingConcernsCount` field to `CouncilSynthesis`, `PhaseCouncilSynthesis`, and `FinalCouncilSynthesis`
- Tool-level enforcement: HIGH/CRITICAL concerns block regardless of `phaseConcernsAllowComplete` config
- BLOCKING CONCERNS banner appears in `unifiedFeedbackMd` when promoted findings exist
- `addMutationGapFindingToSynthesis` now routes CRITICAL findings to `requiredFixes`
