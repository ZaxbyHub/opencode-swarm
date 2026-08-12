/**
 * Tests for drafted-issue-candidate generation in session reflection (FR-006).
 *
 * Exercises gatherDraftedIssueCandidates via _internals DI seam.
 * Qualification is "any taxonomy entries present" — not tool-name matching.
 * The taxonomy uses generic categories (logic_error, timeout) from the
 * evidence schema, which never overlap with tool/gate names.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionReflectionData } from './session-reflection';
import { _internals, runSessionReflection } from './session-reflection';

function emptyToolAggregates() {
	return new Map<
		string,
		{
			tool: string;
			count: number;
			successCount: number;
			failureCount: number;
			totalDuration: number;
		}
	>();
}

function emptyAgentSessions() {
	return new Map<
		string,
		{ agentName: string; lastDelegationReason?: string }
	>();
}

function makeBaseData(): SessionReflectionData {
	return {
		timestamp: new Date().toISOString(),
		totalToolCalls: 10,
		totalToolFailures: 0,
		toolProblems: [],
		agentDispatches: [],
		gateFailures: [],
		lessonsFromRetros: [],
		errorTaxonomy: {},
		lessonsStored: 0,
		knowledgeCreated: 0,
		dedupDropCount: 0,
		drainAdmitted: 0,
		drainReinforced: 0,
		drainRejected: 0,
		skillViolationSignals: [],
		nearDuplicateCandidates: [],
		draftedIssueCandidates: [],
	};
}

/**
 * Helper: write an evidence.json under a task-ID evidence directory.
 */
async function writeEvidence(
	tempDir: string,
	taskId: string,
	entries: Record<string, unknown>[],
): Promise<void> {
	const evidenceDir = path.join(tempDir, '.swarm', 'evidence', taskId);
	await mkdir(evidenceDir, { recursive: true });
	await writeFile(
		path.join(evidenceDir, 'evidence.json'),
		JSON.stringify({ entries }),
	);
}

