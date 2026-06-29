/**
 * Shared helpers for subprocess injection adversarial tests.
 *
 * All helpers route through bunSpawn (src/utils/bun-compat.ts) rather than raw
 * Bun.spawn, ensuring tests exercise the same spawn shim that production code uses.
 * This satisfies FB-010 (route subprocess tests through bunSpawn shim).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunSpawn } from '../../src/utils/bun-compat';

// Use os.tmpdir() + path.join() — never hardcode /tmp or C:\
const tmpDir = fs.mkdtempSync(
	path.join(os.tmpdir(), 'subprocess-injection-test-'),
);

/** Returns the shared tmpDir path. */
export function getTmpDir(): string {
	return tmpDir;
}

/**
 * Helper: run a command via bunSpawn.
 * Exercises src/utils/bun-compat.ts which is what production code uses.
 */
export async function runProc(
	cmd: string[],
	opts?: {
		cwd?: string;
		stdin?: 'inherit' | 'ignore' | 'pipe';
		stdout?: 'inherit' | 'ignore' | 'pipe';
		stderr?: 'inherit' | 'ignore' | 'pipe';
		timeout?: number;
	},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = bunSpawn(cmd, {
		cwd: opts?.cwd,
		stdin: opts?.stdin ?? 'ignore',
		stdout: opts?.stdout ?? 'pipe',
		stderr: opts?.stderr ?? 'pipe',
		timeout: opts?.timeout ?? 5000,
	});
	const exitCode = await proc.exited;
	const stdout = await proc.stdout.text();
	const stderr = await proc.stderr.text();
	return { exitCode, stdout, stderr };
}

/** Helper: write a Node.js test script that echoes its arguments or environment */
export function writeNodeScript(name: string, content: string): string {
	const filePath = path.join(tmpDir, name);
	fs.writeFileSync(filePath, content, 'utf-8');
	return filePath;
}

/** Helper: run a node script via bunSpawn */
export async function runNodeScript(
	scriptPath: string,
	scriptArgs: string[] = [],
	opts?: {
		cwd?: string;
		stdin?: 'inherit' | 'ignore' | 'pipe';
		stdout?: 'inherit' | 'ignore' | 'pipe';
		stderr?: 'inherit' | 'ignore' | 'pipe';
		timeout?: number;
	},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return runProc([process.execPath, scriptPath, ...scriptArgs], opts);
}

/** Cleanup function to be called in afterEach */
export function cleanupTestScripts(): void {
	try {
		const entries = fs.readdirSync(tmpDir);
		for (const entry of entries) {
			try {
				fs.unlinkSync(path.join(tmpDir, entry));
			} catch {
				// ignore cleanup errors
			}
		}
	} catch {
		// ignore
	}
}
