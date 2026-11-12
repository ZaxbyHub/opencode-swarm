// This fixture intentionally terminates the child process GROUP with SIGKILL
// (issue #2738). The authority harness spawns `bun test` with detached: true,
// which makes it a process-group and session leader (Bun maps detached to
// POSIX_SPAWN_SETSID, including the macOS non-PTY posix_spawn path); every
// process `bun test` spawns — workers, supervisors, this fixture — inherits
// that group. `kill -KILL 0` targets the caller's whole process group, so it
// terminates the authority-spawned `bun test` process and all of its
// descendants regardless of Bun's internal worker topology. That topology
// independence is the point: the previous parent-pid design assumed the
// fixture's parent WAS the spawned `bun test` process; when Bun
// 1.3.13 on macos-latest broke that assumption, the signal missed the
// authority's child, the fixture's own abort killed only a worker, `bun test`
// observed the worker failure and exited 0, and the authority mis-recorded a
// pass (9/9 CI failures, PRs #2735/#2736). SIGKILL is uncatchable, and the
// outer test runner lives in a different session, so the group kill cannot
// escape the harness's detached child tree.
// SAFETY PRECONDITION: this fixture is valid ONLY under the harness's
// detached spawn (scripts/ci/repository-validation.ts); the crash-contract
// guardrail test pins that `detached: true` stays in place, because a
// non-detached child would share the outer runner's process group. Authority
// fixture only — never run as a standalone test.
// Keep the signal in an external utility so Bun's test harness cannot defer
// or otherwise intercept its delivery.
let signaler: Bun.Subprocess;
try {
	signaler = Bun.spawn(['kill', '-KILL', '0'], {
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