describe('session-reflection — drafted issue candidates (FR-006)', () => {
	let tempDir: string;
	const originalGather = _internals.gatherDraftedIssueCandidates;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `reflect-issues-${Date.now()}`);
		await mkdir(tempDir, { recursive: true });
	});

	afterEach(() => {
		const { rmSync } = require('node:fs');
		rmSync(tempDir, { recursive: true, force: true });
		_internals.gatherDraftedIssueCandidates = originalGather;
	});

	test('produces draft when taxonomy has generic categories (logic_error, timeout) — even though tool name is "bash"', async () => {
		const data: SessionReflectionData = {
			...makeBaseData(),
			totalToolFailures: 5,
			toolProblems: [
				{
					tool: 'bash',
					failureCount: 5,
					totalCalls: 10,
					failureRate: 0.5,
					avgDurationMs: 500,
				},
			],
			errorTaxonomy: { logic_error: 2, timeout: 1 },
		};
		const candidates = await _internals.gatherDraftedIssueCandidates(
			data,
			tempDir,
		);
		expect(candidates).toHaveLength(1);
		expect(candidates[0].title).toContain('bash');
		expect(candidates[0].errorCategory).toBe('bash');
		expect(candidates[0].body).toContain('logic_error');
		expect(candidates[0].body).toContain('timeout');
		expect(candidates[0].body).toContain('2 error taxonomy entries');
	});

	test('produces NO draft when errorTaxonomy is empty — even with tool failures', async () => {
		const data: SessionReflectionData = {
			...makeBaseData(),
			totalToolFailures: 5,
			toolProblems: [
				{
					tool: 'bash',
					failureCount: 5,
					totalCalls: 10,
					failureRate: 0.5,
					avgDurationMs: 500,
				},
			],
			errorTaxonomy: {},
		};
		expect(
			await _internals.gatherDraftedIssueCandidates(data, tempDir),
		).toHaveLength(0);
	});

	test('zero-count taxonomy entries still qualify (key presence, not positive count)', async () => {
		const data: SessionReflectionData = {
			...makeBaseData(),
			totalToolFailures: 3,
			toolProblems: [
				{
					tool: 'bash',
					failureCount: 3,
					totalCalls: 10,
					failureRate: 0.3,
					avgDurationMs: 500,
				},
			],
			errorTaxonomy: { logic_error: 0, timeout: 0 },
		};
		const candidates = await _internals.gatherDraftedIssueCandidates(
			data,
			tempDir,
		);
		expect(candidates.length).toBeGreaterThan(0);
	});

	test('fail-open: injected throw returns empty array via runSessionReflection', async () => {
		_internals.gatherDraftedIssueCandidates = () => {
			throw new Error('injected gather failure');
		};
		const swarmDir = path.join(tempDir, '.swarm');
		await mkdir(swarmDir, { recursive: true });
		const result = await runSessionReflection({
			directory: tempDir,
			toolAggregates: emptyToolAggregates(),
			agentSessions: emptyAgentSessions(),
			delegate: undefined,
		});
		expect(result.data.draftedIssueCandidates).toEqual([]);
	});

	test('gateFailures with taxonomy entries produce issue drafts (gate name != taxonomy key)', async () => {
		const data: SessionReflectionData = {
			...makeBaseData(),
			gateFailures: [{ gate: 'reviewer', taskId: '1.1', count: 3 }],
			errorTaxonomy: { planning_error: 2, interface_mismatch: 1 },
		};
		const candidates = await _internals.gatherDraftedIssueCandidates(
			data,
			tempDir,
		);
		expect(candidates).toHaveLength(1);
		expect(candidates[0].title).toContain('reviewer');
		expect(candidates[0].body).toContain('task 1.1');
		expect(candidates[0].errorCategory).toBe('reviewer');
		expect(candidates[0].body).toContain('planning_error');
	});

	test('gateFailures without any taxonomy entries produce NO draft', async () => {
		const data: SessionReflectionData = {
			...makeBaseData(),
			gateFailures: [{ gate: 'reviewer', taskId: '1.1', count: 3 }],
			errorTaxonomy: {},
		};
		expect(
			await _internals.gatherDraftedIssueCandidates(data, tempDir),
		).toHaveLength(0);
	});

	test('draft body includes evidence paths when failing-test evidence exists', async () => {
		await writeEvidence(tempDir, '1.5', [
			{
				type: 'test',
				verdict: 'fail',
				test_file: 'src/bash/bash-tool.test.ts',
				tests_failed: 2,
				tests_passed: 0,
				summary: 'bash tool timeout',
			},
		]);

		const data: SessionReflectionData = {
			...makeBaseData(),
			totalToolFailures: 3,
			toolProblems: [
				{
					tool: 'bash',
					failureCount: 3,
					totalCalls: 10,
					failureRate: 0.3,
					avgDurationMs: 500,
				},
			],
			errorTaxonomy: { logic_error: 2, timeout: 1 },
		};
		const candidates = await _internals.gatherDraftedIssueCandidates(
			data,
			tempDir,
		);
		expect(candidates).toHaveLength(1);
		expect(candidates[0].body).toContain('.swarm/evidence/1.5/evidence.json');
		expect(candidates[0].body).toContain('Related evidence:');
	});

	test('draft body omits evidence section when no failing-test evidence exists', async () => {
		const data: SessionReflectionData = {
			...makeBaseData(),
			totalToolFailures: 3,
			toolProblems: [
				{
					tool: 'bash',
					failureCount: 3,
					totalCalls: 10,
					failureRate: 0.3,
					avgDurationMs: 500,
				},
			],
			errorTaxonomy: { logic_error: 1 },
		};
		const candidates = await _internals.gatherDraftedIssueCandidates(
			data,
			tempDir,
		);
		expect(candidates).toHaveLength(1);
		expect(candidates[0].body).not.toContain('Related evidence:');
	});

	test('multiple tool problems + gate failures each produce separate drafts when taxonomy exists', async () => {
		const data: SessionReflectionData = {
			...makeBaseData(),
			totalToolFailures: 8,
			toolProblems: [
				{
					tool: 'bash',
					failureCount: 5,
					totalCalls: 10,
					failureRate: 0.5,
					avgDurationMs: 500,
				},
				{
					tool: 'read',
					failureCount: 3,
					totalCalls: 8,
					failureRate: 0.375,
					avgDurationMs: 200,
				},
			],
			gateFailures: [{ gate: 'reviewer', taskId: '1.1', count: 2 }],
			errorTaxonomy: { logic_error: 3 },
		};
		const candidates = await _internals.gatherDraftedIssueCandidates(
			data,
			tempDir,
		);
		expect(candidates).toHaveLength(3);
		expect(candidates.map((c) => c.errorCategory)).toEqual([
			'bash',
			'read',
			'reviewer',
		]);
	});

	test('empty taxonomy + failing-test evidence produces draft (OR logic: evidence alone qualifies)', async () => {
		await writeEvidence(tempDir, '1.5', [
			{
				type: 'test_engineer',
				verdict: 'fail',
				test_file: 'src/bash/bash-tool.test.ts',
				tests_failed: 3,
				tests_passed: 0,
				summary: 'bash tool timeout under load',
			},
		]);

		const data: SessionReflectionData = {
			...makeBaseData(),
			totalToolFailures: 4,
			toolProblems: [
				{
					tool: 'bash',
					failureCount: 4,
					totalCalls: 10,
					failureRate: 0.4,
					avgDurationMs: 800,
				},
			],
			errorTaxonomy: {},
		};
		const candidates = await _internals.gatherDraftedIssueCandidates(
			data,
			tempDir,
		);
		// Falsifiable: if the evidence-only qualification check were removed,
		// this would return [] because errorTaxonomy is empty.
		expect(candidates).toHaveLength(1);
		expect(candidates[0].title).toContain('bash');
		expect(candidates[0].body).toContain('.swarm/evidence/1.5/evidence.json');
		expect(candidates[0].body).toContain('0 error taxonomy entries');
	});

	test('empty taxonomy + no evidence produces no draft (neither signal qualifies)', async () => {
		const data: SessionReflectionData = {
			...makeBaseData(),
			totalToolFailures: 4,
			toolProblems: [
				{
					tool: 'bash',
					failureCount: 4,
					totalCalls: 10,
					failureRate: 0.4,
					avgDurationMs: 800,
				},
			],
			errorTaxonomy: {},
		};
		const candidates = await _internals.gatherDraftedIssueCandidates(
			data,
			tempDir,
		);
		expect(candidates).toHaveLength(0);
	});

	test('evidence with type test + verdict fail but NO test_file does NOT qualify as evidence path', async () => {
		await writeEvidence(tempDir, '2.1', [
			{
				type: 'test',
				verdict: 'fail',
				tests_failed: 1,
				tests_passed: 0,
				summary: 'something broke',
			},
		]);

		// Verify scanEvidencePaths returns empty (no test_file → skip)
		const evidencePaths = await _internals.scanEvidencePaths(tempDir);
		expect(evidencePaths).toHaveLength(0);

		// Verify gatherDraftedIssueCandidates produces no draft either
		// (no evidence + no taxonomy → neither signal qualifies)
		const data: SessionReflectionData = {
			...makeBaseData(),
			totalToolFailures: 2,
			toolProblems: [
				{
					tool: 'bash',
					failureCount: 2,
					totalCalls: 6,
					failureRate: 1 / 3,
					avgDurationMs: 300,
				},
			],
			errorTaxonomy: {},
		};
		const candidates = await _internals.gatherDraftedIssueCandidates(
			data,
			tempDir,
		);
		expect(candidates).toHaveLength(0);
	});

	test('evidence with type test + verdict fail + blank test_file does NOT qualify as evidence path', async () => {
		await writeEvidence(tempDir, '2.2', [
			{
				type: 'test',
				verdict: 'fail',
				test_file: '   ',
				tests_failed: 1,
				tests_passed: 0,
				summary: 'something broke',
			},
		]);

		const evidencePaths = await _internals.scanEvidencePaths(tempDir);
		expect(evidencePaths).toHaveLength(0);
	});
});

