/**
 * Behavioral tests for System Enhancer - Evidence Loading & Retrospective Injection
 *
 * Tests cover:
 * - loadEvidence and listEvidenceTaskIds for retrospective bundles
 * - Tier 1 and Tier 2 retrospective injection via buildRetroInjection
 * - Coder retrospective injection (condensed format)
 * - User directives injection from retrospective bundles
 *
 * @note This file consolidates tests from:
 * - system-enhancer-task2-1.test.ts
 * - system-enhancer-task2-2.test.ts
 * - system-enhancer-task2-3.test.ts
 * - system-enhancer-task2-4.test.ts
 * - system-enhancer-task3-4.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import type { EvidenceBundle } from '../../../src/config/evidence-schema';
import {
	listEvidenceTaskIds,
	loadEvidence,
} from '../../../src/evidence/manager';
import { createSystemEnhancerHook } from '../../../src/hooks/system-enhancer';
import { resetSwarmState, swarmState } from '../../../src/state';

import {
	createRetroBundle,
	createSwarmFiles,
	DEFAULT_PLUGIN_CONFIG,
	invokeHook,
	setupTempDir,
} from '../../helpers/system-enhancer-test-helpers';

// =============================================================================
// Shared Fixtures
// =============================================================================

describe('Task 2.1: loadEvidence and listEvidenceTaskIds', () => {
	let tempDir: string;
	let cleanup: () => Promise<void>;

	beforeEach(async () => {
		const result = await setupTempDir('swarm-retro-21-test-');
		tempDir = result.tempDir;
		cleanup = result.cleanup;
	});

	afterEach(async () => {
		await cleanup();
	});

	function getRetrospectiveEntry(bundle: EvidenceBundle) {
		return bundle.entries.find((e) => e.type === 'retrospective');
	}

	describe('loadEvidence', () => {
		it('returns the retro bundle when retro-1/evidence.json exists with valid retrospective entry', async () => {
			await createRetroBundle(
				tempDir,
				1,
				'pass',
				['lesson A', 'lesson B'],
				['reason X'],
				'Phase 1 completed successfully.',
			);

			const result = await loadEvidence(tempDir, 'retro-1');

			expect(result.status).toBe('found');
			expect(result.bundle.task_id).toBe('retro-1');
			expect(result.bundle.entries.length).toBe(1);
			expect(result.bundle.entries[0].type).toBe('retrospective');
		});

		it('returns not_found when the directory does not exist', async () => {
			const result = await loadEvidence(tempDir, 'retro-99');
			expect(result.status).toBe('not_found');
		});

		it('returns bundle for retro with verdict "fail" (when filtered by caller)', async () => {
			await createRetroBundle(tempDir, 2, 'fail', [], [], 'Phase 2 failed.');

			const result = await loadEvidence(tempDir, 'retro-2');

			expect(result.status).toBe('found');
			const entry = getRetrospectiveEntry(result.bundle);
			expect(entry?.verdict).toBe('fail');
		});

		it('loads a retro bundle with phase_number=1, lessons_learned, top_rejection_reasons, verdict=pass correctly', async () => {
			await createRetroBundle(
				tempDir,
				1,
				'pass',
				['lesson A', 'lesson B'],
				['reason X', 'reason Y'],
				'Phase 1 completed.',
			);

			const result = await loadEvidence(tempDir, 'retro-1');

			expect(result.status).toBe('found');
			const entry = getRetrospectiveEntry(result.bundle);
			expect(entry?.type).toBe('retrospective');
			expect((entry as any).phase_number).toBe(1);
			expect((entry as any).lessons_learned).toEqual(['lesson A', 'lesson B']);
			expect((entry as any).top_rejection_reasons).toEqual([
				'reason X',
				'reason Y',
			]);
			expect(entry?.verdict).toBe('pass');
		});

		it('loads a retro bundle with verdict="fail" correctly (data is present)', async () => {
			await createRetroBundle(
				tempDir,
				1,
				'fail',
				['lesson about failure'],
				['reason for failure'],
				'Phase 1 failed.',
			);

			const result = await loadEvidence(tempDir, 'retro-1');

			expect(result.status).toBe('found');
			const entry = getRetrospectiveEntry(result.bundle);
			expect(entry?.verdict).toBe('fail');
			expect((entry as any).lessons_learned).toEqual(['lesson about failure']);
			expect((entry as any).top_rejection_reasons).toEqual([
				'reason for failure',
			]);
		});

		it('returns invalid_schema when evidence.json has invalid schema', async () => {
			const taskDir = join(tempDir, '.swarm', 'evidence', 'retro-1');
			await mkdir(taskDir, { recursive: true });
			const bundlePath = join(taskDir, 'evidence.json');
			await writeFile(bundlePath, '{ invalid json }');

			const result = await loadEvidence(tempDir, 'retro-1');
			expect(result.status).toBe('invalid_schema');
		});
	});

	describe('listEvidenceTaskIds', () => {
		it("returns 'retro-1' when only retro-1 bundle exists", async () => {
			await createRetroBundle(tempDir, 1, 'pass');

			const taskIds = await listEvidenceTaskIds(tempDir);

			expect(taskIds).toEqual(['retro-1']);
		});

		it('returns sorted array of multiple retro task IDs', async () => {
			await createRetroBundle(tempDir, 1, 'pass');
			await createRetroBundle(tempDir, 3, 'pass');
			await createRetroBundle(tempDir, 2, 'pass');

			const taskIds = await listEvidenceTaskIds(tempDir);

			expect(taskIds).toEqual(['retro-1', 'retro-2', 'retro-3']);
		});

		it('returns empty array when no evidence bundles exist', async () => {
			await mkdir(join(tempDir, '.swarm', 'evidence'), { recursive: true });

			const taskIds = await listEvidenceTaskIds(tempDir);

			expect(taskIds).toEqual([]);
		});

		it('returns empty array when evidence directory does not exist', async () => {
			const taskIds = await listEvidenceTaskIds(tempDir);
			expect(taskIds).toEqual([]);
		});
	});

	describe('Integration: retro bundle structure', () => {
		it('creates a valid evidence bundle with all required RetrospectiveEvidence fields', async () => {
			await createRetroBundle(
				tempDir,
				1,
				'pass',
				['lesson A', 'lesson B'],
				['reason X'],
				'Phase completed.',
			);

			const result = await loadEvidence(tempDir, 'retro-1');
			expect(result.status).toBe('found');

			const entry = getRetrospectiveEntry(result.bundle);
			expect(entry?.type).toBe('retrospective');
			expect(entry?.task_id).toBe('retro-1');
			expect(entry?.agent).toBe('architect');
			expect(entry?.timestamp).toBeDefined();
			expect(entry?.summary).toBe('Phase completed.');

			const retroEntry = entry as any;
			expect(retroEntry.phase_number).toBe(1);
			expect(retroEntry.total_tool_calls).toBe(42);
			expect(retroEntry.coder_revisions).toBe(2);
			expect(retroEntry.reviewer_rejections).toBe(1);
			expect(retroEntry.test_failures).toBe(0);
			expect(retroEntry.security_findings).toBe(0);
			expect(retroEntry.integration_issues).toBe(0);
			expect(retroEntry.task_count).toBe(5);
			expect(retroEntry.task_complexity).toBe('moderate');
		});

		it('creates multiple entries in a single bundle', async () => {
			const taskDir = join(tempDir, '.swarm', 'evidence', 'retro-1');
			await mkdir(taskDir, { recursive: true });

			const bundle: EvidenceBundle = {
				schema_version: '1.0.0',
				task_id: 'retro-1',
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				entries: [
					{
						type: 'retrospective',
						task_id: 'retro-1',
						timestamp: new Date().toISOString(),
						agent: 'architect',
						verdict: 'pass',
						summary: 'Phase completed.',
						phase_number: 1,
						total_tool_calls: 42,
						coder_revisions: 2,
						reviewer_rejections: 0,
						test_failures: 0,
						security_findings: 0,
						integration_issues: 0,
						task_count: 5,
						task_complexity: 'moderate',
						top_rejection_reasons: [],
						lessons_learned: ['lesson A'],
					},
					{
						type: 'note',
						task_id: 'retro-1',
						timestamp: new Date().toISOString(),
						agent: 'architect',
						verdict: 'info',
						summary: 'Additional note',
					},
				],
			};

			await writeFile(
				join(taskDir, 'evidence.json'),
				JSON.stringify(bundle, null, 2),
			);

			const result = await loadEvidence(tempDir, 'retro-1');
			expect(result.status).toBe('found');
			expect(result.bundle.entries.length).toBe(2);
			expect(result.bundle.entries[0].type).toBe('retrospective');
			expect(result.bundle.entries[1].type).toBe('note');
		});
	});
});

// =============================================================================
// Task 2.2: Retrospective Deduplication and Edge Cases
// =============================================================================

describe('Task 2.2: Retrospective Deduplication', () => {
	let tempDir: string;
	let cleanup: () => Promise<void>;

	beforeEach(async () => {
		const result = await setupTempDir('swarm-retro-22-test-');
		tempDir = result.tempDir;
		cleanup = result.cleanup;
	});

	afterEach(async () => {
		await cleanup();
	});

	it('A retro bundle with no entries returns found status from loadEvidence', async () => {
		const taskDir = join(tempDir, '.swarm', 'evidence', 'retro-1');
		await mkdir(taskDir, { recursive: true });

		const bundle: EvidenceBundle = {
			schema_version: '1.0.0',
			task_id: 'retro-1',
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			entries: [],
		};

		await writeFile(
			join(taskDir, 'evidence.json'),
			JSON.stringify(bundle, null, 2),
		);

		const result = await loadEvidence(tempDir, 'retro-1');

		expect(result.status).toBe('found');
		expect(result.bundle.entries).toEqual([]);
	});

	it('A retro bundle with verdict pass but empty lessons_learned still produces valid evidence', async () => {
		await createRetroBundle(
			tempDir,
			3,
			'pass',
			[],
			['reason X'],
			'Phase 3 completed.',
		);

		const result = await loadEvidence(tempDir, 'retro-3');

		expect(result.status).toBe('found');
		expect(result.bundle.task_id).toBe('retro-3');
		const retroEntry = result.bundle.entries.find(
			(e): e is any => e.type === 'retrospective',
		);
		expect(retroEntry).toBeDefined();
		expect(retroEntry.verdict).toBe('pass');
		expect(retroEntry.lessons_learned).toEqual([]);
	});

	it('A retro bundle with phase_number=5 can be loaded when direct lookup for phase 4 fails', async () => {
		await createRetroBundle(
			tempDir,
			5,
			'pass',
			['lesson from phase 5'],
			['reason Y'],
			'Phase 5 completed.',
		);

		const result = await loadEvidence(tempDir, 'retro-5');
		expect(result.status).toBe('found');
		expect(result.bundle.task_id).toBe('retro-5');

		const retroEntry = result.bundle.entries.find(
			(e): e is any => e.type === 'retrospective',
		);
		expect(retroEntry).toBeDefined();
		expect(retroEntry.phase_number).toBe(5);

		const bundle4 = await loadEvidence(tempDir, 'retro-4');
		expect(bundle4.status).toBe('not_found');

		const allTaskIds = await listEvidenceTaskIds(tempDir);
		expect(allTaskIds).toContain('retro-5');
		expect(allTaskIds).not.toContain('retro-4');
	});
});

// =============================================================================
// Task 2.3: Tier 2 Historical Lessons (buildRetroInjection for Phase 1)
// =============================================================================

describe('Task 2.3: Tier 2 Historical Lessons', () => {
	let tempDir: string;
	let cleanup: () => Promise<void>;

	beforeEach(async () => {
		const result = await setupTempDir('swarm-retro-23-test-');
		tempDir = result.tempDir;
		cleanup = result.cleanup;
		resetSwarmState();
	});

	afterEach(async () => {
		await cleanup();
	});

	describe('Tier 2: Phase 1 Historical Lessons', () => {
		it('Phase 1 with recent retros (< 30 days old) → injects "## Historical Lessons" block', async () => {
			await createSwarmFiles(tempDir, 1);

			const recentDate = new Date(
				Date.now() - 1 * 24 * 60 * 60 * 1000,
			).toISOString();
			await createRetroBundle(
				tempDir,
				8,
				'pass',
				['Lesson from phase 8'],
				[],
				'Phase 8 completed.',
				{ timestamp: recentDate },
			);
			await createRetroBundle(
				tempDir,
				7,
				'pass',
				['Lesson from phase 7'],
				[],
				'Phase 7 completed.',
				{ timestamp: recentDate },
			);

			const systemOutput = await invokeHook(DEFAULT_PLUGIN_CONFIG, tempDir);

			const historicalLessons = systemOutput.find((s) =>
				s.includes('## Historical Lessons'),
			);
			expect(historicalLessons).toBeDefined();
			expect(historicalLessons).toContain(
				'Most recent retrospectives in this workspace:',
			);
			expect(historicalLessons).toContain('Phase 8');
			expect(historicalLessons).toContain('Phase 7');
			expect(historicalLessons).toContain('Key lesson:');
		});

		it('Phase 1 with ALL retros older than 30 days → returns null (no injection)', async () => {
			await createSwarmFiles(tempDir, 1);

			const oldDate = new Date(
				Date.now() - 45 * 24 * 60 * 60 * 1000,
			).toISOString();
			await createRetroBundle(
				tempDir,
				8,
				'pass',
				['Old lesson'],
				[],
				'Phase 8 completed.',
				{ timestamp: oldDate },
			);
			await createRetroBundle(
				tempDir,
				7,
				'pass',
				['Older lesson'],
				[],
				'Phase 7 completed.',
				{ timestamp: oldDate },
			);

			const systemOutput = await invokeHook(DEFAULT_PLUGIN_CONFIG, tempDir);

			const historicalLessons = systemOutput.find((s) =>
				s.includes('## Historical Lessons'),
			);
			expect(historicalLessons).toBeUndefined();

			const anyRetro = systemOutput.find(
				(s) => s.includes('Retrospective') || s.includes('retrospective'),
			);
			expect(anyRetro).toBeUndefined();
		});

		it('Phase 1 with no retro bundles at all → returns null', async () => {
			await createSwarmFiles(tempDir, 1);
			await mkdir(join(tempDir, '.swarm', 'evidence'), { recursive: true });

			const systemOutput = await invokeHook(DEFAULT_PLUGIN_CONFIG, tempDir);

			const historicalLessons = systemOutput.find((s) =>
				s.includes('## Historical Lessons'),
			);
			expect(historicalLessons).toBeUndefined();
		});

		it('Phase 1 with 5 retros in evidence → only top-3 most recent appear in output', async () => {
			await createSwarmFiles(tempDir, 1);

			const baseDate = Date.now();
			for (let i = 1; i <= 5; i++) {
				const daysAgo = i * 2;
				const timestamp = new Date(
					baseDate - daysAgo * 24 * 60 * 60 * 1000,
				).toISOString();
				await createRetroBundle(
					tempDir,
					10 + i,
					'pass',
					[`Lesson from phase ${10 + i}`],
					[],
					`Phase ${10 + i} completed.`,
					{ timestamp },
				);
			}

			const systemOutput = await invokeHook(DEFAULT_PLUGIN_CONFIG, tempDir);

			const historicalLessons = systemOutput.find((s) =>
				s.includes('## Historical Lessons'),
			);
			expect(historicalLessons).toBeDefined();

			expect(historicalLessons).toContain('Phase 11');
			expect(historicalLessons).toContain('Phase 12');
			expect(historicalLessons).toContain('Phase 13');

			expect(historicalLessons).not.toContain('Phase 14');
			expect(historicalLessons).not.toContain('Phase 15');
		});

		it('Phase 1 with retro entries — date shown correctly from entry.timestamp', async () => {
			await createSwarmFiles(tempDir, 1);

			const recentDate = new Date(
				Date.now() - 1 * 24 * 60 * 60 * 1000,
			).toISOString();
			const taskDir = join(tempDir, '.swarm', 'evidence', 'retro-8');
			await mkdir(taskDir, { recursive: true });

			const bundle = {
				schema_version: '1.0.0',
				task_id: 'retro-8',
				created_at: new Date(
					Date.now() - 2 * 24 * 60 * 60 * 1000,
				).toISOString(),
				updated_at: new Date().toISOString(),
				entries: [
					{
						type: 'retrospective',
						task_id: 'retro-8',
						timestamp: recentDate,
						agent: 'architect',
						verdict: 'pass',
						summary: 'Phase 8 completed.',
						phase_number: 8,
						total_tool_calls: 42,
						coder_revisions: 2,
						reviewer_rejections: 0,
						test_failures: 0,
						security_findings: 0,
						integration_issues: 0,
						task_count: 5,
						task_complexity: 'moderate',
						top_rejection_reasons: [],
						lessons_learned: ['Lesson from phase 8'],
					},
				],
			};

			await writeFile(
				join(taskDir, 'evidence.json'),
				JSON.stringify(bundle, null, 2),
			);

			const systemOutput = await invokeHook(DEFAULT_PLUGIN_CONFIG, tempDir);

			const historicalLessons = systemOutput.find((s) =>
				s.includes('## Historical Lessons'),
			);
			expect(historicalLessons).toBeDefined();

			const expectedDate = recentDate.split('T')[0];
			expect(historicalLessons).toContain(expectedDate);
		});

		it('Phase 1 with verdict: "fail" retros → skipped (not included)', async () => {
			await createSwarmFiles(tempDir, 1);

			const recentDate = new Date(
				Date.now() - 1 * 24 * 60 * 60 * 1000,
			).toISOString();
			await createRetroBundle(
				tempDir,
				8,
				'pass',
				['Pass lesson'],
				[],
				'Phase 8 completed.',
				{ timestamp: recentDate },
			);
			await createRetroBundle(
				tempDir,
				7,
				'fail',
				['Fail lesson'],
				['Failure reason'],
				'Phase 7 failed.',
				{ timestamp: recentDate },
			);
			await createRetroBundle(
				tempDir,
				6,
				'pass',
				['Another pass lesson'],
				[],
				'Phase 6 completed.',
				{ timestamp: recentDate },
			);

			const systemOutput = await invokeHook(DEFAULT_PLUGIN_CONFIG, tempDir);

			const historicalLessons = systemOutput.find((s) =>
				s.includes('## Historical Lessons'),
			);
			expect(historicalLessons).toBeDefined();

			expect(historicalLessons).toContain('Phase 8');
			expect(historicalLessons).toContain('Phase 6');

			expect(historicalLessons).not.toContain('Phase 7');
		});

		it('Phase 2 → injects "## Previous Phase Retrospective (Phase 1)" Tier 1 block (not Tier 2)', async () => {
			const swarmDir = join(tempDir, '.swarm');
			await mkdir(swarmDir, { recursive: true });
			await writeFile(join(swarmDir, 'plan.md'), '# Plan\n');
			await writeFile(join(swarmDir, 'context.md'), '# Context\n');

			const plan = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 2,
				phases: [
					{ id: 1, name: 'Phase 1', status: 'complete', tasks: [] },
					{ id: 2, name: 'Phase 2', status: 'in_progress', tasks: [] },
				],
			};
			await writeFile(
				join(swarmDir, 'plan.json'),
				JSON.stringify(plan, null, 2),
			);

			const recentDate = new Date(
				Date.now() - 1 * 24 * 60 * 60 * 1000,
			).toISOString();
			await createRetroBundle(
				tempDir,
				1,
				'pass',
				['Lesson from phase 1'],
				['Issue found'],
				'Phase 1 completed.',
				{ timestamp: recentDate },
			);

			const systemOutput = await invokeHook(DEFAULT_PLUGIN_CONFIG, tempDir);

			const retroOutput = systemOutput.find((s) => s.includes('Retrospective'));

			expect(retroOutput).toBeDefined();
			expect(retroOutput).toContain(
				'## Previous Phase Retrospective (Phase 1)',
			);
			expect(retroOutput).toContain('Outcome:');
			expect(retroOutput).toContain('Rejection reasons:');
			expect(retroOutput).toContain('Lessons learned:');

			expect(retroOutput).not.toContain('## Historical Lessons');
		});

		it('Output from top-3 retros with combined length > 800 chars → truncated with "..."', async () => {
			await createSwarmFiles(tempDir, 1);

			const recentDate = new Date(
				Date.now() - 1 * 24 * 60 * 60 * 1000,
			).toISOString();
			const longLesson =
				'This is a very long lesson that adds lots of characters to make the output exceed the 800 character limit and ensure truncation works correctly. '.repeat(
					10,
				);

			await createRetroBundle(
				tempDir,
				10,
				'pass',
				[longLesson],
				[],
				'Phase 10 completed.',
				{
					timestamp: recentDate,
				},
			);
			await createRetroBundle(
				tempDir,
				9,
				'pass',
				[longLesson],
				[],
				'Phase 9 completed.',
				{
					timestamp: recentDate,
				},
			);
			await createRetroBundle(
				tempDir,
				8,
				'pass',
				[longLesson],
				[],
				'Phase 8 completed.',
				{
					timestamp: recentDate,
				},
			);

			const systemOutput = await invokeHook(DEFAULT_PLUGIN_CONFIG, tempDir);

			const historicalLessons = systemOutput.find((s) =>
				s.includes('## Historical Lessons'),
			);
			expect(historicalLessons).toBeDefined();

			expect(historicalLessons!.length).toBeLessThanOrEqual(803);
			expect(historicalLessons!.endsWith('...')).toBe(true);
		});

		it('Phase 1 with single recent retro → shows one entry correctly', async () => {
			await createSwarmFiles(tempDir, 1);

			const recentDate = new Date(
				Date.now() - 1 * 24 * 60 * 60 * 1000,
			).toISOString();
			await createRetroBundle(
				tempDir,
				5,
				'pass',
				['Key lesson learned'],
				['Minor issue'],
				'Phase 5 completed successfully.',
				{ timestamp: recentDate },
			);

			const systemOutput = await invokeHook(DEFAULT_PLUGIN_CONFIG, tempDir);

			const historicalLessons = systemOutput.find((s) =>
				s.includes('## Historical Lessons'),
			);
			expect(historicalLessons).toBeDefined();

			expect(historicalLessons).toContain(
				'## Historical Lessons (from recent prior projects)',
			);
			expect(historicalLessons).toContain(
				'Most recent retrospectives in this workspace:',
			);
			expect(historicalLessons).toContain('- Phase 5');
			expect(historicalLessons).toContain('Phase 5 completed successfully.');
			expect(historicalLessons).toContain('Key lesson: Key lesson learned');
		});

		it('Phase 1 with retro exactly 29 days old → included (age < cutoff)', async () => {
			await createSwarmFiles(tempDir, 1);

			const includedDate = new Date(
				Date.now() - 29 * 24 * 60 * 60 * 1000,
			).toISOString();
			await createRetroBundle(
				tempDir,
				8,
				'pass',
				['Included lesson'],
				[],
				'Phase 8 completed.',
				{ timestamp: includedDate },
			);

			const systemOutput = await invokeHook(DEFAULT_PLUGIN_CONFIG, tempDir);

			const historicalLessons = systemOutput.find((s) =>
				s.includes('## Historical Lessons'),
			);
			expect(historicalLessons).toBeDefined();
			expect(historicalLessons).toContain('Phase 8');
		});

		it('Phase 1 with multiple retros sorted by timestamp (most recent first)', async () => {
			await createSwarmFiles(tempDir, 1);

			const baseDate = Date.now();
			const date1 = new Date(baseDate - 5 * 24 * 60 * 60 * 1000).toISOString();
			const date2 = new Date(baseDate - 1 * 24 * 60 * 60 * 1000).toISOString();
			const date3 = new Date(baseDate - 3 * 24 * 60 * 60 * 1000).toISOString();

			await createRetroBundle(
				tempDir,
				10,
				'pass',
				['Lesson 10'],
				[],
				'Phase 10.',
				{
					timestamp: date1,
				},
			);
			await createRetroBundle(
				tempDir,
				11,
				'pass',
				['Lesson 11'],
				[],
				'Phase 11.',
				{
					timestamp: date2,
				},
			);
			await createRetroBundle(
				tempDir,
				12,
				'pass',
				['Lesson 12'],
				[],
				'Phase 12.',
				{
					timestamp: date3,
				},
			);

			const systemOutput = await invokeHook(DEFAULT_PLUGIN_CONFIG, tempDir);

			const historicalLessons = systemOutput.find((s) =>
				s.includes('## Historical Lessons'),
			);
			expect(historicalLessons).toBeDefined();

			const phase11Index = historicalLessons!.indexOf('Phase 11');
			const phase12Index = historicalLessons!.indexOf('Phase 12');
			const phase10Index = historicalLessons!.indexOf('Phase 10');

			expect(phase11Index).toBeLessThan(phase12Index);
			expect(phase12Index).toBeLessThan(phase10Index);
		});

		it('Phase 1 with mixed verdicts (pass, fail, info) → only pass and info included', async () => {
			await createSwarmFiles(tempDir, 1);

			const recentDate = new Date(
				Date.now() - 1 * 24 * 60 * 60 * 1000,
			).toISOString();
			await createRetroBundle(
				tempDir,
				8,
				'pass',
				['Pass lesson'],
				[],
				'Phase 8 pass.',
				{
					timestamp: recentDate,
				},
			);
			await createRetroBundle(
				tempDir,
				7,
				'fail',
				['Fail lesson'],
				['Fail reason'],
				'Phase 7 fail.',
				{ timestamp: recentDate },
			);
			await createRetroBundle(
				tempDir,
				6,
				'info',
				['Info lesson'],
				[],
				'Phase 6 info.',
				{
					timestamp: recentDate,
				},
			);

			const systemOutput = await invokeHook(DEFAULT_PLUGIN_CONFIG, tempDir);

			const historicalLessons = systemOutput.find((s) =>
				s.includes('## Historical Lessons'),
			);
			expect(historicalLessons).toBeDefined();

			expect(historicalLessons).toContain('Phase 8');
			expect(historicalLessons).toContain('Phase 6');

			expect(historicalLessons).not.toContain('Phase 7');
		});
	});
});

// =============================================================================
// Task 2.4: Coder Retrospective Injection
// =============================================================================

describe('Task 2.4: Coder Retrospective Injection', () => {
	let tempDir: string;
	let cleanup: () => Promise<void>;

	beforeEach(async () => {
		const result = await setupTempDir('swarm-retro-24-test-');
		tempDir = result.tempDir;
		cleanup = result.cleanup;
		resetSwarmState();
	});

	afterEach(async () => {
		await cleanup();
	});

	describe('VERIFICATION TESTS', () => {
		it('Phase 2, agent=mega_coder, retro-1 exists with lessons → system message contains "[SWARM RETROSPECTIVE] From Phase 1:"', async () => {
			await createSwarmFiles(tempDir, 2);
			await createRetroBundle(
				tempDir,
				1,
				'pass',
				['lesson A', 'lesson B'],
				['reason X'],
				'Phase 1 completed successfully.',
			);

			const systemOutput = await invokeHook(
				DEFAULT_PLUGIN_CONFIG,
				tempDir,
				'test-session',
				'mega_coder',
			);

			const coderRetro = systemOutput.find((s) =>
				s.includes('[SWARM RETROSPECTIVE] From Phase 1:'),
			);
			expect(coderRetro).toBeDefined();
			expect(coderRetro).toContain('Phase 1 completed successfully.');
			expect(coderRetro).toContain('lesson A');
			expect(coderRetro).toContain('lesson B');

			const fullRetro = systemOutput.find((s) =>
				s.includes('## Previous Phase Retrospective'),
			);
			expect(fullRetro).toBeUndefined();
		});

		it('Phase 1, agent=mega_coder, retro-0 does not exist → no SWARM RETROSPECTIVE injection', async () => {
			const swarmDir = join(tempDir, '.swarm');
			await mkdir(swarmDir, { recursive: true });
			await writeFile(join(swarmDir, 'plan.md'), '# Plan\n');
			await writeFile(join(swarmDir, 'context.md'), '# Context\n');

			const plan = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
			};
			await writeFile(
				join(swarmDir, 'plan.json'),
				JSON.stringify(plan, null, 2),
			);

			const systemOutput = await invokeHook(
				DEFAULT_PLUGIN_CONFIG,
				tempDir,
				'test-session',
				'mega_coder',
			);

			const anyRetro = systemOutput.find((s) =>
				s.includes('[SWARM RETROSPECTIVE]'),
			);
			expect(anyRetro).toBeUndefined();
		});

		it('Phase 2, agent=mega_coder, retro-1 verdict=fail → no SWARM RETROSPECTIVE injection', async () => {
			await createSwarmFiles(tempDir, 2);
			await createRetroBundle(
				tempDir,
				1,
				'fail',
				['lesson about failure'],
				['reason for failure'],
				'Phase 1 failed.',
			);

			const systemOutput = await invokeHook(
				DEFAULT_PLUGIN_CONFIG,
				tempDir,
				'test-session',
				'mega_coder',
			);

			const coderRetro = systemOutput.find((s) =>
				s.includes('[SWARM RETROSPECTIVE]'),
			);
			expect(coderRetro).toBeUndefined();
		});

		it('Phase 2, agent=mega_architect → system message contains "## Previous Phase Retrospective" (full block), NOT "[SWARM RETROSPECTIVE]"', async () => {
			await createSwarmFiles(tempDir, 2);
			await createRetroBundle(
				tempDir,
				1,
				'pass',
				['lesson A', 'lesson B'],
				['reason X'],
				'Phase 1 completed successfully.',
			);

			const systemOutput = await invokeHook(
				DEFAULT_PLUGIN_CONFIG,
				tempDir,
				'test-session',
				'mega_architect',
			);

			const fullRetro = systemOutput.find((s) =>
				s.includes('## Previous Phase Retrospective'),
			);
			expect(fullRetro).toBeDefined();
			expect(fullRetro).toContain('Outcome:');
			expect(fullRetro).toContain('Rejection reasons:');
			expect(fullRetro).toContain('Lessons learned:');

			const coderRetro = systemOutput.find((s) =>
				s.includes('[SWARM RETROSPECTIVE]'),
			);
			expect(coderRetro).toBeUndefined();
		});

		it('Phase 2, agent=mega_coder, long lessons_learned → coder injection is capped at ≤ 400 chars', async () => {
			await createSwarmFiles(tempDir, 2);

			const longLesson =
				'This is a very long lesson that adds lots of characters. '.repeat(20);
			await createRetroBundle(
				tempDir,
				1,
				'pass',
				[
					longLesson,
					'Another long lesson that extends beyond limit. '.repeat(20),
				],
				[],
				'Phase 1 completed successfully.',
			);

			const systemOutput = await invokeHook(
				DEFAULT_PLUGIN_CONFIG,
				tempDir,
				'test-session',
				'mega_coder',
			);

			const coderRetro = systemOutput.find((s) =>
				s.includes('[SWARM RETROSPECTIVE] From Phase 1:'),
			);
			expect(coderRetro).toBeDefined();
			expect(coderRetro!.length).toBeLessThanOrEqual(400);
			expect(coderRetro!.endsWith('...')).toBe(true);
		});

		it('Phase 2, agent=mega_coder, retro-1 has summary → header includes summary text', async () => {
			await createSwarmFiles(tempDir, 2);
			await createRetroBundle(
				tempDir,
				1,
				'pass',
				['lesson A'],
				[],
				'Phase 1 completed with great success and important insights.',
			);

			const systemOutput = await invokeHook(
				DEFAULT_PLUGIN_CONFIG,
				tempDir,
				'test-session',
				'mega_coder',
			);

			const coderRetro = systemOutput.find((s) =>
				s.includes('[SWARM RETROSPECTIVE] From Phase 1:'),
			);
			expect(coderRetro).toBeDefined();
			expect(coderRetro).toContain(
				'Phase 1 completed with great success and important insights.',
			);
			expect(coderRetro).toContain('lesson A');
		});

		it('Phase 2, agent=mega_coder, retro-1 has multiple lessons → all lessons appear (or are truncated within cap)', async () => {
			await createSwarmFiles(tempDir, 2);
			await createRetroBundle(
				tempDir,
				1,
				'pass',
				['lesson one', 'lesson two', 'lesson three', 'lesson four'],
				[],
				'Phase 1 completed.',
			);

			const systemOutput = await invokeHook(
				DEFAULT_PLUGIN_CONFIG,
				tempDir,
				'test-session',
				'mega_coder',
			);

			const coderRetro = systemOutput.find((s) =>
				s.includes('[SWARM RETROSPECTIVE] From Phase 1:'),
			);
			expect(coderRetro).toBeDefined();
			expect(coderRetro).toContain('lesson one');
			expect(coderRetro).toContain('lesson two');
			expect(coderRetro).toContain('lesson three');
			expect(coderRetro).toContain('lesson four');
		});
	});
});

// =============================================================================
// Task 3.4: User Directives Injection
// =============================================================================

describe('Task 3.4: User Directives Injection', () => {
	let tempDir: string;
	let cleanup: () => Promise<void>;

	beforeEach(async () => {
		const result = await setupTempDir('swarm-user-dir-test-');
		tempDir = result.tempDir;
		cleanup = result.cleanup;
		resetSwarmState();
	});

	afterEach(async () => {
		await cleanup();
	});

	async function createRetroBundleWithDirectives(
		phase: number,
		verdict: 'pass' | 'fail' = 'pass',
		userDirectives?: Array<{
			directive: string;
			category: 'tooling' | 'code_style' | 'architecture' | 'process' | 'other';
			scope: 'session' | 'project' | 'global';
		}>,
	): Promise<void> {
		const retroDir = join(tempDir, '.swarm', 'evidence', `retro-${phase}`);
		await mkdir(retroDir, { recursive: true });

		const timestamp = new Date().toISOString();
		const bundle = {
			schema_version: '1.0.0',
			task_id: `retro-${phase}`,
			entries: [
				{
					type: 'retrospective',
					task_id: `retro-${phase}`,
					timestamp,
					agent: 'architect',
					verdict,
					summary: `Phase ${phase} completed successfully`,
					metadata: {},
					phase_number: phase,
					total_tool_calls: 100,
					coder_revisions: 2,
					reviewer_rejections: 1,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 5,
					task_complexity: 'moderate',
					top_rejection_reasons: ['Config schema approach not aligned'],
					lessons_learned: [
						'Tree-sitter integration requires WASM grammar files',
					],
					user_directives: userDirectives ?? [],
				},
			],
			created_at: timestamp,
			updated_at: timestamp,
		};
		await writeFile(join(retroDir, 'evidence.json'), JSON.stringify(bundle));
	}

	describe('VERIFICATION TESTS', () => {
		it('Returns "## User Directives" block when Tier 1 retro has project-scope directives', async () => {
			await createRetroBundleWithDirectives(1, 'pass', [
				{
					directive: 'Use TypeScript strict mode',
					category: 'code_style',
					scope: 'project',
				},
			]);
			await createSwarmFiles(tempDir, 2);

			const result = await invokeHook(DEFAULT_PLUGIN_CONFIG, tempDir);

			const retroBlock = result.find((s) =>
				s.includes('## Previous Phase Retrospective'),
			);
			expect(retroBlock).toBeDefined();
			expect(retroBlock).toContain('## User Directives (from Phase 1)');
			expect(retroBlock).toContain('- [code_style] Use TypeScript strict mode');
		});

		it('Returns "## User Directives" block when Tier 1 retro has global-scope directives', async () => {
			await createRetroBundleWithDirectives(1, 'pass', [
				{
					directive: 'Always run security review before deployment',
					category: 'process',
					scope: 'global',
				},
			]);
			await createSwarmFiles(tempDir, 2);

			const result = await invokeHook(DEFAULT_PLUGIN_CONFIG, tempDir);

			const retroBlock = result.find((s) =>
				s.includes('## Previous Phase Retrospective'),
			);
			expect(retroBlock).toBeDefined();
			expect(retroBlock).toContain('## User Directives (from Phase 1)');
			expect(retroBlock).toContain(
				'- [process] Always run security review before deployment',
			);
		});

		it('Does NOT include "## User Directives" when all directives are session-scope', async () => {
			await createRetroBundleWithDirectives(1, 'pass', [
				{
					directive: 'Use verbose logging for this session',
					category: 'tooling',
					scope: 'session',
				},
			]);
			await createSwarmFiles(tempDir, 2);

			const result = await invokeHook(DEFAULT_PLUGIN_CONFIG, tempDir);

			const retroBlock = result.find((s) =>
				s.includes('## Previous Phase Retrospective'),
			);
			expect(retroBlock).toBeDefined();
			expect(retroBlock).not.toContain('## User Directives');
		});

		it('Does NOT include "## User Directives" when user_directives is absent (backward compat)', async () => {
			const retroDir = join(tempDir, '.swarm', 'evidence', 'retro-1');
			await mkdir(retroDir, { recursive: true });

			const timestamp = new Date().toISOString();
			const bundle = {
				schema_version: '1.0.0',
				task_id: 'retro-1',
				entries: [
					{
						type: 'retrospective',
						task_id: 'retro-1',
						timestamp,
						agent: 'architect',
						verdict: 'pass',
						summary: 'Phase 1 completed successfully',
						metadata: {},
						phase_number: 1,
						total_tool_calls: 100,
						coder_revisions: 2,
						reviewer_rejections: 1,
						test_failures: 0,
						security_findings: 0,
						integration_issues: 0,
						task_count: 5,
						task_complexity: 'moderate',
						top_rejection_reasons: ['Config schema approach not aligned'],
						lessons_learned: [
							'Tree-sitter integration requires WASM grammar files',
						],
						// NOTE: user_directives field is omitted
					},
				],
				created_at: timestamp,
				updated_at: timestamp,
			};
			await writeFile(join(retroDir, 'evidence.json'), JSON.stringify(bundle));
			await createSwarmFiles(tempDir, 2);

			const result = await invokeHook(DEFAULT_PLUGIN_CONFIG, tempDir);

			const retroBlock = result.find((s) =>
				s.includes('## Previous Phase Retrospective'),
			);
			expect(retroBlock).toBeDefined();
			expect(retroBlock).not.toContain('## User Directives');
		});

		it('Caps output at 5 directives when more than 5 non-session directives exist', async () => {
			const manyDirectives = Array.from({ length: 10 }, (_, i) => ({
				directive: `Directive ${i + 1}`,
				category: 'other' as const,
				scope: 'project' as const,
			}));

			await createRetroBundleWithDirectives(1, 'pass', manyDirectives);
			await createSwarmFiles(tempDir, 2);

			const result = await invokeHook(DEFAULT_PLUGIN_CONFIG, tempDir);

			const retroBlock = result.find((s) =>
				s.includes('## Previous Phase Retrospective'),
			);
			expect(retroBlock).toBeDefined();
			expect(retroBlock).toContain('## User Directives (from Phase 1)');

			const directiveLines = retroBlock?.match(/- \[other\] Directive \d+/g);
			expect(directiveLines).toBeDefined();
			expect(directiveLines!.length).toBe(5);

			expect(retroBlock).toContain('Directive 1');
			expect(retroBlock).toContain('Directive 5');
			expect(retroBlock).not.toContain('Directive 6');
			expect(retroBlock).not.toContain('Directive 10');
		});

		it('Tier 2 includes "User directives carried forward:" when non-session directives exist in historical retros', async () => {
			await createRetroBundleWithDirectives(3, 'pass', [
				{
					directive: 'Use ES modules',
					category: 'code_style',
					scope: 'project',
				},
			]);
			await createRetroBundleWithDirectives(4, 'pass', [
				{ directive: 'Write unit tests', category: 'process', scope: 'global' },
			]);
			await createSwarmFiles(tempDir, 1);

			const result = await invokeHook(DEFAULT_PLUGIN_CONFIG, tempDir);

			const historicalBlock = result.find((s) =>
				s.includes('## Historical Lessons'),
			);
			expect(historicalBlock).toBeDefined();
			expect(historicalBlock).toContain('User directives carried forward:');
			expect(historicalBlock).toContain('- [code_style] Use ES modules');
			expect(historicalBlock).toContain('- [process] Write unit tests');
		});
	});
});
