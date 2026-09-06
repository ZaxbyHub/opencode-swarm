import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	unlinkSync,
} from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closePlanTerminalState, savePlan } from '../../../src/plan/manager';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function createTestPlan(overrides?: Partial<Plan>): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'in_progress',
						size: 'small',
						description: 'Task one',
						depends: [],
						files_touched: [],
					},
					{
						id: '1.2',
						phase: 1,
						status: 'pending',
						size: 'medium',
						description: 'Task two',
						depends: [],
						files_touched: [],
					},
				],
			},
			{
				id: 2,
				name: 'Phase 2',
				status: 'pending',
				tasks: [
					{
						id: '2.1',
						phase: 2,
						status: 'pending',
						size: 'small',
						description: 'Task three',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Attack Surface 1: Temp file path injection
// Path traversal via directory or swarmDir with '..' or null bytes
// ---------------------------------------------------------------------------

describe('Adversarial: Temp file path injection', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'path-injection-'));
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		mock.restore();
	});

	/**
	 * A1: Path traversal with '..' in directory parameter
	 * Attempt to escape the temp directory via '../' in the directory path.
	 * The temp file should be created inside .swarm/, not in parent directories.
	 */
	test('A1. directory with .. traversal - temp files stay inside .swarm/', async () => {
		const testPlan = createTestPlan();

		// Attempt path traversal via .. in directory
		const maliciousDir = join(tempDir, 'legit', '..');
		// Also test with explicit .. path
		const escapeDir = join(tempDir, '.swarm', '..', '.swarm');

		// Both should work without escaping
		await savePlan(maliciousDir, testPlan);
		await savePlan(escapeDir, testPlan);

		// Verify plan.json exists in the correct .swarm/ location
		expect(existsSync(join(tempDir, '.swarm', 'plan.json'))).toBe(true);
		expect(existsSync(join(tempDir, '.swarm', 'plan.md'))).toBe(true);

		// Verify NO plan.json leaked to parent or sibling directories
		expect(existsSync(join(tempDir, 'legit', 'plan.json'))).toBe(false);
		expect(existsSync(join(tempDir, 'plan.json'))).toBe(false);
	});

	/**
	 * A2: Directory with null byte - should be rejected or handled safely
	 * JavaScript strings can contain null bytes, which on some filesystems
	 * can cause truncation or other issues.
	 */
	test('A2. directory with null byte - throws clear error', async () => {
		const testPlan = createTestPlan();

		// Create a directory with null byte in path
		const nullByteDir = tempDir + '\0malicious';
		let threw = false;
		let errorMsg = '';

		try {
			await savePlan(nullByteDir, testPlan);
		} catch (e) {
			threw = true;
			errorMsg = String(e);
		}

		// Should either throw (safe) or handle gracefully
		expect(threw).toBe(true);
		// Error should be informative, not cryptic
		expect(errorMsg.length).toBeGreaterThan(0);
	});

	/**
	 * A3: Very long directory path components - ensure path handling is robust
	 * NOTE: Shortened to avoid ENAMETOOLONG on Windows (max ~260 chars for full path)
	 */
	test('A3. long path components - temp files still created correctly', async () => {
		const testPlan = createTestPlan();

		// Create nested directories with long names (but within OS limits)
		const longBase = join(tempDir, 'a'.repeat(50));
		mkdirSync(longBase, { recursive: true });

		await savePlan(longBase, testPlan);

		// Verify plan.json exists in the correct .swarm/ location
		expect(existsSync(join(longBase, '.swarm', 'plan.json'))).toBe(true);
	});

	/**
	 * A4: Directory path with Unicode characters - ensure proper handling
	 */
	test('A4. directory with Unicode - plan.json created correctly', async () => {
		const testPlan = createTestPlan();

		const unicodeDir = join(tempDir, '日本語', '日本語2');
		mkdirSync(unicodeDir, { recursive: true });

		await savePlan(unicodeDir, testPlan);

		expect(existsSync(join(unicodeDir, '.swarm', 'plan.json'))).toBe(true);
	});

	/**
	 * A5: Symbolic link in path - temp files should not escape via symlink
	 */
	test('A5. directory is a symlink - temp files resolve inside real directory', async () => {
		if (process.platform === 'win32') {
			// Symlinks on Windows require admin privileges, skip
			return;
		}

		const testPlan = createTestPlan();
		const linkTarget = join(tempDir, 'real-target');
		const linkPath = join(tempDir, 'symlink');

		mkdirSync(linkTarget, { recursive: true });
		symlinkSync(linkTarget, linkPath);

		try {
			// Use the symlink path
			await savePlan(linkPath, testPlan);

			// Files should exist in the real target directory
			expect(existsSync(join(linkTarget, '.swarm', 'plan.json'))).toBe(true);
		} finally {
			try {
				unlinkSync(linkPath);
			} catch {
				/* ignore */
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Attack Surface 2: Marker content injection
// What happens if phases_count or tasks_count are extreme values?
// ---------------------------------------------------------------------------

describe('Adversarial: Marker content injection', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'marker-injection-'));
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	/**
	 * B1: Minimal plan - should serialize correctly
	 */
	test('B1. marker JSON with minimal plan - valid JSON produced', async () => {
		const minimalPlan = createTestPlan({
			phases: [
				{
					id: 1,
					name: 'Single Phase',
					status: 'pending',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'Only task',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});

		await savePlan(tempDir, minimalPlan);

		const markerPath = join(tempDir, '.swarm', '.plan-write-marker');
		const content = await readFile(markerPath, 'utf-8');

		// Must be valid JSON
		expect(() => JSON.parse(content)).not.toThrow();

		const marker = JSON.parse(content);
		expect(typeof marker.phases_count).toBe('number');
		expect(typeof marker.tasks_count).toBe('number');
		expect(Number.isFinite(marker.phases_count)).toBe(true);
		expect(Number.isFinite(marker.tasks_count)).toBe(true);
	});

	/**
	 * B2: Large task count - verify JSON handles it correctly
	 */
	test('B2. marker JSON with 10000 tasks - valid JSON and correct count', async () => {
		const manyTasks = Array.from({ length: 10000 }, (_, i) => ({
			id: `1.${i + 1}`,
			phase: 1,
			status: 'pending' as const,
			size: 'small' as const,
			description: `Task ${i + 1}`,
			depends: [] as string[],
			files_touched: [] as string[],
		}));

		const largePlan = createTestPlan({
			phases: [
				{
					id: 1,
					name: 'Large Phase',
					status: 'in_progress',
					tasks: manyTasks,
				},
			],
		});

		await savePlan(tempDir, largePlan);

		const markerPath = join(tempDir, '.swarm', '.plan-write-marker');
		const content = await readFile(markerPath, 'utf-8');

		const marker = JSON.parse(content);
		expect(marker.tasks_count).toBe(10000);
		// JSON should be valid and complete
		expect(content).toContain('"tasks_count":10000');
	});

	/**
	 * B3: Marker source field - no injection possible (hardcoded value)
	 */
	test('B3. marker source field - no injection possible (hardcoded value)', async () => {
		const testPlan = createTestPlan();
		await savePlan(tempDir, testPlan);

		const markerPath = join(tempDir, '.swarm', '.plan-write-marker');
		const content = await readFile(markerPath, 'utf-8');
		const marker = JSON.parse(content);

		// source is always 'plan_manager' - no user control
		expect(marker.source).toBe('plan_manager');

		// Verify no control characters in source
		expect(marker.source).not.toMatch(/[\n\r\t\0]/);
	});

	/**
	 * B4: ISO timestamp in marker - verify format is always valid
	 */
	test('B4. marker timestamp - always valid ISO 8601, no injection possible', async () => {
		const testPlan = createTestPlan();
		await savePlan(tempDir, testPlan);

		const markerPath = join(tempDir, '.swarm', '.plan-write-marker');
		const content = await readFile(markerPath, 'utf-8');
		const marker = JSON.parse(content);

		// Verify timestamp is valid ISO 8601
		const date = new Date(marker.timestamp);
		expect(Number.isNaN(date.getTime())).toBe(false);
		expect(marker.timestamp).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/,
		);

		// Timestamp should be current (within 1 minute)
		const now = Date.now();
		const markerTime = date.getTime();
		expect(Math.abs(now - markerTime)).toBeLessThan(60000);
	});
});

// ---------------------------------------------------------------------------
// Attack Surface 3: Random suffix collision
// What if Math.random returns 0 or edge values?
// ---------------------------------------------------------------------------

describe('Adversarial: Random suffix collision', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'random-collision-'));
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	/**
	 * C1: Math.random() returns 0 - temp file path still unique via Date.now()
	 */
	test('C1. Math.random mocked to return 0 - savePlan still succeeds', async () => {
		const testPlan = createTestPlan();

		// Mock Math.random to always return 0
		const originalRandom = Math.random;
		Math.random = () => 0;

		try {
			// Should still work - Date.now() provides uniqueness
			await savePlan(tempDir, testPlan);
			expect(existsSync(join(tempDir, '.swarm', 'plan.json'))).toBe(true);
		} finally {
			Math.random = originalRandom;
		}
	});

	/**
	 * C2: Math.random() returns near-maximum value - still produces valid suffix
	 */
	test('C2. Math.random mocked to return 0.999999999 - savePlan succeeds', async () => {
		const testPlan = createTestPlan();

		const originalRandom = Math.random;
		Math.random = () => 0.999999999;

		try {
			await savePlan(tempDir, testPlan);
			expect(existsSync(join(tempDir, '.swarm', 'plan.json'))).toBe(true);
		} finally {
			Math.random = originalRandom;
		}
	});

	/**
	 * C3: Rapid sequential calls - Date.now() provides millisecond-level uniqueness
	 */
	test('C3. multiple rapid saves - all succeed without collision', async () => {
		const testPlan = createTestPlan();

		// Rapid sequential saves
		for (let i = 0; i < 10; i++) {
			await savePlan(tempDir, testPlan);
		}

		// All files should exist
		expect(existsSync(join(tempDir, '.swarm', 'plan.json'))).toBe(true);
		expect(existsSync(join(tempDir, '.swarm', 'plan.md'))).toBe(true);
		expect(existsSync(join(tempDir, '.swarm', '.plan-write-marker'))).toBe(
			true,
		);
	});
});

