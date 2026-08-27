/**
 * Issue #2041 — the PRM-session corpus source discloses partial windows on
 * BOTH coverage paths: the injected `readTrajectoryWithCoverage` seam and the
 * default path (entries from `readTrajectory` + the persisted checkpoint and
 * file-size probe). The two paths must agree with the live reader's semantics
 * (implementation-review round 1).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	type CorpusReaders,
	loadConsensusCorpus,
} from '../../../src/consensus/corpus';
import type { TrajectoryEntry } from '../../../src/prm/types';

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

const entry = (step: number): TrajectoryEntry => ({
	step,
	agent: 'coder',
	action: 'edit',
	target: 'src/a.ts',
	intent: 'coverage',
	timestamp: '2026-01-01T00:00:00.000Z',
	result: 'success',
});

describe('PRM-session corpus coverage disclosure (issue #2041)', () => {
	let directory: string;

	beforeEach(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-prm-cov-'));
	});

	afterEach(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('injected seam: a truncated window flips ConsensusCorpus.truncated', async () => {
		const corpus = await loadConsensusCorpus(directory, {
			maxEvidenceItems: 100,
			maxExcerptChars: 500,
			readers: {
				...emptyReaders(),
				listTrajectorySessions: async () => ['ses-trunc'],
				readTrajectory: async () => [entry(1), entry(2)],
				readTrajectoryWithCoverage: async () => ({
					entries: [entry(1), entry(2)],
					coverage: 'truncated' as const,
					droppedByCompaction: 40,
					skippedMalformed: 0,
				}),
			},
		});
		expect(corpus.truncated).toBe(true);
		// Entries come from the seam when injected (fixture coherence).
		expect(
			corpus.observations.filter((o) => o.runId === 'prm-session:ses-trunc'),
		).toHaveLength(2);
	});

	test('injected seam: a complete window keeps truncated false', async () => {
		const corpus = await loadConsensusCorpus(directory, {
			maxEvidenceItems: 100,
			maxExcerptChars: 500,
			readers: {
				...emptyReaders(),
				listTrajectorySessions: async () => ['ses-full'],
				readTrajectory: async () => [entry(1)],
				readTrajectoryWithCoverage: async () => ({
					entries: [entry(1)],
					coverage: 'complete' as const,
					droppedByCompaction: 0,
					skippedMalformed: 0,
				}),
			},
		});
		expect(corpus.truncated).toBe(false);
	});

	test('default path: a checkpoint that recorded compaction drops flips truncated', async () => {
		const trajectoriesDir = path.join(directory, '.swarm', 'trajectories');
		fs.mkdirSync(trajectoriesDir, { recursive: true });
		fs.writeFileSync(
			path.join(trajectoriesDir, 'ses-compacted.jsonl'),
			`${JSON.stringify(entry(1))}\n`,
		);
		fs.writeFileSync(
			path.join(trajectoriesDir, 'ses-compacted.jsonl.meta.json'),
			JSON.stringify({
				version: 1,
				highestStep: 1,
				droppedEntries: 99,
				compactedAt: '2026-01-01T00:00:00.000Z',
			}) + '\n',
		);

		const corpus = await loadConsensusCorpus(directory, {
			maxEvidenceItems: 100,
			maxExcerptChars: 500,
			readers: {
				...emptyReaders(),
				listTrajectorySessions: async () => ['ses-compacted'],
				readTrajectory: async () => [entry(1)],
			},
		});
		expect(corpus.truncated).toBe(true);
		expect(
			corpus.observations.filter(
				(o) => o.runId === 'prm-session:ses-compacted',
			),
		).toHaveLength(1);
	});

	test('default path: a file larger than the read window flips truncated (parity with the live reader)', async () => {
		const trajectoriesDir = path.join(directory, '.swarm', 'trajectories');
		fs.mkdirSync(trajectoriesDir, { recursive: true });
		// No checkpoint (droppedEntries = 0) but a >1 MiB legacy file: the
		// live bounded read would be window-truncated, so the default verdict
		// must agree instead of silently claiming completeness.
		const lines: string[] = [];
		for (let i = 1; i <= 8000; i++) lines.push(JSON.stringify(entry(i)));
		fs.writeFileSync(
			path.join(trajectoriesDir, 'ses-huge.jsonl'),
			`${lines.join('\n')}\n`,
		);

		const corpus = await loadConsensusCorpus(directory, {
			maxEvidenceItems: 100,
			maxExcerptChars: 500,
			readers: {
				...emptyReaders(),
				listTrajectorySessions: async () => ['ses-huge'],
			},
		});
		expect(corpus.truncated).toBe(true);
	});

	test('default path: a small, never-compacted session is complete', async () => {
		const trajectoriesDir = path.join(directory, '.swarm', 'trajectories');
		fs.mkdirSync(trajectoriesDir, { recursive: true });
		fs.writeFileSync(
			path.join(trajectoriesDir, 'ses-small.jsonl'),
			`${JSON.stringify(entry(1))}\n`,
		);

		const corpus = await loadConsensusCorpus(directory, {
			maxEvidenceItems: 100,
			maxExcerptChars: 500,
			readers: {
				...emptyReaders(),
				listTrajectorySessions: async () => ['ses-small'],
			},
		});
		expect(corpus.truncated).toBe(false);
	});
});
