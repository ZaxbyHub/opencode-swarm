/**
 * Corpus assembly for the consensus miner (issue #1821, Lane C).
 *
 * Readers are injected rather than mocked at module scope: the corpus draws on
 * eight subsystems, and `mock.module` on those paths leaks across files in Bun's
 * shared test-runner process (AGENTS.md invariant 7). The two enumerators this
 * module owns are exercised against real temp directories.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { CorpusReaders } from '../../../src/consensus/corpus';
import {
	listEvaluationRunIds,
	listTrajectorySessions,
	loadConsensusCorpus,
} from '../../../src/consensus/corpus';

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function project(): string {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), 'swarm-consensus-corpus-')),
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

describe('corpus — secret redaction end to end', () => {
	test('a secret planted in a knowledge lesson never reaches an observation', async () => {
		const corpus = await loadConsensusCorpus('/virtual/project', {
			maxEvidenceItems: 50,
			maxExcerptChars: 500,
			readers: {
				...emptyReaders(),
				readKnowledgeEntries: async () => [
					{
						id: 'k1',
						category: 'security',
						lesson:
							'Never commit ghp_abcdefghijklmnopqrstuvwxyz0123456789 to the repo',
						retrieval_outcomes: undefined,
					},
				],
			},
		});
		expect(corpus.observations).toHaveLength(1);
		const serialized = JSON.stringify(corpus.observations);
		expect(serialized).not.toContain(
			'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
		);
		expect(serialized).toContain('[REDACTED:github_token]');
	});

	test('a secret planted in a skill path is redacted in the signal', async () => {
		const corpus = await loadConsensusCorpus('/virtual/project', {
			maxEvidenceItems: 50,
			maxExcerptChars: 500,
			readers: {
				...emptyReaders(),
				readSkillUsageEntries: () => [
					{
						id: 'u1',
						skillPath: '.claude/skills/sk-abcdefghijklmnopqrstuvw/SKILL.md',
						agentName: 'coder',
						taskID: '1.1',
						timestamp: '2026-07-24T00:00:00.000Z',
						complianceVerdict: 'compliant',
						sessionID: 's1',
					},
				],
			},
		});
		const serialized = JSON.stringify(corpus.observations);
		expect(serialized).not.toContain('sk-abcdefghijklmnopqrstuvw');
		expect(serialized).toContain('[REDACTED:openai_api_key]');
	});
});

describe('corpus — evidence cap', () => {
	test('truncates at maxEvidenceItems and reports the truncation', async () => {
		const corpus = await loadConsensusCorpus('/virtual/project', {
			maxEvidenceItems: 3,
			maxExcerptChars: 500,
			readers: {
				...emptyReaders(),
				readKnowledgeEntries: async () =>
					Array.from({ length: 10 }, (_, index) => ({
						id: `k${index}`,
						category: 'process',
						lesson: `lesson number ${index}`,
					})),
			},
		});
		expect(corpus.observations).toHaveLength(3);
		expect(corpus.truncated).toBe(true);
		// The per-source hash records the FULL count, so a truncated report still
		// declares how much evidence existed.
		const knowledgeHash = corpus.hashes.find(
			(entry) => entry.source === 'knowledge',
		);
		expect(knowledgeHash?.observations).toBe(10);
	});

	test('an exactly-fitting corpus is not marked truncated', async () => {
		const corpus = await loadConsensusCorpus('/virtual/project', {
			maxEvidenceItems: 2,
			maxExcerptChars: 500,
			readers: {
				...emptyReaders(),
				readKnowledgeEntries: async () => [
					{ id: 'k0', category: 'process', lesson: 'first lesson' },
					{ id: 'k1', category: 'process', lesson: 'second lesson' },
				],
			},
		});
		expect(corpus.observations).toHaveLength(2);
		expect(corpus.truncated).toBe(false);
	});

	test('truncation is deterministic across repeated loads', async () => {
		const readers = {
			...emptyReaders(),
			readKnowledgeEntries: async () =>
				Array.from({ length: 20 }, (_, index) => ({
					id: `k${index}`,
					category: 'process',
					lesson: `lesson ${index}`,
				})),
		};
		const first = await loadConsensusCorpus('/virtual/project', {
			maxEvidenceItems: 5,
			maxExcerptChars: 500,
			readers,
		});
		const second = await loadConsensusCorpus('/virtual/project', {
			maxEvidenceItems: 5,
			maxExcerptChars: 500,
			readers,
		});
		expect(second.observations).toEqual(first.observations);
	});
});

describe('corpus — truncation must not erase negative evidence', () => {
	/**
	 * Ten gate-audit cells whose refs sort t0…t9, where the FAILING half (t5–t9)
	 * sorts last. A lexicographic `slice(0, limit)` keeps only the succeeding
	 * half, which is the failure mode: `failureSupport` and `counterexampleRefs`
	 * fall to zero while `confidence` rises, on evidence that was silently
	 * discarded (issue #1821 AC17).
	 */
	function gateAuditReaders() {
		return {
			listGateAuditResults: async () => ({
				results: [
					{
						runId: 'ga1',
						cells: Array.from({ length: 10 }, (_, index) => ({
							taskId: `t${index}`,
							gate: 'review',
							model: 'anthropic/model-a',
							outcome: index < 5 ? 'caught' : 'missed',
						})),
					},
				],
				corruptRunIds: [],
			}),
		} as unknown as Partial<CorpusReaders>;
	}

	async function truncatedTo(limit: number) {
		const corpus = await loadConsensusCorpus('/virtual/project', {
			maxEvidenceItems: limit,
			maxExcerptChars: 500,
			readers: { ...emptyReaders(), ...gateAuditReaders() },
		});
		return corpus;
	}

	test('a cut keeps failing observations even when they sort last', async () => {
		const corpus = await truncatedTo(5);
		expect(corpus.observations).toHaveLength(5);
		expect(corpus.truncated).toBe(true);
		const failures = corpus.observations.filter(
			(observation) => !observation.success,
		);
		// The whole point: not zero.
		expect(failures.length).toBeGreaterThan(0);
		// Failures round up on an odd budget — under-reporting a counterexample is
		// the costlier error.
		expect(failures).toHaveLength(3);
	});

	test('an even budget splits evenly between outcomes', async () => {
		const corpus = await truncatedTo(4);
		expect(
			corpus.observations.filter((observation) => !observation.success),
		).toHaveLength(2);
		expect(
			corpus.observations.filter((observation) => observation.success),
		).toHaveLength(2);
	});

	test('a source with no failures still fills the whole budget', async () => {
		// The balancing must not reserve capacity that nothing can use.
		const corpus = await loadConsensusCorpus('/virtual/project', {
			maxEvidenceItems: 4,
			maxExcerptChars: 500,
			readers: {
				...emptyReaders(),
				listGateAuditResults: async () => ({
					results: [
						{
							runId: 'ga1',
							cells: Array.from({ length: 10 }, (_, index) => ({
								taskId: `t${index}`,
								gate: 'review',
								model: 'anthropic/model-a',
								outcome: 'caught',
							})),
						},
					],
					corruptRunIds: [],
				}),
			} as unknown as Partial<CorpusReaders>,
		});
		expect(corpus.observations).toHaveLength(4);
		expect(corpus.observations.every((entry) => entry.success)).toBe(true);
	});

	test('a budget larger than the source is not a cut, and preserves order', async () => {
		const corpus = await truncatedTo(50);
		expect(corpus.observations).toHaveLength(10);
		expect(corpus.truncated).toBe(false);
		expect(corpus.observations.map((entry) => entry.evidenceRef)).toEqual(
			[...corpus.observations.map((entry) => entry.evidenceRef)].sort(),
		);
	});

	test('the retained subset is still sorted, and still deterministic', async () => {
		const first = await truncatedTo(5);
		const second = await truncatedTo(5);
		expect(second.observations).toEqual(first.observations);
		expect(first.observations.map((entry) => entry.evidenceRef)).toEqual(
			[...first.observations.map((entry) => entry.evidenceRef)].sort(),
		);
	});
});

