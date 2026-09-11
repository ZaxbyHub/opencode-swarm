// This fixture intentionally terminates the child with SIGKILL. The authority
// test skips the signal assertion on Windows, where Bun does not expose POSIX
// signal termination semantics. SIGKILL is uncatchable, so a successful helper
// exit cannot be mistaken for a normal fixture exit.
// Send the signal from the platform's kill utility so Bun's test harness cannot
// defer or otherwise intercept the fixture's own signal delivery.
let signaler: Bun.Subprocess;
try {
	signaler = Bun.spawn(['kill', '-KILL', String(process.pid)], {
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
