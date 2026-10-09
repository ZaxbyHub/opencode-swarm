/**
 * Single source of truth for the gate-bypass enumeration in Turbo enable messages.
 * Used by all four standard-Turbo enable return strings and by the registry help text.
 * Kept in a separate file to avoid circular-import issues between turbo.ts and registry.ts.
 */
export const TURBO_BYPASS_DISCLOSURE =
	'Bypassed: phase_complete Gates 1-5 ' +
	'(completion-verify, drift-verifier, hallucination-guard, mutation-gate, phase-council). ' +
	'Still enforced: Stage A (lint, imports, pre_check_batch); Stage B (reviewer + test_engineer) wherever its tier requires it; Gate 5b ' +
	'(architecture-supervisor); Gate 6 (final-council); Gate 7 (full-auto).';
