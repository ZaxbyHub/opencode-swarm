import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const KILL_GRACE_MS = 1_000;

function appendBounded(
	current: string,
	chunk: Buffer | string,
	maxBytes: number,
): { next: string; overflowed: boolean } {
	const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
	if (current.length + text.length <= maxBytes) {
		return { next: current + text, overflowed: false };
	}
	const remaining = Math.max(0, maxBytes - current.length);
	return {
		next: current + text.slice(0, remaining),
		overflowed: true,
	};
}

export async function spawnUtf8(
	cmd: string[],
	cwd: string,
	timeout = 30_000,
): Promise<SpawnResult> {
	const [executable, ...args] = cmd;
	const proc = spawn(executable, args, {
		cwd,
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	let stdout = '';
	let stderr = '';
	let overflowed = false;
	let timedOut = false;

	proc.stdout?.on('data', (chunk) => {
		const bounded = appendBounded(stdout, chunk, MAX_OUTPUT_BYTES);
		stdout = bounded.next;
		if (bounded.overflowed && !overflowed) {
			overflowed = true;
			try {
				proc.kill();
			} catch {}
		}
	});
	proc.stderr?.on('data', (chunk) => {
		const bounded = appendBounded(stderr, chunk, MAX_OUTPUT_BYTES);
		stderr = bounded.next;
		if (bounded.overflowed && !overflowed) {
			overflowed = true;
			try {
				proc.kill();
			} catch {}
		}
	});

	const closePromise = new Promise<{ code: number | null }>((resolve) => {
		proc.once('error', () => resolve({ code: 1 }));
		proc.once('close', (code) => resolve({ code }));
	});

	let resolveTimeout: ((result: { code: number | null }) => void) | undefined;
	const timeoutPromise = new Promise<{ code: number | null }>((resolve) => {
		resolveTimeout = resolve;
	});
	const timer = setTimeout(() => {
		void (async () => {
			timedOut = true;
			try {
				proc.kill('SIGKILL');
			} catch {}
			proc.stdout?.destroy();
			proc.stderr?.destroy();
			proc.unref();

			let resolveGrace:
				| ((result: { code: number | null }) => void)
				| undefined;
			const killGracePromise = new Promise<{ code: number | null }>(
				(resolve) => {
					resolveGrace = resolve;
				},
			);
			const graceTimer = setTimeout(() => {
				resolveGrace?.({ code: 1 });
			}, KILL_GRACE_MS);

			try {
				resolveTimeout?.(
					await Promise.race([closePromise, killGracePromise]),
				);
			} finally {
				clearTimeout(graceTimer);
			}
		})();
	}, timeout);
	timer.unref?.();

	try {
		const { code } = await Promise.race([closePromise, timeoutPromise]);
		return {
			exitCode: overflowed || timedOut ? 1 : code ?? 1,
			stdout,
			stderr,
		};
	} finally {
		clearTimeout(timer);
		try {
			proc.kill();
		} catch {}
	}
}

export async function runGit(
	args: string[],
	cwd: string,
	timeout = 30_000,
): Promise<SpawnResult> {
	return spawnUtf8(['git', ...args], cwd, timeout);
}

export async function resolveRepoRoot(startDir: string): Promise<string> {
	const result = await runGit(['rev-parse', '--show-toplevel'], startDir);
	if (result.exitCode !== 0) {
		return path.resolve(startDir);
	}
	const trimmed = result.stdout.trim();
	return trimmed.length > 0 ? path.resolve(trimmed) : path.resolve(startDir);
}

export function walkFiles(
	root: string,
	visit: (absPath: string, relPath: string) => void,
	options?: { maxDepth?: number; filePredicate?: (entry: fs.Dirent) => boolean },
): void {
	const maxDepth = options?.maxDepth ?? Number.POSITIVE_INFINITY;
	const filePredicate = options?.filePredicate;
	const visitDir = (dir: string, relDir: string, depth: number): void => {
		if (depth > maxDepth) {
			return;
		}
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const abs = path.join(dir, entry.name);
			const rel = relDir ? path.join(relDir, entry.name) : entry.name;
			if (entry.isDirectory()) {
				visitDir(abs, rel, depth + 1);
				continue;
			}
			if (entry.isFile() && (!filePredicate || filePredicate(entry))) {
				visit(abs, rel);
			}
		}
	};
	visitDir(root, '', 0);
}
