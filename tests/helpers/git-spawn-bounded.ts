/**
 * Shared bounded git spawn for tests that build real-git fixtures.
 *
 * Invariant 3 (subprocesses): explicit cwd, ignored stdin, bounded output,
 * timeout + best-effort kill, an 'error' handler so a missing git never leaves
 * a promise unresolved, and hermetic git config so a developer's global
 * commit.gpgsign/hooksPath cannot hang or alter a fixture.
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';

export interface GitSpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export function gitSpawnBounded(
	args: string[],
	cwd: string,
	timeoutMs = 10_000,
): Promise<GitSpawnResult> {
	return new Promise((resolve) => {
		const proc = spawn('git', args, {
			cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: timeoutMs,
			windowsHide: true,
			env: {
				...process.env,
				// A missing path is ignored by git; Windows cannot open NUL as a global
				// config file (git resolves it to \\.\nul and exits 128).
				GIT_CONFIG_GLOBAL: path.join(cwd, '__no_global_gitconfig__'),
				GIT_CONFIG_NOSYSTEM: '1',
				LC_ALL: 'C',
			},
		});
		let stdout = '';
		let stderr = '';
		let settled = false;
		const finish = (exitCode: number): void => {
			if (settled) return;
			settled = true;
			try {
				proc.kill();
			} catch {
				// already exited
			}
			resolve({ exitCode, stdout, stderr });
		};
		// Drain both streams but retain only a bounded tail per stream.
		const MAX_CAPTURED_CHARS = 64 * 1024;
		const appendBounded = (current: string, chunk: string): string =>
			(current + chunk).slice(-MAX_CAPTURED_CHARS);
		proc.stdout.on('data', (d) => {
			stdout = appendBounded(stdout, String(d));
		});
		proc.stderr.on('data', (d) => {
			stderr = appendBounded(stderr, String(d));
		});
		proc.on('error', () => finish(1));
		proc.on('close', (exitCode) => finish(exitCode ?? 1));
	});
}
