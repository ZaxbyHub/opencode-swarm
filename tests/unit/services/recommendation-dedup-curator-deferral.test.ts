/**
 * Cross-producer recommendation dedup at the CURATOR emission site
 * (issue #1821 AC21) — a recommendation the curator DEFERS is never burned.
 *
 * The ledger records only what actually took effect. Every path here defers
 * rather than rejects, so a later sweep must still be able to apply the same
 * recommendation. Suppression behaviour lives in
 * `recommendation-dedup-curator.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyCuratorKnowledgeUpdates } from '../../../src/hooks/curator.js';
import { readRecommendationLedger } from '../../../src/services/recommendation-ledger.js';
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
		fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-rec-dedup-defer-')),
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

describe('curator emission site — a deferred recommendation is never burned', () => {
	it('lets a quarantined prose lesson land once it becomes actionable', async () => {
		// Sweep 1 has no predicate/scope, so the Layer-5 actionability gate routes
		// it to the unactionable queue. Nothing was emitted, so nothing may be
		// recorded — the hardening loop's recovered version must still be able to
		// land on a later sweep.
		seedKnowledge([]);
		const quarantined = await applyCuratorKnowledgeUpdates(
			dir,
			[{ action: 'promote', lesson: NEW_LESSON, reason: 'prose only' }],
			knowledgeConfig,
		);
		expect(quarantined.applied).toBe(0);
		expect(await readRecommendationLedger(dir)).toHaveLength(0);

		const recovered = await applyCuratorKnowledgeUpdates(
			dir,
			[
				{
					action: 'promote',
					lesson: NEW_LESSON,
					reason: 'hardened',
					...ACTIONABLE,
				},
			],
			knowledgeConfig,
		);
		expect(recovered.applied).toBe(1);
		expect(readKnowledge()).toHaveLength(1);
	});

	it('lets an archive land once its target entry exists', async () => {
		// A recommendation whose `entry_id` is not in the store is skipped as
		// "not found" and expected to be retried on a later sweep, once the entry
		// the curator was told about has actually been written.
		const lesson = 'A lesson whose entry has not been written yet';
		seedKnowledge([]);
		const deferred = await applyCuratorKnowledgeUpdates(
			dir,
			[{ action: 'archive', entry_id: 'E9', lesson, reason: 'stale' }],
			knowledgeConfig,
		);
		expect(deferred.applied).toBe(0);
		expect(deferred.skipped).toBe(1);
		expect(await readRecommendationLedger(dir)).toHaveLength(0);

		seedKnowledge([knowledgeEntry('E9', lesson)]);
		const retried = await applyCuratorKnowledgeUpdates(
			dir,
			[{ action: 'archive', entry_id: 'E9', lesson, reason: 'stale' }],
			knowledgeConfig,
		);
		expect(retried.applied).toBe(1);
		expect(readKnowledge()[0]?.status).toBe('archived');
	});

	it('lets the loser of a same-entry pair land on a later sweep (F1)', async () => {
		// `entries.map` resolves at most ONE recommendation per entry id, so the
		// archive below never runs. Recording it — which an `appliedIds`-keyed
		// collector did, because the promote marked the same entry id applied —
		// burned its cross key and suppressed the archive forever.
		const lesson = 'A lesson promoted and archived in the same sweep';
		seedKnowledge([knowledgeEntry('E1', lesson)]);

		const first = await applyCuratorKnowledgeUpdates(
			dir,
			[
				{ action: 'promote', entry_id: 'E1', lesson, reason: 'confirmed' },
				{ action: 'archive', entry_id: 'E1', lesson, reason: 'superseded' },
			],
			knowledgeConfig,
		);
		expect(first.applied).toBe(1);
		expect(readKnowledge()[0]?.status).toBe('candidate');
		// Neither the applied promote (reinforcement, never recorded) nor the
		// dropped archive may be in the ledger.
		expect(await readRecommendationLedger(dir)).toHaveLength(0);

		const second = await applyCuratorKnowledgeUpdates(
			dir,
			[{ action: 'archive', entry_id: 'E1', lesson, reason: 'superseded' }],
			knowledgeConfig,
		);
		expect(second.applied).toBe(1);
		expect(readKnowledge()[0]?.status).toBe('archived');
	});

	it('lets the loser of a same-entry, two-lesson pair land later (F1)', async () => {
		const original = 'The original lesson text for this entry';
		seedKnowledge([knowledgeEntry('E1', original)]);

		const first = await applyCuratorKnowledgeUpdates(
			dir,
			[
				{
					action: 'rewrite',
					entry_id: 'E1',
					lesson: 'First rewritten lesson text for this entry',
					reason: 'a',
				},
				{
					action: 'rewrite',
					entry_id: 'E1',
					lesson: 'Second rewritten lesson text for this entry',
					reason: 'b',
				},
			],
			knowledgeConfig,
		);
		expect(first.applied).toBe(1);
		// Exactly one rewrite ran, so exactly one cross key may be recorded.
		expect(await readRecommendationLedger(dir)).toHaveLength(1);

		const second = await applyCuratorKnowledgeUpdates(
			dir,
			[
				{
					action: 'rewrite',
					entry_id: 'E1',
					lesson: 'Second rewritten lesson text for this entry',
					reason: 'b',
				},
			],
			knowledgeConfig,
		);
		expect(second.applied).toBe(1);
		expect(readKnowledge()[0]?.lesson).toBe(
			'Second rewritten lesson text for this entry',
		);
	});

	it('dedups a prefix-form entry_id against its canonical form (F2)', async () => {
		// The transaction expands an 8-hex prefix to the canonical id before the
		// record half sees it. The check half must canonicalize too, or the
		// prefix-form recommendation records under the full id and never matches
		// its own next sweep.
		const fullId = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
		const lesson = 'A lesson referenced by a short entry id prefix';
		seedKnowledge([knowledgeEntry(fullId, lesson)]);

		const first = await applyCuratorKnowledgeUpdates(
			dir,
			[
				{
					action: 'flag_contradiction',
					entry_id: '1a2b3c4d',
					lesson,
					reason: 'contradicted',
				},
			],
			knowledgeConfig,
		);
		expect(first.applied).toBe(1);
		const ledger = await readRecommendationLedger(dir);
		expect(ledger).toHaveLength(1);
		expect(ledger[0]?.target).toBe(fullId);

		const second = await applyCuratorKnowledgeUpdates(
			dir,
			[
				{
					action: 'flag_contradiction',
					entry_id: '1a2b3c4d',
					lesson,
					reason: 'contradicted',
				},
			],
			knowledgeConfig,
		);
		expect(second.applied).toBe(0);
		expect(second.skipped).toBe(1);
	});

	it('lets a too-short lesson land once it is written out properly', async () => {
		seedKnowledge([]);
		const tooShort = await applyCuratorKnowledgeUpdates(
			dir,
			[{ action: 'promote', lesson: 'too short', reason: 'x', ...ACTIONABLE }],
			knowledgeConfig,
		);
		expect(tooShort.applied).toBe(0);
		expect(await readRecommendationLedger(dir)).toHaveLength(0);
	});
});
