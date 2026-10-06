/**
 * Single-attempt git primitives for Epic's state-changing commands.
 *
 * `gitExec` (`src/git/branch.ts`) retries transient spawn failures, which is
 * right for reads but wrong for a command whose effect may already have
 * happened when it timed out (checkout, merge, commit, update-ref): running
 * it again would misreport the state. Epic therefore runs every
 * state-changing git command exactly once through {@link gitExecOnce} — the
 * same spawn seam and hardening as `gitExec` (array argv, explicit cwd,
 * closed stdin, timeout, bounded output, `GIT_TERMINAL_PROMPT=0`) without
 * the retry — and callers inspect the real repository state after a failure.
 *
 * {@link gitProbeExitCode} answers yes/no questions git encodes in its exit
 * status (`merge-base --is-ancestor`): 0 and 1 are answers, anything else
 * (or a spawn error) throws.
 */

import { _internals as gitBranchInternals } from '../git/branch.js';

/** Bounds for one spawn (same values as `gitExec`). */
const GIT_ONCE_TIMEOUT_MS = 30_000;
const GIT_ONCE_MAX_BUFFER_BYTES = 5 * 1024 * 1024;

function spawnOnce(
	args: string[],
	cwd: string,
	env?: Record<string, string>,
): ReturnType<typeof gitBranchInternals.spawnSync> {
	return gitBranchInternals.spawnSync(
		gitBranchInternals.resolveGitExecutable(),
		args,
		{
			cwd,
			encoding: 'utf-8',
			timeout: GIT_ONCE_TIMEOUT_MS,
			windowsHide: true,
			maxBuffer: GIT_ONCE_MAX_BUFFER_BYTES,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
			envOverrides: env,
		},
	);
}

/**
 * One bounded, non-interactive git spawn with NO transient retry. Throws
 * git's stderr (or the spawn error) on failure.
 */
export function gitExecOnce(
	args: string[],
	cwd: string,
	env?: Record<string, string>,
): string {
	const result = spawnOnce(args, cwd, env);
	if (result.error) {
		throw new Error(
			`git ${args[0] ?? ''} failed to complete: ${result.error.message}`,
		);
	}
	if (result.status !== 0) {
		throw new Error(
			String(result.stderr ?? '') ||
				String(result.stdout ?? '') ||
				`git exited with ${result.status}`,
		);
	}
	return String(result.stdout ?? '');
}

/**
 * Exit status of a read-only git question (0 = yes, 1 = no). Throws on a
 * spawn error, a timeout, or any other exit status.
 */
export function gitProbeExitCode(args: string[], cwd: string): 0 | 1 {
	const result = spawnOnce(args, cwd);
	if (result.error) {
		throw new Error(
			`git ${args[0] ?? ''} failed to complete: ${result.error.message}`,
		);
	}
	if (result.status === 0 || result.status === 1) return result.status;
	throw new Error(
		String(result.stderr ?? '') ||
			String(result.stdout ?? '') ||
			`git exited with ${result.status}`,
	);
}
