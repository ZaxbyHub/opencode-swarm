/**
 * Cross-producer recommendation dedup at the CURATOR emission site
 * (issue #1821 AC21) — suppression behaviour.
 *
 * Exercises the real production entry point `applyCuratorKnowledgeUpdates`
 * (`src/hooks/curator.ts`), which every curator path converges on:
 * `phase_complete`, `curator_analyze`, `/swarm curate`, and the post-mortem.
 *
 * The guarantee that a DEFERRED recommendation is never burned lives in
 * `recommendation-dedup-curator-deferral.test.ts`; the improver and miner sites
 * in `recommendation-dedup-improver.test.ts` and
 * `recommendation-dedup-miner.test.ts`; ledger mechanics in
 * `recommendation-ledger.test.ts` and `recommendation-ledger-bounds.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyCuratorKnowledgeUpdates } from '../../../src/hooks/curator.js';
import {
	readRecommendationLedger,
	recordEmittedRecommendations,
} from '../../../src/services/recommendation-ledger.js';
import { _test_exports as consensusMineInternals } from '../../../src/tools/consensus-mine.js';
import {
	ACTIONABLE,
	knowledgeConfig,
	knowledgeEntry,
	NEW_LESSON,
	readKnowledge as readKnowledgeAt,
	seedKnowledge as seedKnowledgeAt,
} from './_recommendation-dedup-fixtures.js';

let dir: string;

beforeEach(() => {
	dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-rec-dedup-curator-')),
	);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function seedKnowledge(entries: Parameters<typeof seedKnowledgeAt>[1]): void {
	seedKnowledgeAt(dir, entries);
}

function readKnowledge(): ReturnType<typeof readKnowledgeAt> {
	return readKnowledgeAt(dir);
}

describe('curator emission site — within-producer dedup', () => {
	it('applies a new-knowledge lesson once even when the text is re-punctuated', async () => {
		// The second sweep's lesson differs by leading whitespace and a trailing
		// period, so the curator's own exact-text guard
		// (`currentLessons.some(el => el.toLowerCase() === lesson.toLowerCase())`)
		// does NOT catch it. Only the ledger's statement normalization does, which
		// is what makes this assertion falsifiable.
		seedKnowledge([]);
		const first = await applyCuratorKnowledgeUpdates(
			dir,
			[
				{
					action: 'promote',
					lesson: NEW_LESSON,
					reason: 'observed',
					...ACTIONABLE,
				},
			],
			knowledgeConfig,
		);
		const second = await applyCuratorKnowledgeUpdates(
			dir,
			[
				{
					action: 'promote',
					lesson: `  ${NEW_LESSON}.  `,
					reason: 'observed again',
					...ACTIONABLE,
				},
			],
			knowledgeConfig,
		);

		expect(first.applied).toBe(1);
		expect(second.applied).toBe(0);
		expect(second.skipped).toBe(1);
		expect(readKnowledge()).toHaveLength(1);
		expect(await readRecommendationLedger(dir)).toHaveLength(1);
	});

	it('archives once and suppresses the repeat archive', async () => {
		const lesson = 'Legacy retry loop is no longer accurate for this repo';
		seedKnowledge([knowledgeEntry('E1', lesson)]);

		const first = await applyCuratorKnowledgeUpdates(
			dir,
			[{ action: 'archive', entry_id: 'E1', lesson, reason: 'stale' }],
			knowledgeConfig,
		);
		expect(first.applied).toBe(1);

		// Re-activate the entry so the only thing that can suppress the second
		// archive is the ledger, not the entry's own status.
		seedKnowledge([knowledgeEntry('E1', lesson)]);
		const second = await applyCuratorKnowledgeUpdates(
			dir,
			[{ action: 'archive', entry_id: 'E1', lesson, reason: 'stale again' }],
			knowledgeConfig,
		);
		expect(second.applied).toBe(0);
		expect(second.skipped).toBe(1);
		expect(readKnowledge()[0]?.status).toBe('candidate');
	});
});

describe('curator emission site — cross-producer dedup', () => {
	it('suppresses a lesson the consensus miner already emitted', async () => {
		seedKnowledge([]);
		// The miner speaks first, through the exact candidate mapping the
		// `consensus_mine` tool uses.
		const minerReport = {
			generatedAt: '2026-07-25T10:00:00.000Z',
			proposals: [
				{
					target: 'tooling',
					intent: NEW_LESSON,
					// `sourceAttributeId` back-references the attribute whose arithmetic
					// produced this proposal (#1821 review finding 5). The dedup path
					// under test never reads it, and tsconfig excludes tests/, so a
					// literal missing it still compiles and passes — which is exactly
					// why it is set here rather than left to rot into a fixture that no
					// longer resembles what the miner emits.
					sourceAttributeId: 'cattr_0123456789abcdef',
					evidenceRefs: ['.swarm/evidence/run-1.json'],
					counterexampleRefs: [],
					confidence: 0.8,
					expectedMetric: 'evaluation.scored_outcome_rate',
					validationSelector: 'scope=full-corpus',
					fingerprint: 'lrec_0123456789abcdef',
					provenance: {
						v: 1 as const,
						mechanism: 'consensus_mine' as const,
						sourceKnowledgeIds: [],
						sourceTaskIds: ['task-1'],
						sourceEvidenceRefs: ['.swarm/evidence/run-1.json'],
						sourceRunIds: ['run-1'],
						sourceModelIds: [],
						writeOrigin: { producedAt: '2026-07-25T10:00:00.000Z' },
					},
				},
			],
		};
		const minerClaim = await recordEmittedRecommendations(
			dir,
			consensusMineInternals.buildMinerRecommendationCandidates(minerReport),
		);
		expect(minerClaim.recorded).toBe(1);

		const result = await applyCuratorKnowledgeUpdates(
			dir,
			[
				{
					action: 'promote',
					lesson: NEW_LESSON,
					reason: 'seen in a sweep',
					...ACTIONABLE,
				},
			],
			knowledgeConfig,
		);

		expect(result.applied).toBe(0);
		expect(result.skipped).toBe(1);
		expect(readKnowledge()).toHaveLength(0);

		const ledger = await readRecommendationLedger(dir);
		expect(ledger).toHaveLength(1);
		expect(ledger[0]?.kind).toBe('miner');
	});

	it('suppresses a lesson the skill improver already emitted', async () => {
		seedKnowledge([]);
		await recordEmittedRecommendations(dir, [
			{
				kind: 'improver',
				target: 'motif-test-runner-test',
				statement: NEW_LESSON,
				scopeKeys: [],
			},
		]);

		const result = await applyCuratorKnowledgeUpdates(
			dir,
			[
				{
					action: 'promote',
					lesson: NEW_LESSON,
					reason: 'seen in a sweep',
					...ACTIONABLE,
				},
			],
			knowledgeConfig,
		);

		expect(result.applied).toBe(0);
		expect(result.skipped).toBe(1);
		expect(readKnowledge()).toHaveLength(0);
	});
});

describe('curator emission site — dedup is not over-broad', () => {
	it('emits genuinely different lessons from the same sweep', async () => {
		seedKnowledge([]);
		const result = await applyCuratorKnowledgeUpdates(
			dir,
			[
				{ action: 'promote', lesson: NEW_LESSON, reason: 'a', ...ACTIONABLE },
				{
					action: 'promote',
					lesson: 'Always run bunx tsc --noEmit before pushing',
					reason: 'b',
					...ACTIONABLE,
				},
			],
			knowledgeConfig,
		);
		expect(result.applied).toBe(2);
		expect(result.skipped).toBe(0);
		expect(readKnowledge()).toHaveLength(2);
	});

	it('keeps rewrite and archive of the same entry distinct', async () => {
		// Identical lesson text, identical entry, two different verbs. Collapsing
		// these would silently lose the archive.
		const lesson = 'A lesson that is first rewritten and later archived';
		seedKnowledge([knowledgeEntry('E1', lesson)]);

		const rewritten = await applyCuratorKnowledgeUpdates(
			dir,
			[{ action: 'rewrite', entry_id: 'E1', lesson, reason: 'tighten' }],
			knowledgeConfig,
		);
		expect(rewritten.applied).toBe(1);

		const archived = await applyCuratorKnowledgeUpdates(
			dir,
			[{ action: 'archive', entry_id: 'E1', lesson, reason: 'now stale' }],
			knowledgeConfig,
		);
		expect(archived.applied).toBe(1);
		expect(readKnowledge()[0]?.status).toBe('archived');
	});

	it('keeps the same verb on different entries distinct', async () => {
		const lesson = 'Duplicated lesson text across two entries';
		seedKnowledge([knowledgeEntry('E1', lesson), knowledgeEntry('E2', lesson)]);

		const result = await applyCuratorKnowledgeUpdates(
			dir,
			[
				{ action: 'archive', entry_id: 'E1', lesson, reason: 'stale' },
				{ action: 'archive', entry_id: 'E2', lesson, reason: 'stale' },
			],
			knowledgeConfig,
		);
		expect(result.applied).toBe(2);
		expect(
			readKnowledge().filter((entry) => entry.status === 'archived'),
		).toHaveLength(2);
	});

	it('keeps reinforcing confidence when an existing entry is re-promoted', async () => {
		// A `promote` on an existing entry is a +0.1 reinforcement, not an
		// emission: an entry needs five of them to reach 1.0. Recording it would
		// cap the accrual at one increment forever and change hive eligibility.
		const lesson = 'A lesson that keeps being confirmed by later phases';
		seedKnowledge([knowledgeEntry('E1', lesson)]);

		for (const reason of ['phase 1', 'phase 2']) {
			const result = await applyCuratorKnowledgeUpdates(
				dir,
				[{ action: 'promote', entry_id: 'E1', lesson, reason }],
				knowledgeConfig,
			);
			expect(result.applied).toBe(1);
		}
		expect(readKnowledge()[0]?.confidence).toBeCloseTo(0.7, 5);
		expect(await readRecommendationLedger(dir)).toHaveLength(0);
	});
});
