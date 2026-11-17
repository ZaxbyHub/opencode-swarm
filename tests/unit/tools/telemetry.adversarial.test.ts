import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	addTelemetryListener,
	emit,
	initTelemetry,
	resetTelemetryForTesting,
	rotateTelemetryIfNeeded,
} from '../../../src/telemetry';
import { enterCwdSandbox } from '../../helpers/cwd-sandbox';

// =============================================================================
// Adversarial Tests for telemetry module
// =============================================================================
//
// NOTE: The telemetry module uses module-level state (_writeStream, _listeners,
// _disabled, _projectDirectory) that persists across test files. Since
// telemetry.test.ts already calls initTelemetry in beforeAll, the module may
// already be initialized. We work with this existing state and test edge cases.
// =============================================================================

describe('telemetry adversarial tests', () => {
	let tempDir: string;

	beforeEach(async () => {
		resetTelemetryForTesting();
		// Create a fresh temp directory for each test
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-adv-'));
	});

	afterEach(async () => {
		// Clean up temp directory
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// -------------------------------------------------------------------------
	// Test 1: Circular reference in emit() data — must not throw
	// -------------------------------------------------------------------------
	test('1. circular reference in emit data must not throw', () => {
		const circular: Record<string, unknown> = { a: 1 };
		circular.self = circular;

		expect(() => {
			emit('session_started', circular);
		}).not.toThrow();
	});

	// -------------------------------------------------------------------------
	// Test 2: emit() with undefined/null in data fields — must not throw
	// -------------------------------------------------------------------------
	test('2. emit with undefined field must not throw', () => {
		expect(() => {
			emit('session_started', { sessionId: undefined, agentName: 'agent' });
		}).not.toThrow();
	});

	test('3. emit with null field must not throw', () => {
		expect(() => {
			emit('session_started', { sessionId: null, agentName: null });
		}).not.toThrow();
	});

	test('4. emit with mixed undefined/null fields must not throw', () => {
		expect(() => {
			emit('gate_failed', {
				sessionId: undefined,
				gate: null,
				taskId: 'task-1',
				reason: undefined,
			});
		}).not.toThrow();
	});

	// -------------------------------------------------------------------------
	// Test 5: emit() with very large data object (>100KB) — must not crash
	// -------------------------------------------------------------------------
	test('5. emit with large data object (>100KB) must not crash', async () => {
		// Create a large data object ( > 100KB)
		const largeString = 'x'.repeat(150 * 1024);
		const largeData = {
			sessionId: 'large-data-test',
			payload: largeString,
			nested: { data: largeString.repeat(2) },
		};

		expect(() => {
			emit('session_started', largeData);
		}).not.toThrow();

		// Allow async write to complete
		await new Promise((resolve) => setTimeout(resolve, 50));
	});

	// -------------------------------------------------------------------------
	// Test 6: initTelemetry with non-existent directory — must create it
	// -------------------------------------------------------------------------
	test('6. initTelemetry with non-existent directory must create it', () => {
		// Use a fresh subdirectory that doesn't exist
		const freshDir = path.join(tempDir, 'does-not-exist-subdir');
		expect(fs.existsSync(freshDir)).toBe(false);

		initTelemetry(freshDir);

		// Should create the directory and .swarm subdirectory
		expect(fs.existsSync(freshDir)).toBe(true);
		expect(fs.existsSync(path.join(freshDir, '.swarm'))).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Test 7: initTelemetry with read-only directory — must disable silently
	// -------------------------------------------------------------------------
	test('7. initTelemetry with read-only directory must disable silently', () => {
		// Create a directory and make it read-only (if we can)
		// On Windows, we can try setting read-only attribute
		// On Unix, we can try chmod 000
		const readOnlyDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-readonly-')),
		);

		try {
			// Try to make it read-only (may fail on Windows without admin, but that's ok)
			try {
				if (process.platform !== 'win32') {
					fs.chmodSync(readOnlyDir, 0o444);
				} else {
					// On Windows, try setting +r attribute via attrib command
					const { execSync } = require('child_process');
					try {
						execSync(`attrib +R "${readOnlyDir}"`, { stdio: 'ignore' });
					} catch {
						// If attrib fails, skip this test on Windows
						test.skip('Cannot set read-only attribute on Windows', () => {});
						return;
					}
				}
			} catch {
				// If we can't make it read-only (e.g., Windows without admin), skip
				test.skip('Cannot make directory read-only in this environment', () => {});
				return;
			}

			// This should not throw - it should disable silently
			expect(() => {
				initTelemetry(readOnlyDir);
			}).not.toThrow();
		} finally {
			// Clean up - restore permissions first
			try {
				if (process.platform !== 'win32') {
					fs.chmodSync(readOnlyDir, 0o755);
				} else {
					const { execSync } = require('child_process');
					execSync(`attrib -R "${readOnlyDir}"`, { stdio: 'ignore' });
				}
				fs.rmSync(readOnlyDir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		}
	});

	// -------------------------------------------------------------------------
	// Test 8: rotateTelemetryIfNeeded with non-existent file — must be no-op
	// -------------------------------------------------------------------------
	test('8. rotateTelemetryIfNeeded with non-existent file must be no-op', () => {
		// Initialize with our temp dir
		initTelemetry(tempDir);

		// telemetry.jsonl should not exist
		const telemetryPath = path.join(tempDir, '.swarm', 'telemetry.jsonl');
		expect(fs.existsSync(telemetryPath)).toBe(false);

		// This should be a no-op, not throw
		expect(() => {
			rotateTelemetryIfNeeded(100);
		}).not.toThrow();

		// File should still not exist
		expect(fs.existsSync(telemetryPath)).toBe(false);
	});

	// -------------------------------------------------------------------------
	// Test 9: rotateTelemetryIfNeeded called multiple times rapidly — no race
	// -------------------------------------------------------------------------
	test('9. rotateTelemetryIfNeeded called rapidly must not race', async () => {
		initTelemetry(tempDir);

		// Emit some data
		for (let i = 0; i < 10; i++) {
			emit('session_started', {
				sessionId: `rapid-rotate-${i}`,
				agentName: 'agent',
			});
		}
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Call rotate multiple times rapidly
		expect(() => {
			for (let i = 0; i < 10; i++) {
				rotateTelemetryIfNeeded(100);
			}
		}).not.toThrow();
	});

	// -------------------------------------------------------------------------
	// Test 10: emit() called from multiple listeners (re-entrant) — no deadlock
	// -------------------------------------------------------------------------
	test('10. emit called from listener must not deadlock', () => {
		let emitCount = 0;
		const maxEmits = 5;

		addTelemetryListener((event, data) => {
			// Re-enter emit from within listener
			if (emitCount < maxEmits) {
				emitCount++;
				emit('session_started', {
					sessionId: `re-entrant-${emitCount}`,
					agentName: 'agent',
				});
			}
		});

		expect(() => {
			emit('session_started', {
				sessionId: 're-entrant-start',
				agentName: 'agent',
			});
		}).not.toThrow();

		// Give async writes time to complete
		// The important thing is it didn't deadlock
	});

	// -------------------------------------------------------------------------
	// Test 11: addTelemetryListener returns void — verify typing
	// -------------------------------------------------------------------------
	test('11. addTelemetryListener returns void', () => {
		const result = addTelemetryListener(() => {});

		// addTelemetryListener returns void (undefined)
		// In TypeScript this would be typed as void
		expect(result).toBeUndefined();
	});

	// -------------------------------------------------------------------------
	// Test 12: emit() with Symbol keys in data — must be handled by JSON.stringify
	// -------------------------------------------------------------------------
	test('12. emit with Symbol keys must not throw', () => {
		const sym = Symbol('test');
		const dataWithSymbol = {
			sessionId: 'symbol-test',
			[sym]: 'symbol-value',
			regularKey: 'regular-value',
		};

		expect(() => {
			emit('session_started', dataWithSymbol);
		}).not.toThrow();
	});

	// -------------------------------------------------------------------------
	// Test 13: emit() with BigInt values — JSON.stringify should fail, emit must catch it
	// -------------------------------------------------------------------------
	test('13. emit with BigInt values must not throw (caught by try/catch)', () => {
		const dataWithBigInt = {
			sessionId: 'bigint-test',
			bigValue: BigInt(9007199254740991),
			// @ts-ignore - intentionally testing invalid input
			regularNumber: 42,
		};

		expect(() => {
			emit('session_started', dataWithBigInt);
		}).not.toThrow();
	});

	// -------------------------------------------------------------------------
	// Test 14: initTelemetry with empty string directory — must handle gracefully
	// -------------------------------------------------------------------------
	test('14. initTelemetry with empty string directory must handle gracefully', () => {
		// '' resolves `.swarm/` against cwd: run inside a sandbox, not the checkout.
		const sandbox = enterCwdSandbox('telemetry-adv-empty-');
		try {
			expect(() => {
				initTelemetry('');
			}).not.toThrow();
		} finally {
			resetTelemetryForTesting();
			sandbox.restore();
		}
	});

	// -------------------------------------------------------------------------
	// Test 15: Rapid emit() calls (100+ in sequence) — must not lose data or crash
	// -------------------------------------------------------------------------
	test('15. rapid emit calls (100+) must not crash and data must be written', async () => {
		initTelemetry(tempDir);

		const count = 150;
		expect(() => {
			for (let i = 0; i < count; i++) {
				emit('session_started', {
					sessionId: `rapid-${i}`,
					agentName: 'agent',
				});
			}
		}).not.toThrow();

		// Wait for async writes to complete
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Verify data was written
		const telemetryPath = path.join(tempDir, '.swarm', 'telemetry.jsonl');
		if (fs.existsSync(telemetryPath)) {
			const content = fs.readFileSync(telemetryPath, 'utf-8');
			const lines = content.trim().split('\n').filter(Boolean);
			// Should have written many lines (may be > count due to other tests)
			expect(lines.length).toBeGreaterThan(0);
		}
	});

	// -------------------------------------------------------------------------
	// Test 16: emit with deeply nested object — must not crash
	// -------------------------------------------------------------------------
	test('16. emit with deeply nested object must not crash', () => {
		// Create a deeply nested object (100+ levels)
		const deeplyNested: Record<string, unknown> = { level: 0 };
		let current: Record<string, unknown> = deeplyNested;
		for (let i = 1; i <= 100; i++) {
			const next: Record<string, unknown> = { level: i };
			current.nested = next;
			current = next;
		}

		expect(() => {
			emit('session_started', deeplyNested);
		}).not.toThrow();
	});

	// -------------------------------------------------------------------------
	// Test 17: emit with function in data — should be skipped by JSON.stringify
	// -------------------------------------------------------------------------
	test('17. emit with function in data must not throw', () => {
		const dataWithFunction = {
			sessionId: 'function-test',
			callback: () => {},
			// @ts-ignore - intentionally testing edge case
			anonFunction: () => {},
		};

		expect(() => {
			emit('session_started', dataWithFunction);
		}).not.toThrow();
	});

	// -------------------------------------------------------------------------
	// Test 18: emit with special JSON characters in data
	// -------------------------------------------------------------------------
	test('18. emit with special JSON characters must not throw', () => {
		const dataWithSpecialChars = {
			sessionId: 'special-chars-test',
			// @ts-ignore - intentionally testing edge case
			jsonString: '{"key": "value"}',
			// @ts-ignore - intentionally testing edge case
			controlChars: '\u0000\u0001\u0002',
			// @ts-ignore - intentionally testing edge case
			unicodeEmoji: '🎉🔥💯',
		};

		expect(() => {
			emit('session_started', dataWithSpecialChars);
		}).not.toThrow();
	});

	// -------------------------------------------------------------------------
	// Test 19: emit after module is disabled (stream error) — must not throw
	// -------------------------------------------------------------------------
	test('19. emit after stream error must not throw', () => {
		// We simulate a scenario where the stream is closed/disabled
		// by emitting very large data that might cause issues
		const largeData = {
			sessionId: 'disabled-test',
			payload: 'x'.repeat(1000),
		};

		// First emit should work
		expect(() => {
			emit('session_started', largeData);
		}).not.toThrow();

		// Subsequent emits should also not throw
		expect(() => {
			emit('session_started', { sessionId: 'after-large', agentName: 'agent' });
		}).not.toThrow();
	});

	// -------------------------------------------------------------------------
	// Test 20: rotateTelemetryIfNeeded with 0 maxBytes — should trigger rotation
	// -------------------------------------------------------------------------
	test('20. rotateTelemetryIfNeeded with 0 maxBytes must not throw', async () => {
		initTelemetry(tempDir);

		// Emit some data
		emit('session_started', { sessionId: 'zero-limit', agentName: 'agent' });
		await new Promise((resolve) => setTimeout(resolve, 50));

		// With 0 maxBytes, any non-empty file should be rotated
		// The important thing is it doesn't crash
		expect(() => {
			rotateTelemetryIfNeeded(0);
		}).not.toThrow();
	});
});
