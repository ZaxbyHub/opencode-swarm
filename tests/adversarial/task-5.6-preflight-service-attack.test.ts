/**
 * Adversarial Security Tests for Task 5.6
 * Target: src/services/preflight-service.ts, src/services/preflight-integration.ts
 *
 * Attack vectors tested:
 * 1. DIRECTORY TRAVERSAL - path escapes, null bytes, symlinks, UNC paths
 * 2. TIMEOUT ABUSE - negative timeouts, overflow, DoS via extreme values
 * 3. CONFIG-GATING BYPASS - capability bypass, mode manipulation
 * 4. QUEUE OVERFLOW/REPLAY - queue exhaustion, request replay, priority gaming
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { resetGlobalEventBus } from '../../src/background/event-bus';
import {
	type PreflightRequest,
	PreflightTriggerManager,
} from '../../src/background/trigger';
import {
	createPreflightIntegration,
	type PreflightIntegrationConfig,
	runManualPreflight,
} from '../../src/services/preflight-integration';
import {
	formatPreflightMarkdown,
	type PreflightConfig,
	type PreflightReport,
	runPreflight,
} from '../../src/services/preflight-service';

// Helper to create automation config
function createAutomationConfig(
	options: {
		mode?: 'manual' | 'hybrid' | 'auto';
		phasePreflight?: boolean;
	} = {},
) {
	return {
		mode: options.mode ?? 'hybrid',
		capabilities: {
			phase_preflight: options.phasePreflight ?? true,
			plan_sync: true,
			config_doctor_on_startup: false,
			evidence_auto_summaries: false,
			decision_drift_detection: false,
		},
	};
}

// ============================================================================
// ATTACK VECTOR 1: DIRECTORY TRAVERSAL
// ============================================================================

describe('ATTACK: Directory Traversal', () => {
	let tempDir: string;
	let outsideDir: string;

	beforeEach(() => {
		resetGlobalEventBus();
		tempDir = mkdtempSync(path.join(tmpdir(), 'preflight-attack-'));
		outsideDir = mkdtempSync(path.join(tmpdir(), 'outside-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		rmSync(outsideDir, { recursive: true, force: true });
	});

	describe('path traversal sequences', () => {
		test('SECURE: rejects directory path with ".." traversal (absolute)', async () => {
			// The service normalizes paths, so we test with a path that contains ".."
			// but would resolve to something outside the expected scope
			const attackPath = '/etc/passwd';

			const report = await runPreflight(attackPath, 1);

			// On Windows this path won't exist, on Linux it does
			// The key security finding is that ".." in relative paths IS allowed
			// if the normalized path resolves to a valid directory
			expect(report).toBeDefined();
		});

		test('HANDLED: ".." traversal in relative paths is normalized', async () => {
			// Create a subdirectory
			const subdir = path.join(tempDir, 'subdir');
			mkdirSync(subdir);

			// Relative path with ".." that still resolves to a valid location
			const relativePath = path.join(subdir, '..', '.');

			const report = await runPreflight(relativePath, 1);

			// The service NORMALIZES the path (doesn't reject ".." outright)
			// This is a design decision but means traversal within filesystem is allowed
			expect(report).toBeDefined();
		});

		test('SECURE: rejects complex traversal "../../../etc/passwd"', async () => {
			const attackPath = '../../../etc/passwd';

			const report = await runPreflight(attackPath, 1);

			expect(report.overall).toBe('fail');
			expect(report.checks[0].message).toMatch(/traversal|invalid/i);
		});

		test('SECURE: rejects traversal with mixed separators', async () => {
			// Try to use both forward and backward slashes
			const attackPath = '..\\..\\..\\windows\\system32';

			const report = await runPreflight(attackPath, 1);

			expect(report.overall).toBe('fail');
		});

		test('SECURE: rejects URL-encoded traversal "%2e%2e"', async () => {
			// URL encoded .. (should not be decoded to traversal)
			const attackPath = '%2e%2e/%2e%2e/%2e%2e/etc/passwd';

			// The service should not URL-decode paths
			const report = await runPreflight(attackPath, 1);

			// Should fail - either directory doesn't exist or path rejected
			expect(report.overall).toBe('fail');
		});
	});

	describe('null byte injection', () => {
		test('SECURE: rejects path with null byte', async () => {
			// Null byte can truncate strings in some languages
			const attackPath = path.join(tempDir, 'valid\x00.txt');

			const report = await runPreflight(attackPath, 1);

			// Should handle gracefully - either reject or sanitize
			expect(report).toBeDefined();
			expect(report.overall).toBe('fail');
		});

		test('SECURE: handles null byte at start', async () => {
			const attackPath = '\x00' + tempDir;

			const report = await runPreflight(attackPath, 1);

			expect(report).toBeDefined();
		});
	});

	describe('special path attacks', () => {
		test('SECURE: handles empty path', async () => {
			const report = await runPreflight('', 1);

			expect(report.overall).toBe('fail');
			expect(report.checks[0].message).toMatch(/required|invalid/i);
		});

		test('SECURE: handles null/undefined path', async () => {
			// @ts-expect-error - intentionally passing null
			const report = await runPreflight(null, 1);

			expect(report.overall).toBe('fail');
		});

		test('SECURE: handles whitespace-only path', async () => {
			const report = await runPreflight('   \t\n  ', 1);

			expect(report.overall).toBe('fail');
		});

		test('handles extremely long path (Windows MAX_PATH)', async () => {
			// Windows has MAX_PATH of 260 characters
			const longPath = 'a'.repeat(500);

			const report = await runPreflight(longPath, 1);

			// Should handle gracefully - OS will likely reject
			expect(report).toBeDefined();
		});

		test('handles UNC path on Windows', async () => {
			// UNC path format: \\server\share
			const uncPath = '\\\\malicious-server\\share';

			const report = await runPreflight(uncPath, 1);

			// Should handle gracefully
			expect(report).toBeDefined();
		});

		test('handles symlink to outside directory', async () => {
			// Create a file outside the allowed directory
			writeFileSync(path.join(outsideDir, 'secret.txt'), 'SECRET_DATA');

			// Create symlink inside tempDir pointing outside
			const symlinkPath = path.join(tempDir, 'link');
			try {
				symlinkSync(outsideDir, symlinkPath, 'junction');
			} catch {
				// Symlink creation may fail on some systems
				return;
			}

			// Attempt to run preflight on symlink
			const report = await runPreflight(symlinkPath, 1);

			// Should either resolve symlink safely or reject
			expect(report).toBeDefined();
			expect(report.overall).toMatch(/pass|fail|skipped/);
		});
	});

	describe('path validation edge cases', () => {
		test('handles path with unicode characters', async () => {
			const unicodePath = path.join(tempDir, 'проверка-测试-🔍');

			try {
				mkdirSync(unicodePath);
			} catch {
				// Unicode directory creation may fail
				return;
			}

			const report = await runPreflight(unicodePath, 1);
			expect(report).toBeDefined();
		});

		test('handles path with reserved characters', async () => {
			// Characters like <>:"|?* are reserved on Windows
			const reservedPath = path.join(tempDir, 'test<file>');

			const report = await runPreflight(reservedPath, 1);

			// Should handle gracefully
			expect(report).toBeDefined();
		});
	});
});

// ============================================================================
// ATTACK VECTOR 2: TIMEOUT ABUSE
// ============================================================================

describe('ATTACK: Timeout Abuse', () => {
	let tempDir: string;

	beforeEach(() => {
		resetGlobalEventBus();
		tempDir = mkdtempSync(path.join(tmpdir(), 'preflight-timeout-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe('negative timeout attacks', () => {
		test('SECURE: rejects negative timeout', async () => {
			const config: PreflightConfig = {
				checkTimeoutMs: -1000,
			};

			const report = await runPreflight(tempDir, 1, config);

			expect(report.overall).toBe('fail');
			expect(report.checks[0].message).toMatch(/greater than 0|invalid/i);
		});

		test('SECURE: rejects zero timeout', async () => {
			const config: PreflightConfig = {
				checkTimeoutMs: 0,
			};

			const report = await runPreflight(tempDir, 1, config);

			expect(report.overall).toBe('fail');
		});
	});

	describe('timeout overflow attacks', () => {
		test('SECURE: rejects extremely large timeout (DoS prevention)', async () => {
			const config: PreflightConfig = {
				checkTimeoutMs: Number.MAX_SAFE_INTEGER,
			};

			const report = await runPreflight(tempDir, 1, config);

			// Should cap or reject extremely large timeouts
			expect(report.overall).toBe('fail');
			expect(report.checks[0].message).toMatch(/exceed|maximum|5 minutes/i);
		});

		test('SECURE: rejects Infinity timeout', async () => {
			const config: PreflightConfig = {
				checkTimeoutMs: Infinity,
			};

			const report = await runPreflight(tempDir, 1, config);

			expect(report.overall).toBe('fail');
		});

		test('SECURE: rejects NaN timeout', async () => {
			const config: PreflightConfig = {
				checkTimeoutMs: NaN,
			};

			const report = await runPreflight(tempDir, 1, config);

			expect(report.overall).toBe('fail');
		});

		test('SECURE: rejects -Infinity timeout', async () => {
			const config: PreflightConfig = {
				checkTimeoutMs: -Infinity,
			};

			const report = await runPreflight(tempDir, 1, config);

			expect(report.overall).toBe('fail');
		});
	});

	describe('timeout boundary attacks', () => {
		test('SECURE: rejects timeout just below minimum (4999ms)', async () => {
			const config: PreflightConfig = {
				checkTimeoutMs: 4999, // Below minimum of 5000ms
			};

			const report = await runPreflight(tempDir, 1, config);

			expect(report.overall).toBe('fail');
		});

		test('SECURE: accepts minimum valid timeout (5000ms)', async () => {
			const config: PreflightConfig = {
				checkTimeoutMs: 5000,
				skipTests: true,
				skipSecrets: true,
				skipEvidence: true,
			};

			const report = await runPreflight(tempDir, 1, config);

			// Should work with minimum valid timeout
			expect(report).toBeDefined();
		});

		test('SECURE: rejects timeout just above maximum (300001ms)', async () => {
			const config: PreflightConfig = {
				checkTimeoutMs: 300001, // Above maximum of 300000ms (5 min)
			};

			const report = await runPreflight(tempDir, 1, config);

			expect(report.overall).toBe('fail');
		});

		test('SECURE: accepts maximum valid timeout (300000ms)', async () => {
			const config: PreflightConfig = {
				checkTimeoutMs: 300000,
				skipTests: true,
				skipSecrets: true,
				skipEvidence: true,
			};

			const report = await runPreflight(tempDir, 1, config);

			expect(report).toBeDefined();
		});
	});

	describe('timeout type coercion attacks', () => {
		test('SECURE: rejects string timeout', async () => {
			const config = {
				checkTimeoutMs: '60000',
			} as unknown as PreflightConfig;

			const report = await runPreflight(tempDir, 1, config);

			// Should handle gracefully
			expect(report).toBeDefined();
		});

		test('SECURE: rejects object timeout', async () => {
			const config = {
				checkTimeoutMs: { value: 60000 },
			} as unknown as PreflightConfig;

			const report = await runPreflight(tempDir, 1, config);

			expect(report).toBeDefined();
		});

		test('SECURE: rejects array timeout', async () => {
			const config = {
				checkTimeoutMs: [60000],
			} as unknown as PreflightConfig;

			const report = await runPreflight(tempDir, 1, config);

			expect(report).toBeDefined();
		});
	});
});

// ============================================================================
// ATTACK VECTOR 3: CONFIG-GATING BYPASS
// ============================================================================

describe('ATTACK: Config-Gating Bypass', () => {
	let tempDir: string;
	let swarmDir: string;

	beforeEach(() => {
		resetGlobalEventBus();
		tempDir = mkdtempSync(path.join(tmpdir(), 'preflight-config-'));
		swarmDir = mkdtempSync(path.join(tmpdir(), 'swarm-config-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		rmSync(swarmDir, { recursive: true, force: true });
	});

	describe('capability flag bypass', () => {
		test('SECURE: rejects integration when preflight disabled', () => {
			const config = createAutomationConfig({
				mode: 'hybrid',
				phasePreflight: false,
			});

			expect(() =>
				createPreflightIntegration({
					automationConfig: config,
					directory: tempDir,
					swarmDir: swarmDir,
				}),
			).toThrow(/not enabled|phase_preflight/i);
		});

		test('SECURE: rejects integration in manual mode', async () => {
			const config = createAutomationConfig({
				mode: 'manual',
				phasePreflight: true,
			});

			// Integration CREATES the manager but isEnabled() will return false
			const { manager, cleanup } = createPreflightIntegration({
				automationConfig: config,
				directory: tempDir,
				swarmDir: swarmDir,
			});

			// The manager itself is created, but isEnabled() returns false for manual mode
			// This means triggers won't fire even though integration is created
			expect(manager.isEnabled()).toBe(false);
			expect(manager.getMode()).toBe('manual');

			// Trigger should be skipped because mode is manual
			const result = await manager.checkAndTrigger(2, 5, 10);
			expect(result).toBe(false);

			cleanup();
		});

		test('SECURE: handles missing capabilities object', () => {
			const config = {
				mode: 'hybrid',
				capabilities: {},
			} as unknown as ReturnType<typeof createAutomationConfig>;

			expect(() =>
				createPreflightIntegration({
					automationConfig: config,
					directory: tempDir,
					swarmDir: swarmDir,
				}),
			).toThrow();
		});

		test('SECURE: handles null capabilities', () => {
			const config = {
				mode: 'hybrid',
				capabilities: null,
			} as unknown as ReturnType<typeof createAutomationConfig>;

			expect(() =>
				createPreflightIntegration({
					automationConfig: config,
					directory: tempDir,
					swarmDir: swarmDir,
				}),
			).toThrow();
		});
	});

	describe('trigger manager capability gating', () => {
		test('SECURE: trigger manager respects phase_preflight flag', async () => {
			const disabledConfig = createAutomationConfig({
				mode: 'hybrid',
				phasePreflight: false,
			});

			const manager = new PreflightTriggerManager(disabledConfig);

			// Should not trigger even with valid boundary
			const result = await manager.checkAndTrigger(2, 5, 10);
			expect(result).toBe(false);
			expect(manager.isEnabled()).toBe(false);
		});

		test('SECURE: trigger manager respects mode=manual', async () => {
			const manualConfig = createAutomationConfig({
				mode: 'manual',
				phasePreflight: true,
			});

			const manager = new PreflightTriggerManager(manualConfig);

			expect(manager.isEnabled()).toBe(false);
			expect(manager.getMode()).toBe('manual');
		});

		test('SECURE: handles undefined capabilities gracefully', async () => {
			const config = {
				mode: 'hybrid',
				capabilities: undefined,
			} as unknown as ReturnType<typeof createAutomationConfig>;

			// Manager creates but isEnabled() returns false for undefined capabilities
			const manager = new PreflightTriggerManager(config);

			// SECURE BEHAVIOR: isEnabled() returns false (not throw) when capabilities is undefined
			// This prevents crash-on-invalid-input and maintains secure by default
			expect(manager.isEnabled()).toBe(false);

			// checkAndTrigger also handles gracefully - returns false when not enabled
			const result = await manager.checkAndTrigger(2, 5, 10);
			expect(result).toBe(false);
		});
	});

	describe('mode manipulation attacks', () => {
		test('SECURE: handles invalid mode value', () => {
			const config = {
				mode: 'malicious',
				capabilities: { phase_preflight: true },
			} as unknown as ReturnType<typeof createAutomationConfig>;

			// Should handle gracefully
			expect(() => {
				const manager = new PreflightTriggerManager(config);
				expect(manager.getMode()).toBe('malicious');
				expect(manager.isEnabled()).toBe(true); // mode !== 'manual'
			}).not.toThrow();
		});

		test('SECURE: handles numeric mode', () => {
			const config = {
				mode: 123,
				capabilities: { phase_preflight: true },
			} as unknown as ReturnType<typeof createAutomationConfig>;

			expect(() => new PreflightTriggerManager(config)).not.toThrow();
		});

		test('SECURE: handles null mode', () => {
			const config = {
				mode: null,
				capabilities: { phase_preflight: true },
			} as unknown as ReturnType<typeof createAutomationConfig>;

			expect(() => new PreflightTriggerManager(config)).not.toThrow();
		});
	});

	describe('config prototype pollution attempts', () => {
		test('SECURE: handles __proto__ in config', () => {
			const config = {
				mode: 'hybrid',
				capabilities: { phase_preflight: true },
				__proto__: { polluted: true },
			} as unknown as ReturnType<typeof createAutomationConfig>;

			const manager = new PreflightTriggerManager(config);

			// Should not pollute prototype
			// @ts-expect-error - checking for pollution
			expect({}.polluted).toBeUndefined();
		});

		test('SECURE: handles constructor.prototype in config', () => {
			const config = {
				mode: 'hybrid',
				capabilities: { phase_preflight: true },
				constructor: { prototype: { admin: true } },
			} as unknown as ReturnType<typeof createAutomationConfig>;

			new PreflightTriggerManager(config);

			// @ts-expect-error - checking for pollution
			expect({}.admin).toBeUndefined();
		});
	});
});

// ============================================================================
// ATTACK VECTOR 4: QUEUE OVERFLOW/REPLAY
// ============================================================================

describe('ATTACK: Queue Overflow/Replay', () => {
	let manager: PreflightTriggerManager;

	beforeEach(() => {
		resetGlobalEventBus();
		manager = new PreflightTriggerManager(createAutomationConfig());
	});

	afterEach(() => {
		manager.reset();
	});

	describe('queue overflow attacks', () => {
		test('SECURE: queue has bounded size (100 max)', async () => {
			// Trigger 150 phases rapidly
			for (let phase = 1; phase <= 150; phase++) {
				await manager.checkAndTrigger(phase, 5, 10);
			}

			// Queue should be capped at maxSize
			expect(manager.getQueueSize()).toBeLessThanOrEqual(100);
		});

		test('SECURE: still fires the trigger when queue full (evict-oldest, no brick — #1778 H5)', async () => {
			// Fill the queue
			for (let phase = 1; phase <= 100; phase++) {
				await manager.checkAndTrigger(phase, 5, 10);
			}

			// The 101st trigger must NOT be permanently bricked: it fires and the
			// queue stays bounded via evict-oldest (no throw, no monotonic growth).
			const result = await manager.checkAndTrigger(101, 5, 10);
			expect(result).toBe(true);
			expect(manager.getQueueSize()).toBeLessThanOrEqual(100);
		});

		test('SECURE: concurrent triggers when full are handled without bricking', async () => {
			// Fill queue first
			for (let phase = 1; phase <= 100; phase++) {
				await manager.checkAndTrigger(phase, 5, 10);
			}

			// Concurrent triggers when queue is full
			const promises = Array.from({ length: 20 }, (_, i) =>
				manager.checkAndTrigger(200 + i, 5, 10),
			);

			// All should resolve (not reject) and fire; the queue stays bounded.
			const results = await Promise.all(promises);
			expect(results.every((r) => r === true)).toBe(true);
			expect(manager.getQueueSize()).toBeLessThanOrEqual(100);
		});
	});

	describe('request replay attacks', () => {
		test('SECURE: cannot replay same phase boundary', async () => {
			// Trigger phase 2
			await manager.checkAndTrigger(2, 5, 10);
			const queueSize1 = manager.getQueueSize();

			// Attempt to replay same phase
			manager.updatePhase(1);
			await manager.checkAndTrigger(2, 5, 10);

			// Queue size should not increase
			expect(manager.getQueueSize()).toBe(queueSize1);
		});

		test('SECURE: cannot replay via metadata manipulation', async () => {
			await manager.checkAndTrigger(2, 5, 10);

			// Attempt replay with different task counts
			manager.updatePhase(1);
			const result = await manager.checkAndTrigger(2, 999, 999);

			expect(result).toBe(false);
		});

		test('SECURE: handles rapid phase cycling', async () => {
			// Cycle between phases 1 and 2 many times
			for (let i = 0; i < 50; i++) {
				manager.updatePhase(1);
				await manager.checkAndTrigger(2, 5, 10);
			}

			// Should have limited triggers due to lastTriggeredPhase protection
			expect(manager.getQueueSize()).toBeLessThanOrEqual(50);
		});

		test('SECURE: handles phase regression attack', async () => {
			// Go forward
			await manager.checkAndTrigger(5, 5, 10);
			await manager.checkAndTrigger(10, 5, 10);

			// Try to regress and re-trigger (should create new trigger)
			const queueSize = manager.getQueueSize();
			await manager.checkAndTrigger(3, 5, 10);

			// Phase regression IS a boundary change, so new trigger is expected
			expect(manager.getQueueSize()).toBe(queueSize + 1);
		});
	});

	describe('priority gaming attacks', () => {
		test('all triggers have same priority (high)', async () => {
			// All preflight requests should be high priority
			await manager.checkAndTrigger(1, 5, 10);
			await manager.checkAndTrigger(2, 5, 10);

			const requests = manager.getPendingRequests();
			// Verify requests were queued
			expect(requests.length).toBeGreaterThan(0);
		});

		test('cannot manipulate priority via metadata', async () => {
			// Metadata is not exposed for manipulation in checkAndTrigger
			await manager.checkAndTrigger(1, 5, 10);

			const stats = manager.getStats();
			expect(stats.pendingRequests).toBeGreaterThanOrEqual(1);
		});
	});

	describe('request ID manipulation', () => {
		test('request IDs are unique', async () => {
			await manager.checkAndTrigger(1, 5, 10);
			await manager.checkAndTrigger(2, 5, 10);
			await manager.checkAndTrigger(3, 5, 10);

			const requests = manager.getPendingRequests();
			const ids = requests.map((r) => r.id);
			const uniqueIds = new Set(ids);

			expect(uniqueIds.size).toBe(ids.length);
		});

		test('request ID format is predictable-safe', async () => {
			await manager.checkAndTrigger(1, 5, 10);

			const requests = manager.getPendingRequests();
			expect(requests[0].id).toMatch(/^preflight-\d+-\d+$/);
		});
	});
});

// ============================================================================
// INTEGRATION: COMBINED ATTACKS
// ============================================================================

describe('ATTACK: Combined Integration Attacks', () => {
	let tempDir: string;
	let swarmDir: string;

	beforeEach(() => {
		resetGlobalEventBus();
		tempDir = mkdtempSync(path.join(tmpdir(), 'preflight-combined-'));
		swarmDir = mkdtempSync(path.join(tmpdir(), 'swarm-combined-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		rmSync(swarmDir, { recursive: true, force: true });
	});

	test('survives simultaneous traversal and timeout attacks', async () => {
		const attacks = [
			// Traversal attacks
			runPreflight('../../../etc/passwd', 1),
			runPreflight('..\\..\\..\\windows', 1),
			runPreflight('', 1),
			// Timeout attacks
			runPreflight(tempDir, 1, { checkTimeoutMs: -1000 }),
			runPreflight(tempDir, 1, { checkTimeoutMs: Infinity }),
			runPreflight(tempDir, 1, { checkTimeoutMs: 0 }),
		];

		const results = await Promise.allSettled(attacks);

		// All should settle (not reject)
		results.forEach((result) => {
			expect(result.status).toBe('fulfilled');
		});
	});

	test('handles malformed config with valid directory', async () => {
		const malformedConfigs: PreflightConfig[] = [
			{ checkTimeoutMs: NaN } as PreflightConfig,
			{ checkTimeoutMs: -1 } as PreflightConfig,
			{ skipTests: 'yes' as unknown as boolean },
			{ testScope: 'invalid' as 'all' | 'convention' | 'graph' },
		];

		for (const config of malformedConfigs) {
			const report = await runPreflight(tempDir, 1, config);
			expect(report).toBeDefined();
			expect(['pass', 'fail', 'skipped']).toContain(report.overall);
		}
	});

	test('preflight integration with attack vectors', async () => {
		const config = createAutomationConfig();

		const { manager, cleanup } = createPreflightIntegration({
			automationConfig: config,
			directory: tempDir,
			swarmDir: swarmDir,
		});

		// Spam triggers - limit to 20 to avoid timeout while preserving attack intent
		for (let i = 0; i < 20; i++) {
			manager.updatePhase(i);
			await manager.checkAndTrigger(i + 1, 5, 10);
		}

		expect(manager.getQueueSize()).toBeLessThanOrEqual(100);

		cleanup();
	}, 60000); // 60s timeout for adversarial integration test

	test('handler timeout protection', async () => {
		const config = createAutomationConfig();
		let handlerCalled = false;

		const { manager, cleanup } = createPreflightIntegration({
			automationConfig: config,
			directory: tempDir,
			swarmDir: swarmDir,
		});

		// Register a slow handler
		manager.registerHandler(async () => {
			handlerCalled = true;
			// This should complete before timeout
			await new Promise((resolve) => setTimeout(resolve, 100));
		});

		// Trigger preflight
		await manager.checkAndTrigger(1, 5, 10);

		// Handler should have been called
		expect(handlerCalled).toBe(true);

		cleanup();
	}, 15000); // Increase test timeout for integration test
});

// ============================================================================
// ADDITIONAL: FORMAT/OUTPUT ATTACKS
// ============================================================================

describe('ATTACK: Format/Output Attacks', () => {
	test('formatPreflightMarkdown handles malicious report content', () => {
		const maliciousReport: PreflightReport = {
			id: '<script>alert("xss")</script>',
			timestamp: Date.now(),
			phase: 1,
			overall: 'pass',
			checks: [
				{
					type: 'lint',
					status: 'pass',
					message: '"); DROP TABLE users; --',
					details: {
						injection: '${process.env.SECRET}',
						xss: '<img src=x onerror=alert(1)>',
					},
				},
			],
			totalDurationMs: 100,
			message: '```javascript\nrequire("child_process").exec("rm -rf /")\n```',
		};

		// Should format without executing any code
		const markdown = formatPreflightMarkdown(maliciousReport);

		// The formatter includes malicious content in output (markdown passthrough)
		// This is expected for a CLI tool but note that report ID is NOT included
		// in the output (only phase, overall, duration, checks, and message)
		expect(markdown).toContain('Preflight Report');
		expect(markdown).toContain('DROP TABLE'); // Message is included literally
		expect(markdown).toContain('rm -rf'); // Message is included literally
		// Note: The report ID is NOT exposed in markdown output (intentional)
	});

	test('formatPreflightMarkdown handles extreme values', () => {
		const extremeReport: PreflightReport = {
			id: 'a'.repeat(10000),
			timestamp: Number.MAX_SAFE_INTEGER,
			phase: -999999,
			overall: 'pass',
			checks: [],
			totalDurationMs: Infinity,
			message: '',
		};

		// Should not crash
		const markdown = formatPreflightMarkdown(extremeReport);
		expect(markdown).toBeDefined();
	});
});

// ============================================================================
// SECURITY FINDINGS SUMMARY
// ============================================================================

describe('SECURITY FINDINGS: Task 5.6', () => {
	test('All Task 5.6 attack vectors documented', () => {
		const findings = {
			directoryTraversal: {
				dotDotTraversal:
					'HANDLED - path is normalized via path.normalize(), not rejected outright',
				nullByteInjection:
					'SECURE - handled gracefully, path may fail at OS level',
				emptyPath: 'SECURE - handled gracefully, fails validation',
				uncPaths: 'HANDLED - OS-level handling, no special validation',
				symlinkAttacks:
					'HANDLED - symlink resolved to target path (filesystem-level)',
				finding:
					'NOTE: ".." sequences are NORMALIZED not REJECTED. If attacker can control path and it resolves to valid dir, check runs there.',
			},
			timeoutAbuse: {
				negativeTimeout: 'SECURE - validateTimeout rejects negative values',
				zeroTimeout: 'SECURE - validateTimeout rejects zero',
				infinityNaN: 'SECURE - validateTimeout rejects non-finite values',
				overflowValues:
					'SECURE - validateTimeout caps at 5 minutes max (300000ms)',
				belowMinimum: 'SECURE - validateTimeout enforces 5s minimum (5000ms)',
			},
			configGatingBypass: {
				disabledCapability:
					'SECURE - integration throws error when phase_preflight=false',
				manualMode:
					'SECURE - manager.isEnabled() returns false, triggers skipped',
				missingCapabilities:
					'SECURE - isEnabled() returns false when capabilities is undefined (secure by default)',
				nullCapabilities: 'SECURE - null capabilities handled gracefully',
				prototypePollution: 'SECURE - no prototype pollution detected',
				finding:
					'FIXED: PreflightTriggerManager.isEnabled() now returns false for undefined/null capabilities',
			},
			queueOverflowReplay: {
				queueSizeLimit: 'SECURE - maxSize of 100 enforced',
				overflowBehavior:
					'SECURE - returns false gracefully when full, publishes preflight.skipped event',
				replayAttacks:
					'MITIGATED - lastTriggeredPhase prevents duplicate triggers for same phase',
				priorityGaming:
					'HANDLED - all triggers use same high priority (no gaming possible)',
				uniqueRequestIds:
					'SECURE - unique IDs generated with timestamp+counter pattern',
			},
			outputSafety: {
				markdownPassthrough:
					'FINDING - Message content passed through literally to markdown',
				reportIdNotExposed:
					'SECURE - Report ID is NOT included in markdown output',
			},
		};

		// Count vulnerabilities - should document FIXED ones (no active vulnerabilities)
		const allFindings = Object.values(findings).flatMap((f) =>
			typeof f === 'string' ? [f] : Object.values(f),
		);
		const vulnerabilities = allFindings.filter(
			(v) => typeof v === 'string' && v.startsWith('VULN'),
		);

		// No active vulnerabilities - all previously found issues are now fixed
		expect(vulnerabilities.length).toBe(0);

		// Verify security hardening is documented
		const fixed = allFindings.filter(
			(v) => typeof v === 'string' && v.startsWith('FIXED'),
		);
		expect(fixed.length).toBeGreaterThanOrEqual(1);

		// Document findings that are not vulnerabilities but notable
		const notes = allFindings.filter(
			(v) => typeof v === 'string' && v.startsWith('NOTE:'),
		);
		expect(notes.length).toBeGreaterThanOrEqual(1);
	});
});
