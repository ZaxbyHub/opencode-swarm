import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	PlanConcurrentModificationError,
	savePlan,
} from '../../../src/plan/manager';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

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
						status: 'pending',
						size: 'small',
						description: 'Task one',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
		...overrides,
	};
}

describe('savePlan write-marker adversarial tests', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = canonicalMkdtemp('opencode-adversarial-');
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	/**
	 * ADVERSARIAL TEST 1: Marker path traversal
	 * Verify that directory paths with trailing slashes/dots produce marker in correct .swarm/ subdirectory,
	 * not somewhere unexpected.
	 */
	test('1. Marker path traversal - trailing slash does not escape directory', async () => {
		const testPlan = createTestPlan();

		// Test with trailing slash
		const dirWithTrailingSlash = tempDir + '/';
		await savePlan(dirWithTrailingSlash, testPlan);

		const expectedMarkerPath = join(tempDir, '.swarm', '.plan-write-marker');
		const unexpectedPaths = [
			join(tempDir, '.plan-write-marker'),
			join(tempDir, '..', '.swarm', '.plan-write-marker'),
			join(tempDir, '.', '.swarm', '.plan-write-marker'),
		];

		// Marker should be in the correct location
		expect(existsSync(expectedMarkerPath)).toBe(true);

		// Marker should NOT be in unexpected locations
		for (const unexpectedPath of unexpectedPaths) {
			if (unexpectedPath !== expectedMarkerPath) {
				expect(existsSync(unexpectedPath)).toBe(false);
			}
		}
	});

	test('1. Marker path traversal - trailing dots do not escape directory', async () => {
		const testPlan = createTestPlan();

		// Test with trailing dots
		const dirWithDots = tempDir + '/.';
		await savePlan(dirWithDots, testPlan);

		const expectedMarkerPath = join(tempDir, '.swarm', '.plan-write-marker');

		// Marker should be in the correct location
		expect(existsSync(expectedMarkerPath)).toBe(true);
	});

	test('1. Marker path traversal - multiple trailing slashes', async () => {
		const testPlan = createTestPlan();

		// Test with multiple trailing slashes
		const dirWithMultipleSlashes = tempDir + '///';
		await savePlan(dirWithMultipleSlashes, testPlan);

		const expectedMarkerPath = join(tempDir, '.swarm', '.plan-write-marker');

		// Marker should be in the correct location
		expect(existsSync(expectedMarkerPath)).toBe(true);
	});

	/**
	 * ADVERSARIAL TEST 2: JSON injection in marker
	 * Verify marker is valid JSON even for edge-case plans.
	 * Note: PlanSchema requires at least 1 phase and 1 task, so we test minimum valid values.
	 */
	test('2. JSON injection - marker is valid JSON with minimum phases/tasks', async () => {
		// Minimum valid plan (1 phase, 1 task)
		const minimalPlan = createTestPlan({
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'pending',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'Single task',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});

		await savePlan(tempDir, minimalPlan);

		const markerPath = join(tempDir, '.swarm', '.plan-write-marker');
		const markerContent = await readFile(markerPath, 'utf-8');

		// Should parse as valid JSON
		const marker = JSON.parse(markerContent);

		// Values should be numbers (not strings that could be injected)
		expect(typeof marker.phases_count).toBe('number');
		expect(typeof marker.tasks_count).toBe('number');
		expect(marker.phases_count).toBe(1);
		expect(marker.tasks_count).toBe(1);
	});

	test('2. JSON injection - marker is valid JSON with many tasks', async () => {
		// Plan with many tasks in a single phase
		const manyTasks = Array.from({ length: 100 }, (_, i) => ({
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
					name: 'Phase 1',
					status: 'in_progress',
					tasks: manyTasks,
				},
			],
		});

		await savePlan(tempDir, largePlan);

		const markerPath = join(tempDir, '.swarm', '.plan-write-marker');
		const markerContent = await readFile(markerPath, 'utf-8');

		// Should parse as valid JSON
		const marker = JSON.parse(markerContent);
		expect(marker.tasks_count).toBe(100);
		expect(marker.phases_count).toBe(1);
	});

	test('2. JSON injection - marker has valid ISO timestamp format', async () => {
		const testPlan = createTestPlan();
		await savePlan(tempDir, testPlan);

		const markerPath = join(tempDir, '.swarm', '.plan-write-marker');
		const markerContent = await readFile(markerPath, 'utf-8');
		const marker = JSON.parse(markerContent);

		// Timestamp should be valid ISO 8601
		const date = new Date(marker.timestamp);
		expect(Number.isNaN(date.getTime())).toBe(false);

		// Should contain T and Z (ISO 8601 format)
		expect(marker.timestamp).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/,
		);
	});

	/**
	 * ADVERSARIAL TEST 3: Concurrent write race
	 * Concurrent savePlan() calls must either serialize or reject a loser without
	 * corrupting the durable projection.
	 */
	test('3. Concurrent writes - serialize or reject without corruption', async () => {
		const testPlan = createTestPlan();

		const results = await Promise.allSettled([
			savePlan(tempDir, testPlan),
			savePlan(tempDir, testPlan),
		]);
		expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
		for (const result of results) {
			if (result.status === 'rejected') {
				expect(result.reason).toBeInstanceOf(PlanConcurrentModificationError);
			}
		}

		// Plan files should exist
		expect(existsSync(join(tempDir, '.swarm', 'plan.json'))).toBe(true);
		expect(existsSync(join(tempDir, '.swarm', 'plan.md'))).toBe(true);
	});

	test('3. Concurrent writes - marker exists after concurrent writes', async () => {
		const testPlan = createTestPlan();

		const results = await Promise.allSettled([
			savePlan(tempDir, testPlan),
			savePlan(tempDir, testPlan),
			savePlan(tempDir, testPlan),
		]);
		expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
		for (const result of results) {
			if (result.status === 'rejected') {
				expect(result.reason).toBeInstanceOf(PlanConcurrentModificationError);
			}
		}

		// Marker should exist (last write wins)
		const markerPath = join(tempDir, '.swarm', '.plan-write-marker');
		expect(existsSync(markerPath)).toBe(true);

		// Marker should be valid JSON
		const markerContent = await readFile(markerPath, 'utf-8');
		const marker = JSON.parse(markerContent);
		expect(marker.source).toBe('plan_manager');
	});

	/**
	 * ADVERSARIAL TEST 4: Marker does not leak plan content
	 * Marker must contain ONLY source, timestamp, phases_count, tasks_count.
	 * No task descriptions, titles, or IDs.
	 */
	test('4. No content leak - marker contains only allowed fields', async () => {
		const planWithSensitiveData = createTestPlan({
			title: 'SECRET PROJECT - Top Secret',
			swarm: 'secret-swarm',
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
							description: 'Steal the nuclear codes',
							depends: [],
							files_touched: ['/etc/passwd', '/root/.ssh/id_rsa'],
						},
						{
							id: '1.2',
							phase: 1,
							status: 'pending',
							size: 'medium',
							description: 'Delete all logs',
							depends: ['1.1'],
							files_touched: [],
						},
					],
				},
				{
					id: 2,
					name: 'Phase 2 - Confidential',
					status: 'pending',
					tasks: [
						{
							id: '2.1',
							phase: 2,
							status: 'pending',
							size: 'large',
							description: 'POISON PILL TASK - do not execute',
							depends: [],
							files_touched: [],
							acceptance: 'Super secret acceptance criteria',
							evidence_path: '/root/.env',
							blocked_reason: 'Waiting for CIA',
						},
					],
				},
			],
		});

		await savePlan(tempDir, planWithSensitiveData);

		const markerPath = join(tempDir, '.swarm', '.plan-write-marker');
		const markerContent = await readFile(markerPath, 'utf-8');
		const marker = JSON.parse(markerContent);

		// Marker should have exactly these safe bookkeeping fields.
		const allowedFields = [
			'source',
			'timestamp',
			'in_progress',
			'phases_count',
			'tasks_count',
		];
		const markerKeys = Object.keys(marker);

		expect(markerKeys.sort()).toEqual(allowedFields.sort());

		// Verify values are safe (no leakage)
		const content = markerContent.toLowerCase();
		expect(content).not.toContain('secret');
		expect(content).not.toContain('nuclear');
		expect(content).not.toContain('password');
		expect(content).not.toContain('poison');
		expect(content).not.toContain('acceptance');
		expect(content).not.toContain('evidence');
		expect(content).not.toContain('passwd');
		expect(content).not.toContain('.ssh');
		expect(content).not.toContain('.env');

		// Verify counts are correct
		expect(marker.phases_count).toBe(2);
		expect(marker.tasks_count).toBe(3);
	});

	test('4. No content leak - no task IDs in marker', async () => {
		const testPlan = createTestPlan();
		await savePlan(tempDir, testPlan);

		const markerPath = join(tempDir, '.swarm', '.plan-write-marker');
		const markerContent = await readFile(markerPath, 'utf-8');
		const marker = JSON.parse(markerContent);

		// Task IDs like "1.1" should NOT appear in marker. Check all fields
		// EXCEPT the timestamp, whose millisecond suffix can incidentally
		// contain the substring "1.1" (e.g. ISO 8601 "...41.123Z" contains
		// "1.1" at chars 1–3 of "41.123"). The timestamp is always safe —
		// it's a machine-generated value, not user plan content.
		for (const [key, value] of Object.entries(marker)) {
			if (key === 'timestamp') continue;
			expect(String(value)).not.toContain('1.1');
		}
	});

	/**
	 * ADVERSARIAL TEST 5: Plan save succeeds even if marker cannot be written
	 * If .swarm/ exists but marker file cannot be written, savePlan() still succeeds.
	 */
	test('5. Plan save succeeds - marker directory read-only (Unix)', async () => {
		// Skip on Windows/root — chmod behavior differs or is ignored
		if (process.platform === 'win32' || process.getuid?.() === 0) {
			return;
		}

		const testPlan = createTestPlan();
		const swarmDir = join(tempDir, '.swarm');

		// Create .swarm directory
		mkdirSync(swarmDir, { recursive: true });

		// Make the directory read-only (no write permission)
		await chmod(swarmDir, 0o555);

		// Probe: verify chmod actually blocks writes on this platform
		const probePath = join(swarmDir, '.chmod-probe');
		let chmodEffective = false;
		try {
			const { writeFileSync, unlinkSync } = await import('node:fs');
			writeFileSync(probePath, 'test');
			try {
				unlinkSync(probePath);
			} catch {}
		} catch {
			chmodEffective = true;
		}
		if (!chmodEffective) {
			await chmod(swarmDir, 0o755);
			return; // chmod doesn't work on this platform (macOS SIP/APFS)
		}

		try {
			// When .swarm/ is entirely read-only, savePlan THROWS because
			// plan.json itself cannot be written — not just the marker.
			// (Marker resilience when only the marker file is protected is
			// tested separately in the "pre-existing read-only marker file" test.)
			let threw = false;
			try {
				await savePlan(tempDir, testPlan);
			} catch {
				threw = true;
			}

			expect(threw).toBe(true);
		} finally {
			// Restore permissions for cleanup
			await chmod(swarmDir, 0o755);
		}
	});

	test('5. Plan save succeeds - pre-existing read-only marker file', async () => {
		// Skip on Windows/root — chmod behavior differs or is ignored
		if (process.platform === 'win32' || process.getuid?.() === 0) {
			return;
		}

		const testPlan = createTestPlan();
		const swarmDir = join(tempDir, '.swarm');
		const markerPath = join(swarmDir, '.plan-write-marker');

		// Create .swarm directory
		mkdirSync(swarmDir, { recursive: true });

		// Create marker file as read-only
		await writeFile(markerPath, 'existing');
		await chmod(markerPath, 0o444);

		// Probe: verify chmod actually blocks writes to this file
		let chmodEffective = false;
		try {
			const { writeFileSync } = await import('node:fs');
			writeFileSync(markerPath, 'probe');
		} catch {
			chmodEffective = true;
		}
		if (!chmodEffective) {
			await chmod(markerPath, 0o644);
			return; // chmod doesn't work on this platform
		}

		try {
			// savePlan should NOT throw - it should silently handle the failure
			let threw = false;
			try {
				await savePlan(tempDir, testPlan);
			} catch (e) {
				threw = true;
			}

			expect(threw).toBe(false);

			// Plan files should still be written
			expect(existsSync(join(swarmDir, 'plan.json'))).toBe(true);
			expect(existsSync(join(swarmDir, 'plan.md'))).toBe(true);
		} finally {
			// Restore permissions for cleanup
			await chmod(markerPath, 0o644);
		}
	});

	test('5. Plan save succeeds - marker directory does not exist (will be created)', async () => {
		const testPlan = createTestPlan();

		// Don't create .swarm directory - savePlan should create it
		// and the marker should be written successfully

		await savePlan(tempDir, testPlan);

		const swarmDir = join(tempDir, '.swarm');
		const markerPath = join(swarmDir, '.plan-write-marker');

		// All files should exist
		expect(existsSync(join(swarmDir, 'plan.json'))).toBe(true);
		expect(existsSync(join(swarmDir, 'plan.md'))).toBe(true);
		expect(existsSync(markerPath)).toBe(true);
	});

	/**
	 * Additional boundary tests
	 */
	test('plan with many phases - marker counts correctly', async () => {
		const manyPhases = Array.from({ length: 50 }, (_, i) => ({
			id: i + 1,
			name: `Phase ${i + 1}`,
			status: 'pending' as const,
			tasks: [
				{
					id: `${i + 1}.1`,
					phase: i + 1,
					status: 'pending' as const,
					size: 'small' as const,
					description: `Task in phase ${i + 1}`,
					depends: [] as string[],
					files_touched: [] as string[],
				},
			],
		}));

		const plan = createTestPlan({ phases: manyPhases });
		await savePlan(tempDir, plan);

		const markerPath = join(tempDir, '.swarm', '.plan-write-marker');
		const markerContent = await readFile(markerPath, 'utf-8');
		const marker = JSON.parse(markerContent);

		expect(marker.phases_count).toBe(50);
		expect(marker.tasks_count).toBe(50);
	});
});
