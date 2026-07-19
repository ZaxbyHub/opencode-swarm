/**
 * Single source of truth for the gate-bypass enumeration in Turbo enable messages.
 * Used by all four standard-Turbo enable return strings and by the registry help text.
 * Kept in a separate file to avoid circular-import issues between turbo.ts and registry.ts.
 */
export const TURBO_BYPASS_DISCLOSURE =
	'Bypassed: Stage B (reviewer + test_engineer) for Tier 0-2 tasks; phase_complete Gates 1-5 ' +
	'(completion-verify, drift-verifier, hallucination-guard, mutation-gate, phase-council). ' +
	'Still enforced: Stage A (lint, imports, pre_check_batch); Tier 3 Stage B; Gate 5b ' +
	'(architecture-supervisor); Gate 6 (final-council); Gate 7 (full-auto).';
