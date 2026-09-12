// This fixture intentionally terminates the child with SIGKILL. The authority
// test skips the signal assertion on Windows, where Bun does not expose POSIX
// signal termination semantics. SIGKILL is uncatchable, so a successful helper
// exit cannot be mistaken for a normal fixture exit.
// Bun can execute a test file in a worker process. Killing process.pid would
// then only kill that worker; the parent `bun test` process can observe the
// worker failure and exit 0, so the validation authority incorrectly records a
// pass. Signal the worker's parent instead: it is the actual `bun test`
// process that the authority spawned. Keep the signal in an external utility
// so Bun's test harness cannot defer or otherwise intercept its delivery.
let signaler: Bun.Subprocess;
try {
	signaler = Bun.spawn(['kill', '-KILL', String(process.ppid)], {
		cwd: process.cwd(),
		stdin: 'ignore',
		stdout: 'ignore',
		stderr: 'ignore',
		timeout: 1_000,
		windowsHide: true,
	});
} catch {
	// Keep the fixture fail-closed if the kill utility is unavailable.
	process.abort();
}

// The helper must remain asynchronous so it can deliver the signal while this
// fixture's event loop is still running. A spawn error is handled above and an
// asynchronous nonzero exit is handled here; the helper's timeout bounds any
// failed launch without making the fixture wait synchronously.
void (async () => {
	try {
		const exitCode = await signaler.exited;
		if (exitCode !== 0) process.abort();
	} catch {
		process.abort();
	} finally {
		try {
			signaler.kill();
		} catch {
			// The helper may already have exited; the fixture's signal remains
			// the authoritative termination path.
		}
	}
})();