describe('session-reflection — gatherRetroLessonsAndTaxonomy formats', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `reflect-taxonomy-${Date.now()}`);
		await mkdir(tempDir, { recursive: true });
	});

	afterEach(() => {
		const { rmSync } = require('node:fs');
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('handles array format: ["logic_error", "timeout"] counts each string', async () => {
		await writeEvidence(tempDir, 'retro-1', [
			{
				lessons_learned: ['always check paths'],
				error_taxonomy: ['logic_error', 'timeout', 'logic_error'],
			},
		]);

		const { taxonomy } =
			await _internals.gatherRetroLessonsAndTaxonomy(tempDir);
		expect(taxonomy).toEqual({ logic_error: 2, timeout: 1 });
	});

	test('handles object format: { category: count } sums counts', async () => {
		await writeEvidence(tempDir, 'retro-2', [
			{
				lessons_learned: ['use path.join'],
				error_taxonomy: { logic_error: 3, scope_creep: 1 },
			},
		]);

		const { taxonomy } =
			await _internals.gatherRetroLessonsAndTaxonomy(tempDir);
		expect(taxonomy).toEqual({ logic_error: 3, scope_creep: 1 });
	});

	test('handles mixed retro entries: array in one, object in another', async () => {
		await writeEvidence(tempDir, 'retro-1', [
			{
				error_taxonomy: ['logic_error', 'logic_error'],
			},
		]);
		await writeEvidence(tempDir, 'retro-2', [
			{
				error_taxonomy: { logic_error: 1, timeout: 2 },
			},
		]);

		const { taxonomy } =
			await _internals.gatherRetroLessonsAndTaxonomy(tempDir);
		expect(taxonomy).toEqual({ logic_error: 3, timeout: 2 });
	});

	test('ignores non-string elements in array format', async () => {
		await writeEvidence(tempDir, 'retro-1', [
			{
				error_taxonomy: ['logic_error', 42, '', null, 'timeout'],
			},
		]);

		const { taxonomy } =
			await _internals.gatherRetroLessonsAndTaxonomy(tempDir);
		expect(taxonomy).toEqual({ logic_error: 1, timeout: 1 });
	});

	test('returns empty taxonomy when no evidence files exist', async () => {
		const { taxonomy } =
			await _internals.gatherRetroLessonsAndTaxonomy(tempDir);
		expect(taxonomy).toEqual({});
	});

	test('lessons are still extracted alongside taxonomy', async () => {
		await writeEvidence(tempDir, 'retro-1', [
			{
				lessons_learned: ['lesson A', 'lesson B'],
				error_taxonomy: ['logic_error'],
			},
		]);

		const { lessons, taxonomy } =
			await _internals.gatherRetroLessonsAndTaxonomy(tempDir);
		expect(lessons).toEqual(['lesson A', 'lesson B']);
		expect(taxonomy).toEqual({ logic_error: 1 });
	});
});