describe('corpus — injected directory, never process.cwd()', () => {
	test('every reader receives the directory the caller supplied', async () => {
		const seen: string[] = [];
		const record = (directory: string) => {
			seen.push(directory);
			return [];
		};
		await loadConsensusCorpus('/injected/root', {
			maxEvidenceItems: 10,
			maxExcerptChars: 100,
			readers: {
				...emptyReaders(),
				listEvaluationRunIds: async (directory) => record(directory),
				listEvidenceTaskIds: async (directory) => record(directory),
				listTrajectorySessions: async (directory) => record(directory),
				readSkillUsageEntries: (directory) => {
					seen.push(directory);
					return [];
				},
				readKnowledgeEntries: async (directory) => record(directory),
			},
		});
		expect(seen.length).toBeGreaterThan(0);
		expect(new Set(seen)).toEqual(new Set(['/injected/root']));
	});
});

describe('corpus — degradation', () => {
	test('a throwing source is recorded rather than failing the whole load', async () => {
		const corpus = await loadConsensusCorpus('/virtual/project', {
			maxEvidenceItems: 50,
			maxExcerptChars: 500,
			readers: {
				...emptyReaders(),
				listEvaluationRunIds: async () => {
					throw new Error('corrupt runs directory');
				},
				readKnowledgeEntries: async () => [
					{ id: 'k0', category: 'process', lesson: 'still readable' },
				],
			},
		});
		expect(corpus.unreadableSources).toContain('evaluation-run');
		expect(corpus.observations).toHaveLength(1);
		// A source that threw must not claim a hash for evidence it never read.
		expect(
			corpus.hashes.some((entry) => entry.source === 'evaluation-run'),
		).toBe(false);
	});
});

