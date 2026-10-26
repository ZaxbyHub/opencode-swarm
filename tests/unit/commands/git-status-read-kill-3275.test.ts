/**
 * Supplementary test for issue #3317 (not frozen, critic-recommended): AC3's
 * wording says the reader KILLS the child that exceeds its timeout. C3 proves
 * the event loop stays live and the result is ETIMEDOUT, but a 5 s sleeper can
 * outlive the 300 ms result unnoticed. This test pins pid-liveness: the child
 * writes its own pid to a file, and after the read resolves ETIMEDOUT the pid
 * must be gone (ESRCH) within a bounded settle window.
 *
 * GREEN only after the fix (the module does not exist at base).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gitStatusReadInternals } from '../../../src/commands/git-status-read';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const tempRoots: string[] = [];

const originalReadOnce = gitStatusReadInternals.readOnce;
const originalResolveExecutable = gitStatusReadInternals.resolveExecutable;

afterEach(() => {
	gitStatusReadInternals.readOnce = originalReadOnce;
	gitStatusReadInternals.resolveExecutable = originalResolveExecutable;
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function pidIsGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'ESRCH';
	}
}

describe('git-status reader kills the timed-out child (#3317 supplement)', () => {
	test('after an ETIMEDOUT read the sleeping child is actually killed', async () => {
		const cwd = canonicalMkdtemp('3317-kill-');
		tempRoots.push(cwd);
		gitStatusReadInternals.resolveExecutable = async () => process.execPath;
		const pidFile = path.join(cwd, 'child.pid');
		const args = [
			'-e',
			`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); await new Promise((r) => setTimeout(r, 30000));`,
		];

		// The deadline must exceed cold-start so the child announces itself
		// BEFORE the kill (PRR-021: measured pid write at 586-1984 ms; a
		// 300 ms deadline raced it and threw ENOENT instead of asserting).
		const result = await gitStatusReadInternals.readOnce(args, cwd, 5000);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe('ETIMEDOUT');
		}

		// The child must have announced itself before the kill landed.
		const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
		expect(Number.isInteger(pid)).toBe(true);

		// Bounded settle: the SIGKILL was issued synchronously in the read's
		// finally, but process teardown can lag a few milliseconds.
		let gone = false;
		for (let i = 0; i < 40 && !gone; i++) {
			gone = pidIsGone(pid);
			if (!gone) await new Promise((r) => setTimeout(r, 50));
		}
		expect(gone).toBe(true);
	}, 30_000);

	// Review round 2: pins the fragment's ESIGNAL claim ON A SIGNAL-REPORTING
	// PLATFORM with a real external kill. Windows cannot express this shape
	// (taskkill exits 1/255 with no signal code — declared residual in the
	// fragment), so the leg is POSIX-only and runs on the Linux/macOS CI legs.
	test.skipIf(process.platform === 'win32')(
		'an externally SIGKILLed child classifies as ESIGNAL (POSIX signal path)',
		async () => {
			const cwd = canonicalMkdtemp('3317-kill-posix-');
			tempRoots.push(cwd);
			gitStatusReadInternals.resolveExecutable = async () => process.execPath;
			const pidFile = path.join(cwd, 'child.pid');
			const args = [
				'-e',
				`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); await new Promise((r) => setTimeout(r, 30000));`,
			];

			const read = gitStatusReadInternals.readOnce(args, cwd, 15_000);
			// Wait (bounded) for the child to announce itself, then kill it
			// externally — well before the read's deadline, so the completed
			// race (not the timeout) decides the class.
			let pid = Number.NaN;
			for (let i = 0; i < 100 && !Number.isInteger(pid); i++) {
				if (fs.existsSync(pidFile)) {
					pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
				}
				if (!Number.isInteger(pid)) {
					await new Promise((r) => setTimeout(r, 50));
				}
			}
			expect(Number.isInteger(pid)).toBe(true);
			process.kill(pid, 'SIGKILL');

			const result = await read;
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.code).toBe('ESIGNAL');
				expect(result.status).toBeNull();
			}
		},
		30_000,
	);
});
