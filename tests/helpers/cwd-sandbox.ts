/**
 * Run a test with its cwd inside a throwaway sandbox, three levels deep.
 *
 * Tests that resolve paths against process.cwd() — relative traversal targets
 * like `../../etc`, or an empty-directory fallback — otherwise act on the
 * developer's checkout and whatever sits above it (test/adversarial-plan-write
 * wrote `.swarm/` state into `~/etc`). Inside the sandbox every such target up
 * to three levels up stays under `root`.
 */
import { mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from './tmpdir';

export interface CwdSandbox {
	root: string;
	cwd: string;
	restore: () => void;
}

export function enterCwdSandbox(prefix: string): CwdSandbox {
	const originalCwd = process.cwd();
	const root = canonicalMkdtemp(prefix);
	const cwd = path.join(root, 'a', 'b', 'c');
	mkdirSync(cwd, { recursive: true });
	process.chdir(cwd);
	return {
		root,
		cwd,
		restore: () => {
			process.chdir(originalCwd);
			// maxRetries/retryDelay ride out transient Windows EBUSY/EPERM handle locks.
			rmSync(root, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 100,
			});
		},
	};
}
