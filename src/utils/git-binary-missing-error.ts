export class GitBinaryMissingError extends Error {
	override readonly name = 'GitBinaryMissingError';

	constructor(message = 'git binary is not available', options?: { cause?: unknown }) {
		super(message, options);
	}
}

export function isGitBinaryMissing(err: unknown): err is { code?: string } {
	return (
		typeof err === 'object' &&
		err !== null &&
		'code' in err &&
		(err as { code?: string }).code === 'ENOENT'
	);
}
