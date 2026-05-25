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