describe('corpus — run identity namespacing', () => {
	test('task trajectories and evidence bundles share one task-scoped run id', async () => {
		// Two views of the SAME trial must not double the apparent support.
		const corpus = await loadConsensusCorpus('/virtual/project', {
			maxEvidenceItems: 50,
			maxExcerptChars: 500,
			readers: {
				...emptyReaders(),
				listEvidenceTaskIds: async () => ['1.1'],
				readTaskTrajectory: async () => [
					{
						step: 1,
						agent: 'coder',
						action: 'edit',
						target: 'src/a.ts',
						intent: 'fix',
						timestamp: '2026-07-24T00:00:00.000Z',
						result: 'success',
					},
				],
				loadEvidence: async () => ({
					status: 'found',
					bundle: {
						schema_version: '1.0.0',
						task_id: '1.1',
						created_at: '2026-07-24T00:00:00.000Z',
						updated_at: '2026-07-24T00:00:00.000Z',
						entries: [
							{
								task_id: '1.1',
								type: 'note',
								timestamp: '2026-07-24T00:00:00.000Z',
								agent: 'reviewer',
								verdict: 'pass',
								summary: 'looks fine',
								note: 'ok',
							},
						],
					},
				}),
			},
		});
		expect(corpus.observations).toHaveLength(2);
		expect(new Set(corpus.observations.map((o) => o.runId))).toEqual(
			new Set(['task:1.1']),
		);
	});
});

describe('enumerators — real filesystem, bounded and contained', () => {
	test('listTrajectorySessions returns [] when .swarm/trajectories is absent', async () => {
		await expect(listTrajectorySessions(project())).resolves.toEqual([]);
	});

	test('listTrajectorySessions returns sorted session ids and ignores non-jsonl', async () => {
		const root = project();
		const dir = path.join(root, '.swarm', 'trajectories');
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, 'ses-b.jsonl'), '');
		writeFileSync(path.join(dir, 'ses-a.jsonl'), '');
		writeFileSync(path.join(dir, 'notes.txt'), '');
		mkdirSync(path.join(dir, 'nested.jsonl'));
		await expect(listTrajectorySessions(root)).resolves.toEqual([
			'ses-a',
			'ses-b',
		]);
	});

	test('listTrajectorySessions rejects names that fail the identifier shape', async () => {
		const root = project();
		const dir = path.join(root, '.swarm', 'trajectories');
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, '.hidden.jsonl'), '');
		writeFileSync(path.join(dir, 'valid.jsonl'), '');
		await expect(listTrajectorySessions(root)).resolves.toEqual(['valid']);
	});

	test('listEvaluationRunIds returns [] when the runs directory is absent', async () => {
		await expect(listEvaluationRunIds(project())).resolves.toEqual([]);
	});

	test('listEvaluationRunIds returns sorted run ids and ignores non-json', async () => {
		const root = project();
		const dir = path.join(root, '.swarm', 'evolution', 'runs');
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, 'run-2.json'), '{}');
		writeFileSync(path.join(dir, 'run-1.json'), '{}');
		writeFileSync(path.join(dir, 'README.md'), '');
		await expect(listEvaluationRunIds(root)).resolves.toEqual([
			'run-1',
			'run-2',
		]);
	});

	test('neither enumerator reads outside the project .swarm directory', async () => {
		// A sibling directory with the same layout must be invisible: the
		// enumerator anchors on the injected root, never on an ambient cwd.
		const root = project();
		const sibling = project();
		mkdirSync(path.join(sibling, '.swarm', 'evolution', 'runs'), {
			recursive: true,
		});
		writeFileSync(
			path.join(sibling, '.swarm', 'evolution', 'runs', 'stray.json'),
			'{}',
		);
		await expect(listEvaluationRunIds(root)).resolves.toEqual([]);
	});
});
