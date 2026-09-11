import { spawn } from 'node:child_process';

// This fixture intentionally terminates the child with a signal. The authority
// test skips the signal assertion on Windows, where Bun does not expose POSIX
// signal termination semantics.
// Send the signal from an external process so Bun's test harness cannot defer
// or otherwise intercept the fixture's own signal delivery.
let signaler: ReturnType<typeof spawn>;
try {
	signaler = spawn(
		process.execPath,
		['-e', `process.kill(${process.pid}, 'SIGABRT')`],
		{
			cwd: process.cwd(),
			stdin: 'ignore',
			stdout: 'ignore',
			stderr: 'ignore',
			timeout: 1_000,
			windowsHide: true,
		},
	);
} catch {
	// Keep the fixture fail-closed if the external signal helper is unavailable.
	process.abort();
}

// The helper must remain asynchronous so it can deliver the signal while this
// fixture's event loop is still running. A spawn error is handled above and an
// asynchronous error is handled here; the helper's timeout bounds any failed
// launch without making the fixture wait synchronously.
signaler?.once('error', () => process.abort());
