import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	initTelemetry,
	resetTelemetryForTesting,
	telemetry,
} from '../../../src/telemetry';
import { enterCwdSandbox } from '../../helpers/cwd-sandbox';

// =============================================================================
// Adversarial Tests for telemetry init + heartbeat (Task 3.9)
// =============================================================================
//
// Attack vectors:
// 1. initTelemetry with non-existent deeply nested directory (path traversal)
// 2. initTelemetry with empty string directory
// 3. telemetry.heartbeat with extremely long sessionId (buffer overflow)
// 4. telemetry.heartbeat with special characters in sessionId (injection)
// 5. telemetry.heartbeat after resetTelemetryForTesting (stale state)
// 6. Multiple rapid initTelemetry calls (race condition / resource leak)
// 7. telemetry.heartbeat with undefined/null coerced sessionId
// =============================================================================

describe('telemetry-init adversarial tests (Task 3.9)', () => {
	let tempDir: string;

	beforeEach(() => {
		resetTelemetryForTesting();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-init-adv-'));
	});

	afterEach(() => {
		resetTelemetryForTesting();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// -------------------------------------------------------------------------
	// Attack Vector 1: initTelemetry with path traversal attempt
	// -------------------------------------------------------------------------
	test('1. initTelemetry with path traversal attempt must not throw', () => {
		// Attempt to traverse outside using path with relative ..
		// The function should handle this gracefully (catch any errors)
		const maliciousPath = path.join(
			tempDir,
			'.swarm',
			'..',
			'..',
			'..',
			'traversed',
		);

		expect(() => {
			initTelemetry(maliciousPath);
		}).not.toThrow();
	});

	// -------------------------------------------------------------------------
	// Attack Vector 2: initTelemetry with empty string directory
	// -------------------------------------------------------------------------
	test('2. initTelemetry with empty string directory must not throw', () => {
		// '' resolves `.swarm/` against cwd: run inside a sandbox, not the checkout.
		const sandbox = enterCwdSandbox('telemetry-init-empty-');
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
	// Attack Vector 3: telemetry.heartbeat with extremely long sessionId
	// -------------------------------------------------------------------------
	test('3. telemetry.heartbeat with extremely long sessionId (1MB) must not throw', () => {
		initTelemetry(tempDir);

		// Create a sessionId that is 1 megabyte in size
		const massiveSessionId = 'session_' + 'x'.repeat(1024 * 1024 - 8);

		expect(() => {
			telemetry.heartbeat(massiveSessionId);
		}).not.toThrow();
	});

	// -------------------------------------------------------------------------
	// Attack Vector 4: telemetry.heartbeat with special characters (injection)
	// -------------------------------------------------------------------------
	test('4. telemetry.heartbeat with SQL injection attempt must not throw', () => {
		initTelemetry(tempDir);

		const sqlInjection = "session'; DROP TABLE sessions; --";
		expect(() => {
			telemetry.heartbeat(sqlInjection);
		}).not.toThrow();
	});

	test('5. telemetry.heartbeat with JSON injection attempt must not throw', () => {
		initTelemetry(tempDir);

		const jsonInjection = '{"sessionId": "hacked", "admin": true}';
		expect(() => {
			telemetry.heartbeat(jsonInjection);
		}).not.toThrow();
	});

	test('6. telemetry.heartbeat with shell meta-characters must not throw', () => {
		initTelemetry(tempDir);

		const shellInjection = 'session$(whoami)';
		const pipeInjection = 'session|cat /etc/passwd';
		const backtickInjection = 'session`ls`';

		expect(() => {
			telemetry.heartbeat(shellInjection);
		}).not.toThrow();

		expect(() => {
			telemetry.heartbeat(pipeInjection);
		}).not.toThrow();

		expect(() => {
			telemetry.heartbeat(backtickInjection);
		}).not.toThrow();
	});

	test('7. telemetry.heartbeat with template literal injection attempt must not throw', () => {
		initTelemetry(tempDir);

		// Attempt to inject template literal syntax
		const templateInjection = '${process.exit(1)}';
		expect(() => {
			telemetry.heartbeat(templateInjection);
		}).not.toThrow();
	});

	// -------------------------------------------------------------------------
	// Attack Vector 5: telemetry.heartbeat after resetTelemetryForTesting
	// -------------------------------------------------------------------------
	test('8. telemetry.heartbeat after resetTelemetryForTesting must not throw (stale state)', () => {
		// Initialize first
		initTelemetry(tempDir);

		// Emit a heartbeat while initialized
		expect(() => {
			telemetry.heartbeat('session-before-reset');
		}).not.toThrow();

		// Reset - this closes the write stream
		resetTelemetryForTesting();

		// Try to emit heartbeat after reset - should not throw
		expect(() => {
			telemetry.heartbeat('session-after-reset');
		}).not.toThrow();
	});

	// -------------------------------------------------------------------------
	// Attack Vector 6: Multiple rapid initTelemetry calls (resource leak)
	// -------------------------------------------------------------------------
	test('9. multiple rapid initTelemetry calls must not throw or leak', async () => {
		// Use a fresh directory to avoid any pollution
		const testDir = path.join(tempDir, 'rapid-init-subdir');

		// Call initTelemetry many times rapidly - should be idempotent due to early return
		for (let i = 0; i < 100; i++) {
			initTelemetry(testDir);
		}

		// Now emit a heartbeat - should still work (not throw)
		expect(() => {
			telemetry.heartbeat('rapid-init-test');
		}).not.toThrow();

		// Verify .swarm directory exists
		const swarmDir = path.join(testDir, '.swarm');
		expect(fs.existsSync(swarmDir)).toBe(true);

		// Wait for any async writes to complete
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Verify telemetry.jsonl was created
		const telemetryPath = path.join(swarmDir, 'telemetry.jsonl');
		expect(fs.existsSync(telemetryPath)).toBe(true);

		// Verify content was written (JSON line for the heartbeat)
		const content = fs.readFileSync(telemetryPath, 'utf-8');
		expect(content.trim().length).toBeGreaterThan(0);
	});

	// -------------------------------------------------------------------------
	// Attack Vector 7: telemetry.heartbeat with undefined/null coerced sessionId
	// -------------------------------------------------------------------------
	test('10. telemetry.heartbeat with undefined coerced to string must not throw', () => {
		initTelemetry(tempDir);

		// @ts-ignore - intentionally passing undefined to test runtime behavior
		expect(() => {
			telemetry.heartbeat(undefined);
		}).not.toThrow();
	});

	test('11. telemetry.heartbeat with null coerced to string must not throw', () => {
		initTelemetry(tempDir);

		// @ts-ignore - intentionally passing null to test runtime behavior
		expect(() => {
			telemetry.heartbeat(null);
		}).not.toThrow();
	});

	test('12. telemetry.heartbeat with 0 (falsy) sessionId must not throw', () => {
		initTelemetry(tempDir);

		expect(() => {
			// @ts-ignore - intentionally passing 0
			telemetry.heartbeat(0);
		}).not.toThrow();
	});

	test('13. telemetry.heartbeat with empty string sessionId must not throw', () => {
		initTelemetry(tempDir);

		expect(() => {
			telemetry.heartbeat('');
		}).not.toThrow();
	});

	// -------------------------------------------------------------------------
	// Additional edge cases for initTelemetry
	// -------------------------------------------------------------------------
	test('14. initTelemetry with deeply nested non-existent directory must create it', () => {
		const deepNestedPath = path.join(
			tempDir,
			'level1',
			'level2',
			'level3',
			'level4',
			'level5',
		);

		expect(fs.existsSync(deepNestedPath)).toBe(false);

		initTelemetry(deepNestedPath);

		expect(fs.existsSync(deepNestedPath)).toBe(true);
		expect(fs.existsSync(path.join(deepNestedPath, '.swarm'))).toBe(true);
	});

	test('15. initTelemetry with Unicode directory name must not throw', () => {
		const unicodeDir = path.join(tempDir, '测试目录_τεστ');

		expect(() => {
			initTelemetry(unicodeDir);
		}).not.toThrow();

		// Should create the directory
		expect(fs.existsSync(path.join(unicodeDir, '.swarm'))).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Verify telemetry file content for injected data
	// -------------------------------------------------------------------------
	test('16. telemetry.heartbeat with injected data must be escaped in JSON output', async () => {
		initTelemetry(tempDir);

		const injectionAttempt = 'session<script>alert(1)</script>';
		telemetry.heartbeat(injectionAttempt);

		// Wait for async write
		await new Promise((resolve) => setTimeout(resolve, 50));

		const telemetryPath = path.join(tempDir, '.swarm', 'telemetry.jsonl');
		if (fs.existsSync(telemetryPath)) {
			const content = fs.readFileSync(telemetryPath, 'utf-8');
			// The content should be valid JSON (special chars escaped by JSON.stringify)
			const lines = content.trim().split('\n').filter(Boolean);
			for (const line of lines) {
				expect(() => JSON.parse(line)).not.toThrow();
			}
		}
	});

	// -------------------------------------------------------------------------
	// Resource exhaustion: initTelemetry with very long path
	// -------------------------------------------------------------------------
	test('17. initTelemetry with extremely long path (>4096 chars) must not throw', () => {
		const veryLongDirName = 'a'.repeat(5000);
		const longPath = path.join(tempDir, veryLongDirName);

		expect(() => {
			initTelemetry(longPath);
		}).not.toThrow();
	});
});