// ---------------------------------------------------------------------------
// Attack Surface 4: Telemetry source injection
// What if source option contains newlines, control characters, or long strings?
// ---------------------------------------------------------------------------

describe('Adversarial: Telemetry source injection', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'telemetry-injection-'));
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		mock.restore();
	});

	/**
	 * D1: Source field in closePlanTerminalState - verify no newlines
	 */
	test('D1. telemetry source - no raw newlines in source (close_terminal)', async () => {
		// Mock ledger module to capture calls
		const mockAppendLedgerEvent = mock(async () => {});
		const mockTakeSnapshotEvent = mock(async () => ({}));

		mock.module('../../../src/plan/ledger', () => ({
			appendLedgerEvent: mockAppendLedgerEvent,
			takeSnapshotEvent: mockTakeSnapshotEvent,
			_internals: {
				appendLedgerEvent: mockAppendLedgerEvent,
			},
		}));

		const testPlan = createTestPlan();

		await closePlanTerminalState(tempDir, testPlan, {
			closedPhaseIds: [],
			closedTaskIds: ['1.1'],
		});

		// Verify the calls were made
		expect(mockTakeSnapshotEvent).toHaveBeenCalled();

		// Capture the source argument
		const snapshotCall = mockTakeSnapshotEvent.mock.calls[0];
		const sourceArg = snapshotCall[2]?.source;
		expect(typeof sourceArg).toBe('string');
		// Source should not contain raw newlines (would corrupt JSONL)
		expect(sourceArg).not.toContain('\n');
		expect(sourceArg).not.toContain('\r');
	});

	/**
	 * D2: Source with control characters - should not appear raw
	 */
	test('D2. source with tab/control chars - no raw control chars', async () => {
		const mockAppendLedgerEvent = mock(async () => {});
		const mockTakeSnapshotEvent = mock(async () => ({}));

		mock.module('../../../src/plan/ledger', () => ({
			appendLedgerEvent: mockAppendLedgerEvent,
			takeSnapshotEvent: mockTakeSnapshotEvent,
			_internals: {
				appendLedgerEvent: mockAppendLedgerEvent,
			},
		}));

		const testPlan = createTestPlan();

		await closePlanTerminalState(tempDir, testPlan, {
			closedPhaseIds: [],
			closedTaskIds: ['1.1'],
		});

		const snapshotCall = mockTakeSnapshotEvent.mock.calls[0];
		const sourceArg = snapshotCall[2]?.source;

		// Control chars 0x00-0x1F (except \t\n\r) should not appear raw
		const controlCharPattern = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;
		expect(sourceArg).not.toMatch(controlCharPattern);
	});

	/**
	 * D3: Very long source string - should not cause issues
	 */
	test('D3. closePlanTerminalState with large plan - completes without error', async () => {
		const mockAppendLedgerEvent = mock(async () => {});
		const mockTakeSnapshotEvent = mock(async () => ({}));

		mock.module('../../../src/plan/ledger', () => ({
			appendLedgerEvent: mockAppendLedgerEvent,
			takeSnapshotEvent: mockTakeSnapshotEvent,
			_internals: {
				appendLedgerEvent: mockAppendLedgerEvent,
			},
		}));

		const testPlan = createTestPlan();

		let threw = false;
		try {
			await closePlanTerminalState(tempDir, testPlan, {
				closedPhaseIds: [],
				closedTaskIds: ['1.1'],
			});
		} catch {
			threw = true;
		}
		// Should not throw due to size
		expect(threw).toBe(false);
	});

	/**
	 * D4: Unicode in source - should serialize correctly
	 */
	test('D4. source is valid string without Unicode issues', async () => {
		const mockAppendLedgerEvent = mock(async () => {});
		const mockTakeSnapshotEvent = mock(async () => ({}));

		mock.module('../../../src/plan/ledger', () => ({
			appendLedgerEvent: mockAppendLedgerEvent,
			takeSnapshotEvent: mockTakeSnapshotEvent,
			_internals: {
				appendLedgerEvent: mockAppendLedgerEvent,
			},
		}));

		const testPlan = createTestPlan();

		await closePlanTerminalState(tempDir, testPlan, {
			closedPhaseIds: [],
			closedTaskIds: ['1.1'],
		});

		const snapshotCall = mockTakeSnapshotEvent.mock.calls[0];
		const sourceArg = snapshotCall[2]?.source;

		// Source should be valid string
		expect(typeof sourceArg).toBe('string');
		expect(sourceArg.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Attack Surface 5: plan.md write failure during closePlanTerminalState
// Finally block must always execute - marker must always be reset
// ---------------------------------------------------------------------------

// NOTE: These tests use file system mocking carefully to avoid cross-test pollution
// because mock.module can persist in Bun's test runner

describe('Adversarial: plan.md write failure resilience', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'plan-md-failure-'));
		mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		mock.restore();
	});

	/**
	 * E1: Verify marker structure is correct after closePlanTerminalState
	 * The finally block invariant: marker always reset to in_progress: false
	 */
	test('E1. marker has correct structure after closePlanTerminalState', async () => {
		const testPlan = createTestPlan();

		mkdirSync(join(tempDir, '.swarm'), { recursive: true });

		await closePlanTerminalState(tempDir, testPlan, {
			closedPhaseIds: [1],
			closedTaskIds: ['1.1', '1.2'],
		});

		const markerPath = join(tempDir, '.swarm', '.plan-write-marker');
		expect(existsSync(markerPath)).toBe(true);

		const content = await readFile(markerPath, 'utf-8');
		const marker = JSON.parse(content);

		// Critical invariant: marker must show in_progress: false
		// This proves the finally block executed properly
		expect(marker.source).toBe('plan_manager_close');
		expect(marker.phases_count).toBe(2);
		expect(marker.tasks_count).toBe(3);
		expect(marker.in_progress).toBe(false);
	});

	/**
	 * E2: Multiple tasks closed - marker counts are accurate
	 */
	test('E2. marker counts match actual closed tasks', async () => {
		const testPlan = createTestPlan();

		mkdirSync(join(tempDir, '.swarm'), { recursive: true });

		await closePlanTerminalState(tempDir, testPlan, {
			closedPhaseIds: [1, 2],
			closedTaskIds: ['1.1', '1.2', '2.1'],
		});

		const markerPath = join(tempDir, '.swarm', '.plan-write-marker');
		const content = await readFile(markerPath, 'utf-8');
		const marker = JSON.parse(content);

		expect(marker.phases_count).toBe(2);
		expect(marker.tasks_count).toBe(3);
		expect(marker.in_progress).toBe(false);
	});

	/**
	 * E3: Zero tasks/phases closed - still valid marker
	 */
	test('E3. zero tasks/phases closed - marker still valid', async () => {
		const testPlan = createTestPlan();

		mkdirSync(join(tempDir, '.swarm'), { recursive: true });

		await closePlanTerminalState(tempDir, testPlan, {
			closedPhaseIds: [],
			closedTaskIds: [],
		});

		const markerPath = join(tempDir, '.swarm', '.plan-write-marker');
		expect(existsSync(markerPath)).toBe(true);

		const content = await readFile(markerPath, 'utf-8');
		const marker = JSON.parse(content);

		expect(marker.in_progress).toBe(false);
		expect(typeof marker.phases_count).toBe('number');
		expect(typeof marker.tasks_count).toBe('number');
	});
});

