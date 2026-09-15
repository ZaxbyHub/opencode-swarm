import { _internals as loopInternals } from '../../src/background/pr-feedback-loop.js';

let loopInternalsTail = Promise.resolve();

/**
 * Serialize tests that mutate the process-wide PR feedback loop DI seams.
 * Bun may co-run these files in one worker, so a per-file snapshot is not
 * sufficient while an async pipeline is still awaiting a sibling seam.
 */
export async function acquireLoopInternals(): Promise<() => void> {
	const predecessor = loopInternalsTail;
	let release!: () => void;
	loopInternalsTail = new Promise<void>((resolve) => {
		release = resolve;
	});
	await predecessor;
	return release;
}
