import * as path from 'node:path';

/**
 * Subprocess helpers for tests/unit/scripts/check-pending-fragment-cli.test.ts
 * (underscore-prefixed non-test module: no FR-006 500-line cap, and it keeps the
 * spawning helper out of both the test file and any suite that imports it).
 */

export const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..');

export const SCRIPT = path.join(
	REPO_ROOT,
	'scripts',
	'check-pending-fragment.ts',
);

export interface CliResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Bounded, non-interactive subprocess: fixed cwd, piped stdin, 30s timeout. */
export function runCli(input: {
	args: string[];
	stdin: string;
	/** Raw stdin bytes — for inputs that are not valid UTF-8 (a JS string
	 * always is). Takes precedence over `stdin` when set. */
	stdinBytes?: Buffer;
	timeoutMs?: number;
}): CliResult {
	const proc = Bun.spawnSync({
		cmd: ['bun', SCRIPT, ...input.args],
		cwd: REPO_ROOT,
		stdin: input.stdinBytes ?? Buffer.from(input.stdin, 'utf8'),
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: input.timeoutMs ?? 30_000,
	});
	return {
		exitCode: proc.exitCode ?? 1,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}
