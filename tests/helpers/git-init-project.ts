import { spawnSync } from 'node:child_process';

/**
 * Initialize a git repository for a test fixture, with full spawn diagnostics
 * (#3691): a process-level spawn failure (EMFILE, EBUSY, ENOENT-class
 * conditions under shard load) sets `result.error` and leaves the streams
 * empty — the historical `new Error(result.stderr || result.stdout)` shape
 * threw a bare `Error: ` with no diagnostic content in CI (run 43380165115:
 * 3/3 file-retry attempts failed identically at sub-second latency). This
 * helper always renders `status=` and `signal=` (including their null forms)
 * and includes the spawn error's message/code plus a bounded stderr tail, so
 * the next transient failure is diagnosable from the log line alone.
 */
export function initProject(directory: string): void {
	const result = spawnSync('git', ['init'], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		encoding: 'utf8' as const,
		timeout: 5_000,
		maxBuffer: 128 * 1024,
	});
	if (result.status !== 0) {
		const spawnError =
			result.error instanceof Error
				? `${result.error.message}`
				: result.error
					? `spawn error code ${String(result.error)}`
					: 'no spawn error reported';
		const stderrTail = (result.stderr ?? '').slice(-512);
		throw new Error(
			`git init failed in ${directory}: ${spawnError}, status=${String(result.status)}, signal=${String(result.signal)}${stderrTail ? `, stderr=${stderrTail}` : ''}`,
		);
	}
}
