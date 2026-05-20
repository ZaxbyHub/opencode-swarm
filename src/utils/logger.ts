function isDebug(): boolean {
	return process.env.OPENCODE_SWARM_DEBUG === '1';
}

export function log(message: string, data?: unknown): void {
	if (!isDebug()) return;

	const timestamp = new Date().toISOString();
	if (data !== undefined) {
		console.log(`[opencode-swarm ${timestamp}] ${message}`, data);
	} else {
		console.log(`[opencode-swarm ${timestamp}] ${message}`);
	}
}

export function warn(message: string, data?: unknown): void {
	if (!isDebug()) return;
	const timestamp = new Date().toISOString();
	if (data !== undefined) {
		console.warn(`[opencode-swarm ${timestamp}] WARN: ${message}`, data);
	} else {
		console.warn(`[opencode-swarm ${timestamp}] WARN: ${message}`);
	}
}

export function error(message: string, data?: unknown): void {
	const timestamp = new Date().toISOString();
	if (data !== undefined) {
		console.error(`[opencode-swarm ${timestamp}] ERROR: ${message}`, data);
	} else {
		console.error(`[opencode-swarm ${timestamp}] ERROR: ${message}`);
	}
}

/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export const _internals: {
	isDebug: typeof isDebug;
	log: typeof log;
	warn: typeof warn;
	error: typeof error;
} = {
	isDebug,
	log,
	warn,
	error,
} as const;
