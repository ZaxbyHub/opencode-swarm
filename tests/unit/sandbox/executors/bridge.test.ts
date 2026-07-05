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
		test('MacOSSandboxExecutor throws on construction', () => {
			expect(() => new MacOSSandboxExecutor()).toThrow(
				'MacOSSandboxExecutor not yet implemented',
			);
		});
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
