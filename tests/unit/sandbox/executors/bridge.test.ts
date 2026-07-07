import { describe, expect, test } from 'bun:test';
import { BubblewrapSandboxExecutor } from '../../../../src/sandbox/executors/bubblewrap';
import { MacOSSandboxExecutor } from '../../../../src/sandbox/executors/macos';
import { WindowsSandboxExecutor } from '../../../../src/sandbox/executors/windows';

describe('sandbox executors', () => {
	describe('bubblewrap', () => {
		test('BubblewrapSandboxExecutor is importable', () => {
			// The re-export bridge must make BubblewrapSandboxExecutor available
			expect(typeof BubblewrapSandboxExecutor).toBe('function');
		});
	});

	describe('macos', () => {
		// MacOSSandboxExecutor is now implemented (issue #1729 macOS quarantine:
		// the previous "throws on construction" assertion was stale). Current
		// contract:
		//   - On non-darwin platforms, the constructor throws
		//     'MacOSSandboxExecutor not yet implemented' (early platform guard).
		//   - On darwin, the constructor succeeds and self-disables when
		//     sandbox-exec is unavailable (the GitHub macOS runner has no
		//     functional sandbox-exec). The executor reports
		//     mechanism='sandbox-exec' and isAvailable() reflects the probe.
		const isDarwin = process.platform === 'darwin';

		test.skipIf(isDarwin)(
			'MacOSSandboxExecutor throws on non-darwin platforms',
			() => {
				expect(() => new MacOSSandboxExecutor()).toThrow(
					'MacOSSandboxExecutor not yet implemented',
				);
			},
		);

		test.skipIf(!isDarwin)(
			'MacOSSandboxExecutor constructs on darwin and self-disables when sandbox-exec is unavailable',
			() => {
				const executor = new MacOSSandboxExecutor();
				expect(executor).toBeDefined();
				expect(executor.mechanism).toBe('sandbox-exec');
				// The GitHub macOS runner has no functional sandbox-exec, so the
				// executor self-disables. Locally (with sandbox-exec present) it
				// would be available. Assert the mechanism/shape, not the
				// probe result, so the test is portable across both environments.
				expect(typeof executor.isAvailable()).toBe('boolean');
			},
		);
	});

	describe('windows', () => {
		const isWin = process.platform === 'win32';

		test.skipIf(isWin)(
			'WindowsSandboxExecutor initializes as unavailable on non-Windows platforms',
			() => {
				const executor = new WindowsSandboxExecutor([]);
				expect(executor).toBeDefined();
				expect(executor.mechanism).toBe('none');
				expect(executor.isAvailable()).toBe(false);
			},
		);

		test.skipIf(!isWin)('WindowsSandboxExecutor initializes on Windows', () => {
			const executor = new WindowsSandboxExecutor([]);
			expect(executor).toBeDefined();
			expect(['none', 'powershell-wrapper']).toContain(executor.mechanism);
		});
	});
});
