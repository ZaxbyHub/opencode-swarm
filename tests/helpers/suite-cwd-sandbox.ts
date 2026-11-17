/**
 * Hold a whole describe block's cwd inside an `enterCwdSandbox` root.
 *
 * For suites whose code under test resolves its project root from
 * `process.cwd()` by design (the `run` CLI entry point), so per-call directory
 * injection is not available. Call it inside the describe body: it registers
 * a beforeAll that enters the sandbox and an afterAll that restores the
 * original cwd and removes the sandbox.
 *
 * The chdir happens in beforeAll, NOT at collection time: Bun skips a
 * suite's hooks when a `-t` filter excludes all of its tests, so a
 * collection-time chdir would never be undone and would leak into every later
 * file in the process.
 *
 * Read `.cwd` only inside tests and hooks (it throws outside the suite's
 * lifetime); it equals `process.cwd()` while the suite runs.
 */
import { afterAll, beforeAll } from 'bun:test';
import { type CwdSandbox, enterCwdSandbox } from './cwd-sandbox';

export function useSuiteCwdSandbox(prefix: string): { readonly cwd: string } {
	let sandbox: CwdSandbox | undefined;
	beforeAll(() => {
		sandbox = enterCwdSandbox(prefix);
	});
	afterAll(() => {
		sandbox?.restore();
		sandbox = undefined;
	});
	return {
		get cwd(): string {
			if (sandbox === undefined) {
				throw new Error(
					'useSuiteCwdSandbox: .cwd read outside the suite (before beforeAll or after afterAll)',
				);
			}
			return sandbox.cwd;
		},
	};
}