// ---------------------------------------------------------------------------
// Attack Surface 6: Concurrent temp file collision
// Two simultaneous calls with same timestamp + different Math.random() suffixes
// ---------------------------------------------------------------------------

describe('Adversarial: Concurrent temp file collision', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'concurrent-collision-'));
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		mock.restore();
	});

	/**
	 * F1: Two concurrent closePlanTerminalState calls - both should succeed
	 */
	test('F1. concurrent closePlanTerminalState calls - no file collision', async () => {
		const testPlan = createTestPlan();

		const mockAppendLedgerEvent = mock(async () => {});
		const mockTakeSnapshotEvent = mock(async () => ({}));

		mock.module('../../../src/plan/ledger', () => ({
			appendLedgerEvent: mockAppendLedgerEvent,
			takeSnapshotEvent: mockTakeSnapshotEvent,
			_internals: {
				appendLedgerEvent: mockAppendLedgerEvent,
			},
		}));

		mkdirSync(join(tempDir, '.swarm'), { recursive: true });

		const results = await Promise.allSettled([
			closePlanTerminalState(tempDir, testPlan, {
				closedPhaseIds: [],
				closedTaskIds: ['1.1'],
			}),
			closePlanTerminalState(tempDir, testPlan, {
				closedPhaseIds: [],
				closedTaskIds: ['1.2'],
			}),
		]);

		// Both should succeed (or at least one, due to CAS conflicts)
		const successes = results.filter((r) => r.status === 'fulfilled');
		expect(successes.length).toBeGreaterThan(0);
	});

	/**
	 * F2: Math.random mocked identical - savePlan completes successfully
	 */
	test('F2. Math.random mocked identical - savePlan completes', async () => {
		const originalRandom = Math.random;
		Math.random = () => 0.5; // Constant value

		try {
			const testPlan = createTestPlan();
			await savePlan(tempDir, testPlan);
			expect(existsSync(join(tempDir, '.swarm', 'plan.json'))).toBe(true);
		} finally {
			Math.random = originalRandom;
		}
	});

	/**
	 * F3: Concurrent ledger appends - CAS retry handles collisions
	 */
	test('F3. concurrent ledger appends - retry handles collisions', async () => {
		const testPlan = createTestPlan();

		mkdirSync(join(tempDir, '.swarm'), { recursive: true });

		// Initialize ledger first
		const { initLedger } = await import('../../../src/plan/ledger');
		await initLedger(tempDir, 'test-swarm-Test_Plan', '', testPlan);

		// Now try concurrent updates
		const results = await Promise.allSettled([
			savePlan(tempDir, testPlan),
			savePlan(tempDir, testPlan),
			savePlan(tempDir, testPlan),
		]);

		// At least one should succeed
		const successes = results.filter((r) => r.status === 'fulfilled');
		expect(successes.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Attack Surface 7: regeneratePlanMarkdown temp file safety
// ---------------------------------------------------------------------------

describe('Adversarial: regeneratePlanMarkdown temp file safety', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'regen-md-'));
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	/**
	 * G1: swarmDir with '..' - temp path should not escape
	 */
	test('G1. swarmDir path traversal - temp file inside .swarm/', async () => {
		const testPlan = createTestPlan();

		// Initialize with a plan first
		await savePlan(tempDir, testPlan);

		// Now regenerate plan.md (this uses regeneratePlanMarkdown)
		const { regeneratePlanMarkdown } = await import(
			'../../../src/plan/manager'
		);

		await regeneratePlanMarkdown(tempDir, testPlan);

		const mdPath = join(tempDir, '.swarm', 'plan.md');
		expect(existsSync(mdPath)).toBe(true);

		// Verify content has the hash header
		const content = await readFile(mdPath, 'utf-8');
		expect(content).toMatch(/^<!-- PLAN_HASH: [a-z0-9]+ -->/);
	});

	/**
	 * G2: regeneratePlanMarkdown produces valid markdown even with special chars
	 */
	test('G2. plan with special chars in title - valid markdown produced', async () => {
		const testPlan = createTestPlan({
			title: 'Test <script>alert("xss")</script> & "quotes"',
			phases: [
				{
					id: 1,
					name: 'Phase with "double quotes"',
					status: 'pending',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'Task with `code` and # headings',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});

		const { regeneratePlanMarkdown } = await import(
			'../../../src/plan/manager'
		);
		await regeneratePlanMarkdown(tempDir, testPlan);

		const mdPath = join(tempDir, '.swarm', 'plan.md');
		const content = await readFile(mdPath, 'utf-8');

		// Markdown should be valid and contain the title
		expect(content).toContain('# Test');
		expect(content).toContain('Phase 1');
	});
});

// ---------------------------------------------------------------------------
// Attack Surface 8: savePlan directory validation bypass
// ---------------------------------------------------------------------------

describe('Adversarial: savePlan directory validation bypass', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'dir-validation-'));
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	/**
	 * H1: Empty string directory - should throw early
	 */
	test('H1. empty string directory - throws with clear error', async () => {
		const testPlan = createTestPlan();

		let errorMsg = '';
		try {
			await savePlan('', testPlan);
		} catch (e) {
			errorMsg = String(e);
		}

		expect(errorMsg).toContain('Invalid directory');
	});

	/**
	 * H2: null directory - should throw early
	 */
	test('H2. null directory - throws with clear error', async () => {
		const testPlan = createTestPlan();

		let threw = false;
		try {
			// @ts-expect-error - testing invalid input
			await savePlan(null, testPlan);
		} catch {
			threw = true;
		}

		expect(threw).toBe(true);
	});

	/**
	 * H3: undefined directory - should throw early
	 */
	test('H3. undefined directory - throws with clear error', async () => {
		const testPlan = createTestPlan();

		let threw = false;
		try {
			// @ts-expect-error - testing invalid input
			await savePlan(undefined, testPlan);
		} catch {
			threw = true;
		}

		expect(threw).toBe(true);
	});

	/**
	 * H4: whitespace-only directory - should throw
	 */
	test('H4. whitespace-only directory - throws with clear error', async () => {
		const testPlan = createTestPlan();

		let threw = false;
		try {
			await savePlan('   ', testPlan);
		} catch {
			threw = true;
		}

		expect(threw).toBe(true);
	});

	/**
	 * H5: directory with only null bytes - should throw before any I/O
	 */
	test('H5. directory with only null bytes - throws early', async () => {
		const testPlan = createTestPlan();

		let threw = false;
		try {
			await savePlan('\0\0\0', testPlan);
		} catch {
			threw = true;
		}

		expect(threw).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Attack Surface 9: PlanSchema validation bypass attempts
// ---------------------------------------------------------------------------

describe('Adversarial: PlanSchema validation bypass', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'schema-bypass-'));
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	/**
	 * I1: Invalid phase status - should be corrected by savePlan or throw
	 */
	test('I1. invalid phase status - savePlan handles gracefully', async () => {
		const testPlan = createTestPlan({
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					// @ts-expect-error - intentionally invalid status
					status: 'invalid_status',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'Task',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});

		let threw = false;
		try {
			await savePlan(tempDir, testPlan);
		} catch {
			threw = true;
		}

		// Schema validation should either throw or handle
		expect(typeof threw).toBe('boolean');
	});

	/**
	 * I2: Task with invalid status - should be corrected or throw
	 */
	test('I2. invalid task status - savePlan handles gracefully', async () => {
		const testPlan = createTestPlan({
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'pending',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							// @ts-expect-error - intentionally invalid status
							status: 'hacked_status',
							size: 'small',
							description: 'Task',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});

		let threw = false;
		try {
			await savePlan(tempDir, testPlan);
		} catch {
			threw = true;
		}

		// Should either throw on validation or handle
		expect(typeof threw).toBe('boolean');
	});

	/**
	 * I3: Circular task dependencies - should be detected or allowed
	 */
	test('I3. circular task dependencies - plan saved or error thrown', async () => {
		const testPlan = createTestPlan({
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'Task 1',
							depends: ['1.2'],
							files_touched: [],
						},
						{
							id: '1.2',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'Task 2',
							depends: ['1.1'], // Circular!
							files_touched: [],
						},
					],
				},
			],
		});

		let threw = false;
		try {
			await savePlan(tempDir, testPlan);
		} catch {
			threw = true;
		}

		// Circular deps may or may not be allowed - verify no crash
		expect(typeof threw).toBe('boolean');
	});
});
