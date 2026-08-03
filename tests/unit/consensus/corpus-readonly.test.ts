/**
 * The corpus is READ-ONLY, and the balanced cut has documented limits.
 *
 * Split out of `corpus-sources.test.ts` for the 500-line cap. Two concerns live
 * here, both of which are about what mining does NOT do:
 *
 * 1. Mining must not mutate the evidence it counts. `loadEvidence` upgrades a
 *    legacy flat retrospective in place by default — rewriting the bundle under
 *    an `evidence-loader` lock and remapping `task_complexity` — so the corpus
 *    binds it with `{ migrate: false }`. These tests drive the REAL default
 *    readers, and a CONTROL test drives the migrating path over an identical
 *    fixture so the read-only assertions cannot pass for want of anything to
 *    mutate.
 * 2. The balanced truncation cut removes the SYSTEMATIC bias toward successes,
 *    but it balances per source and drops later sources whole. Those residual
 *    limits are pinned here so the docs and the tool's printed guarantee cannot
 *    drift back into claiming truncation preserves negative evidence outright.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { CorpusReaders } from '../../../src/consensus/corpus';
import { loadConsensusCorpus } from '../../../src/consensus/corpus';
import { loadEvidence } from '../../../src/evidence/manager';

const DIRECTORY = '/virtual/project';

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function project(): string {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), 'swarm-consensus-readonly-')),
	);
	roots.push(root);
	return root;
}

/** Readers that return nothing, so a test only wires the source it asserts on. */
function emptyReaders(): CorpusReaders {
	return {
		listEvaluationRunIds: async () => [],
		readEvaluationRun: async () => undefined,
		listGateAuditResults: async () => ({ results: [], corruptRunIds: [] }),
		readGateGroundTruth: async () => ({ events: [], malformed: 0 }),
		listEvidenceTaskIds: async () => [],
		readTaskTrajectory: async () => [],
		listTrajectorySessions: async () => [],
		readTrajectory: async () => [],
		readSkillUsageEntries: () => [],
		readKnowledgeEntries: async () => [],
		loadEvidence: async () => ({ status: 'not_found' }),
		readRejectedLessons: async () => [],
		readRejectedSkillEdits: async () => [],
	};
}

describe('corpus — mining a legacy retrospective mutates nothing on disk', () => {
	/** A legacy flat retrospective: `type: 'retrospective'`, no `schema_version`. */
	function seedFlatRetrospective(root: string, taskId: string): string {
		const dir = path.join(root, '.swarm', 'evidence', taskId);
		mkdirSync(dir, { recursive: true });
		const file = path.join(dir, 'evidence.json');
		writeFileSync(
			file,
			JSON.stringify({
				type: 'retrospective',
				task_id: taskId,
				timestamp: '2024-01-01T00:00:00.000Z',
				agent: 'test-agent',
				verdict: 'info',
				summary: 'Sprint retrospective',
				phase_number: 1,
				total_tool_calls: 100,
				coder_revisions: 5,
				reviewer_rejections: 2,
				test_failures: 1,
				security_findings: 0,
				integration_issues: 0,
				task_count: 10,
				// Legacy value. `LEGACY_TASK_COMPLEXITY_MAP` remaps it to 'moderate'
				// during the default lazy migration, so its survival is the sharpest
				// available proof that no migration ran.
				task_complexity: 'medium',
				top_rejection_reasons: [],
				lessons_learned: [],
			}),
		);
		return file;
	}

	test('the evidence file is byte-identical after a real mining load', async () => {
		// The reproduction: `loadEvidence` upgrades a legacy flat retrospective IN
		// PLACE by default — rewriting the bundle, remapping `task_complexity`, and
		// taking an `evidence-loader` lock. The corpus advertises itself as
		// read-only, so it must bind `{ migrate: false }`. This test drives the REAL
		// default readers, not injected ones; injected readers would prove nothing.
		const root = project();
		const file = seedFlatRetrospective(root, 'retro-1');
		const before = readFileSync(file, 'utf8');

		const corpus = await loadConsensusCorpus(root, {
			maxEvidenceItems: 100,
			maxExcerptChars: 500,
		});

		expect(readFileSync(file, 'utf8')).toBe(before);
		const after = JSON.parse(readFileSync(file, 'utf8'));
		expect(after.schema_version).toBeUndefined();
		expect(after.task_complexity).toBe('medium');
		// And the evidence was still READ — a read-only path that also reads
		// nothing would pass the assertions above for the wrong reason.
		expect(
			corpus.observations.some(
				(observation) =>
					observation.evidenceRef === 'evidence-bundle:retro-1:0',
			),
		).toBe(true);
		expect(corpus.unreadableSources).toEqual([]);
	});

	test('no lock sentinel is created anywhere under .swarm', async () => {
		// The default path takes the evidence lock as actor `evidence-loader`,
		// which leaves a sentinel behind under `.swarm/locks/`.
		const root = project();
		seedFlatRetrospective(root, 'retro-2');
		await loadConsensusCorpus(root, {
			maxEvidenceItems: 100,
			maxExcerptChars: 500,
		});
		expect(existsSync(path.join(root, '.swarm', 'locks'))).toBe(false);
	});

	test('CONTROL: the default loadEvidence really does mutate the same fixture', async () => {
		// Without this, the two tests above could pass because the fixture is
		// inert rather than because the corpus is read-only. Driving the DEFAULT
		// path over an identical fixture shows the mutation the corpus avoids.
		const root = project();
		const file = seedFlatRetrospective(root, 'retro-3');
		const before = readFileSync(file, 'utf8');

		const result = await loadEvidence(root, 'retro-3');

		expect(result.status).toBe('found');
		expect(readFileSync(file, 'utf8')).not.toBe(before);
		const after = JSON.parse(readFileSync(file, 'utf8'));
		expect(after.schema_version).toBe('1.0.0');
		expect(after.entries[0].task_complexity).toBe('moderate');
		expect(existsSync(path.join(root, '.swarm', 'locks'))).toBe(true);
	});

	test('migrate: false still returns the normalized view, only the write is skipped', async () => {
		// The distinction matters for anyone reading the corpus: observations are
		// built from the wrapped, remapped bundle even though the file keeps its
		// legacy shape. Pinning it stops the doc claim from drifting either way.
		const root = project();
		const file = seedFlatRetrospective(root, 'retro-4');
		const result = await loadEvidence(root, 'retro-4', { migrate: false });

		expect(result.status).toBe('found');
		if (result.status !== 'found') return;
		expect(result.bundle.schema_version).toBe('1.0.0');
		expect(
			(result.bundle.entries[0] as { task_complexity?: string })
				.task_complexity,
		).toBe('moderate');
		// ...while the file still says `medium` and is still flat.
		const onDisk = JSON.parse(readFileSync(file, 'utf8'));
		expect(onDisk.task_complexity).toBe('medium');
		expect(onDisk.schema_version).toBeUndefined();
	});
});

