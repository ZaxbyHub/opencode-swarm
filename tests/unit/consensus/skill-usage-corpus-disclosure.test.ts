/**
 * Issue #2038 (final-critic finding) — the consensus corpus must disclose a
 * truncated skill-usage window instead of silently mining partial history:
 * `loadConsensusCorpus` sets `truncated: true` when the (optional)
 * getSkillUsageCoverage reader reports coverage 'truncated'.
 */

import { describe, expect, test } from 'bun:test';
import type { CorpusReaders } from '../../../src/consensus/corpus.js';
import { loadConsensusCorpus } from '../../../src/consensus/corpus.js';
import type { SkillUsageEntry } from '../../../src/hooks/skill-usage-log.js';
import { withFrozenClock } from '../../helpers/test-clock.js';

function entry(i: number): SkillUsageEntry {
	return {
		id: `e-${i}`,
		skillPath: `.claude/skills/corpus-skill/SKILL.md`,
		agentName: 'coder',
		taskID: `t-${i}`,
		timestamp: new Date(Date.now() - i * 1000).toISOString(),
		complianceVerdict: 'compliant',
		sessionID: 'sess-corpus',
	};
}

function makeReaders(
	coverage: 'complete' | 'truncated' | 'empty',
): CorpusReaders {
	return {
		listEvaluationRunIds: async () => [],
		readEvaluationRun: async () => undefined,
		listGateAuditResults: async () => ({ results: [], corrupt: 0 }),
		readGateGroundTruth: async () => undefined,
		listEvidenceTaskIds: async () => [],
		readTaskTrajectory: async () => [],
		listTrajectorySessions: async () => [],
		readTrajectory: async () => [],
		readSkillUsageEntries: () => [entry(0), entry(1)],
		getSkillUsageCoverage: () => ({
			coverage,
			onDiskBytes: coverage === 'truncated' ? 999999 : 500,
			retainedEntries: 2,
			readMaxBytes: 2 * 1024 * 1024,
		}),
		readKnowledgeEntries: async () => [],
		loadEvidence: async () => ({ tasks: [] }),
		readRejectedLessons: async () => [],
		readRejectedSkillEdits: async () => [],
	};
}

describe('consensus corpus skill-usage coverage disclosure (issue #2038)', () => {
	test('truncated skill-usage coverage sets the corpus truncated flag', async () => {
		// Test-clock adoption (issue #1782 gate): entry() stamps relative
		// timestamps — freeze so they are deterministic.
		const result = await withFrozenClock(() =>
			loadConsensusCorpus('/unused-test-dir', {
				maxEvidenceItems: 100,
				maxExcerptChars: 200,
				readers: makeReaders('truncated'),
			}),
		);
		expect(result.truncated).toBe(true);
		// The observations themselves still flow (statistical consumer).
		expect(
			result.observations.filter((o) => o.runId === 'skill-usage:sess-corpus'),
		).toHaveLength(2);
	});

	test('complete coverage leaves the truncated flag untouched', async () => {
		const result = await withFrozenClock(() =>
			loadConsensusCorpus('/unused-test-dir', {
				maxEvidenceItems: 100,
				maxExcerptChars: 200,
				readers: makeReaders('complete'),
			}),
		);
		expect(result.truncated).toBe(false);
	});
});
