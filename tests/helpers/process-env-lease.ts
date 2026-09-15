let processEnvTail = Promise.resolve();

/**
 * Serialize tests that mutate process-wide environment variables.
 * Bun may co-run test files in one worker, so restoring a per-file snapshot
 * is not sufficient while a sibling's async test is still using the env.
 */
export async function acquireProcessEnvLease(): Promise<() => void> {
	const predecessor = processEnvTail;
	let release!: () => void;
	let released = false;
	processEnvTail = new Promise<void>((resolve) => {
		release = () => {
			if (released) return;
			released = true;
			resolve();
		};
	});
	await predecessor;
	return release;
}
