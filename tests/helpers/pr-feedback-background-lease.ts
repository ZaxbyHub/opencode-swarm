let backgroundSingletonTail = Promise.resolve();

/**
 * Serialize tests that mutate the PR feedback background singletons.
 *
 * Subscriber and delivery/runtime modules keep process-wide DI seams and
 * registration maps. Bun may co-run test files in one worker, so restoring a
 * per-file snapshot is not sufficient while a sibling test is still
 * awaiting one of those seams. Callers must acquire this lease before
 * snapshotting or mutating any of the three modules and release it only after
 * restoring seams and disposing registrations.
 */
export async function acquirePrFeedbackBackgroundLease(): Promise<() => void> {
	const predecessor = backgroundSingletonTail;
	let release!: () => void;
	let released = false;
	backgroundSingletonTail = new Promise<void>((resolve) => {
		release = () => {
			if (released) return;
			released = true;
			resolve();
		};
	});
	await predecessor;
	return release;
}
