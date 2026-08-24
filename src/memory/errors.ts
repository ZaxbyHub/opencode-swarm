export class MemoryValidationError extends Error {
	readonly code: string;

	constructor(message: string, code = 'memory_validation_error') {
		super(message);
		this.name = 'MemoryValidationError';
		this.code = code;
	}
}

export class MemoryDisabledError extends Error {
	constructor(message = 'Swarm memory is disabled') {
		super(message);
		this.name = 'MemoryDisabledError';
	}
}

/**
 * #1466: the configured PiiDetector could not run. Thrown fail-closed — an
 * operator who opted into `memory.redaction.piiDetector: 'ner'` (or into
 * PII rejection) must get an actionable error, not a silent skip of the
 * privacy control or a raw ERR_MODULE_NOT_FOUND.
 *
 * PR #2310 feedback (PRR-016): extends MemoryValidationError so gateway and
 * tool-layer callers that branch on the validation-error family (and the
 * `code` field) handle the opt-in-misconfiguration case through the same
 * contract as every other write-boundary rejection.
 */
export class MemoryPiiDetectorError extends MemoryValidationError {
	constructor(message: string) {
		super(message, 'memory_pii_detector_error');
		this.name = 'MemoryPiiDetectorError';
	}
}