describe('corpus — what the balanced cut does NOT protect', () => {
	// Documented limits, pinned so the docs and the printed tool guarantee cannot
	// drift back into claiming truncation preserves negative evidence outright.
	test('a source reached after the budget is spent is dropped WHOLE, unbalanced', async () => {
		const corpus = await loadConsensusCorpus(DIRECTORY, {
			maxEvidenceItems: 3,
			maxExcerptChars: 500,
			readers: {
				...emptyReaders(),
				// `gate-audit` precedes `task-trajectory` in SOURCE_ORDER.
				listGateAuditResults: async () => ({
					results: [
						{
							runId: 'ga1',
							cells: Array.from({ length: 5 }, (_, index) => ({
								taskId: `t${index}`,
								gate: 'review',
								model: 'm',
								outcome: 'caught',
							})),
						},
					],
					corruptRunIds: [],
				}),
				listEvidenceTaskIds: async () => ['1.1'],
				readTaskTrajectory: async () => [
					{
						step: 1,
						agent: 'coder',
						action: 'edit',
						target: 'src/a.ts',
						intent: 'fix',
						timestamp: '2026-07-24T00:00:00.000Z',
						result: 'failure' as const,
					},
				],
			} as unknown as Partial<CorpusReaders>,
		});
		expect(corpus.observations).toHaveLength(3);
		expect(corpus.truncated).toBe(true);
		// The only failing observation lived in a later source and is simply gone.
		expect(corpus.observations.every((entry) => entry.success)).toBe(true);
		// It is not silently gone, though: the report will say it was truncated,
		// and the per-source hash still declares the source's full size.
		expect(
			corpus.hashes.find((entry) => entry.source === 'task-trajectory')
				?.observations,
		).toBe(1);
	});

	test('the balance is per SOURCE, so one signal can still lose every counterexample', async () => {
		// Within one source, the cut alternates by outcome — but the failures it
		// keeps may all belong to a different signal than the one being read.
		const corpus = await loadConsensusCorpus(DIRECTORY, {
			maxEvidenceItems: 4,
			maxExcerptChars: 500,
			readers: {
				...emptyReaders(),
				listGateAuditResults: async () => ({
					results: [
						{
							runId: 'ga1',
							cells: [
								// Signal A: caught (success), sorts first.
								{ taskId: 'a0', gate: 'alpha', model: 'm', outcome: 'caught' },
								{ taskId: 'a1', gate: 'alpha', model: 'm', outcome: 'caught' },
								// Signal A's only failure sorts last.
								{ taskId: 'z9', gate: 'alpha', model: 'm', outcome: 'missed' },
								// Signal B's failures sort earlier and win the failure slots.
								{ taskId: 'b0', gate: 'beta', model: 'm', outcome: 'missed' },
								{ taskId: 'b1', gate: 'beta', model: 'm', outcome: 'missed' },
							],
						},
					],
					corruptRunIds: [],
				}),
			} as unknown as Partial<CorpusReaders>,
		});
		const alphaFailures = corpus.observations.filter(
			(entry) => !entry.success && entry.agentRole === 'alpha',
		);
		expect(corpus.truncated).toBe(true);
		// Failures survived overall...
		expect(
			corpus.observations.filter((entry) => !entry.success).length,
		).toBeGreaterThan(0);
		// ...but not alpha's. This is the documented residual risk.
		expect(alphaFailures).toHaveLength(0);
	});
});
