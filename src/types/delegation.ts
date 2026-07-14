/**
 * Delegation Envelope Types
 * Interface for passing delegated tasks between agents
 */

/**
 * M15: OPTIONAL structured spec criteria carried with a delegation so a
 * delegated coder receives spec-level acceptance / functional-requirement /
 * success-criteria detail as structured data — not only architect free-text.
 *
 * Every member is optional. A MISSING `specCriteria` (or any missing member)
 * is fully valid and MUST NOT trigger delegation rejection or advisory noise.
 * Only a POPULATED-but-malformed value (a non-string[] member) is flagged, and
 * even then advisory-only — never fail-closed.
 */
export interface DelegationSpecCriteria {
	/** Functional requirements the change must satisfy (e.g. "FR-006"). */
	fr?: string[];
	/** Success criteria / measurable outcomes (e.g. "SC-111"). */
	sc?: string[];
	/** Acceptance criteria the implementation must meet. */
	acceptance?: string[];
}

export interface DelegationEnvelope {
	taskId: string;
	targetAgent: string;
	action: string;
	commandType: 'task' | 'slash_command';
	files: string[];
	acceptanceCriteria: string[];
	technicalContext: string;
	errorStrategy?: 'FAIL_FAST' | 'BEST_EFFORT';
	platformNotes?: string;
	/**
	 * M15: OPTIONAL structured acceptance/FR/SC criteria. See
	 * {@link DelegationSpecCriteria}. Optional by contract — a missing field is
	 * valid and never causes rejection or advisory output.
	 */
	specCriteria?: DelegationSpecCriteria;
}

/**
 * Validation result types
 */
export type EnvelopeValidationResult =
	| { valid: true }
	| { valid: false; reason: string };
