# Provenance Verification for Architect-Relayed Evidence Tools

## Summary

Hardened architect-relayed evidence tools with verdict provenance verification to strengthen security against compromised architects fabricating evidence verdicts. This is a follow-up security enhancement to issue #893 (PR #1053, finding F-001).

## Changes

- **Three evidence tools** now capture optional provenance metadata:
  - `write_architecture_supervisor_evidence`: accepts `provenance_agent_name` and `provenance_session_id` args
  - `write_drift_evidence`: accepts `provenanceAgentName` and `provenanceSessionId` args
  - `submit_phase_council_verdicts`: accepts `provenanceAgentName` and `provenanceSessionId` args

- **Three evidence gates** now verify provenance when present:
  - `architecture-supervisor-gate`: supports `provenance_verify` config flag for fail-closed mode; advisory warning when provenance missing (default)
  - `drift-gate`: advisory warning when evidence lacks provenance
  - `phase-council-gate`: advisory warning when evidence lacks provenance

- **Schema updates**:
  - New `EvidenceProvenanceSchema` with optional `agent_name`, `session_id`, `captured_at` fields
  - `ArchitectureSupervisorReportSchema` now includes optional `provenance` field
  - Sidecar write paths updated to preserve provenance

## Backwards Compatibility

✓ **Fully backwards compatible**: provenance is optional on evidence reads and writes. Evidence without provenance is accepted (with advisory warning), matching the existing fail-open semantics.

## Migration

- **No migration required** for existing deployments
- To enable provenance verification enforcement: set `architectural_supervision.provenance_verify: true` in `.opencode/opencode-swarm.json`
- Evidence tools should pass provenance fields when dispatching supervisor/council agents (optional but recommended)

## Security Impact

- Reduces risk of compromised architects bypassing critical gates by fabricating evidence
- Does not retroactively protect against bypasses that occurred before this version
- Enforcement is opt-in (`provenance_verify` config flag) to preserve backwards compatibility
