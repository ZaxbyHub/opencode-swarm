import { spawnSync } from 'node:child_process';

// This fixture intentionally terminates the child with a signal. The authority
// test skips the signal assertion on Windows, where Bun does not expose POSIX
// signal termination semantics.
// Send the signal from an external process so Bun's test harness cannot defer
// or otherwise intercept the fixture's own signal delivery.
const signaler = spawnSync(
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

// Keep the fixture fail-closed if the external signal helper is unavailable.
if (signaler.error || signaler.status !== 0) process.abort();
