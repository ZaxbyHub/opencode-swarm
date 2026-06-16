/**
 * Trigger-recall union (Change 5 / Task 6.2).
 *
 * An entry whose declared trigger phrase appears in the composite query surfaces
 * even when its lesson text shares little vocabulary with the query. Triggers
 * are matched as case-insensitive literal substrings (no regex engine in the
 * hot path).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeConfigSchema } from '../../../src/config/schema';
import {
	appendKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import { searchKnowledge } from '../../../src/hooks/search-knowledge';

const config = KnowledgeConfigSchema.parse({});

function makeEntry(
	overrides: Partial<SwarmKnowledgeEntry> & { id: string; lesson: string },
): SwarmKnowledgeEntry {
	return {
		tier: 'swarm',
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.6,
		status: 'established',
		confirmed_by: [],
		project_name: 'test',
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2024-01-01T00:00:00.000Z',
		updated_at: '2024-01-01T00:00:00.000Z',
		...overrides,
	};
}

describe('trigger-recall union (Task 6.2)', () => {
	let dir: string;
	let kp: string;
	let prevXdg: string | undefined;
	beforeEach(() => {
		dir = join(tmpdir(), `swarm-trig-${Date.now()}-${Math.random()}`);
		mkdirSync(dir, { recursive: true });
		kp = resolveSwarmKnowledgePath(dir);
		prevXdg = process.env.XDG_DATA_HOME;
		process.env.XDG_DATA_HOME = join(dir, 'xdg');
	});
	afterEach(() => {
		if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = prevXdg;
		rmSync(dir, { recursive: true, force: true });
	});

	async function scoreFor(
		entry: SwarmKnowledgeEntry,
		query: string,
	): Promise<number> {
		rmSync(kp, { force: true });
		await appendKnowledge(kp, entry);
		const { results } = await searchKnowledge({
			directory: dir,
			config,
			query,
			mode: 'manual',
			tier: 'swarm',
			applyScopeFilter: false,
			applyRoleScope: false,
			emitEvent: false,
		});
		const s = results.find((r) => r.id === entry.id)?.finalScore;
		expect(s).toBeDefined();
		return s as number;
	}

	it('boosts an entry whose trigger phrase appears in the query', async () => {
		const query = 'about to start deleting production data from the cluster';
		const lesson =
			'unrelated note on formatting whitespace in documentation files';
		const withTrigger = await scoreFor(
			makeEntry({ id: 'e', lesson, triggers: ['deleting production data'] }),
			query,
		);
		const withoutTrigger = await scoreFor(
			makeEntry({ id: 'e', lesson }),
			query,
		);
		expect(withTrigger).toBeGreaterThan(withoutTrigger);
		expect(withTrigger - withoutTrigger).toBeCloseTo(0.3, 5);
	});

	it('the trigger boost flips an entry above genuinely higher-text-score noise', async () => {
		// Noise entries partially overlap the query text, so on text alone they
		// out-score the (text-irrelevant) target. Seeding the SAME corpus with and
		// without the target's trigger isolates the trigger boost as the cause of
		// the flip — deterministic at the finalScore level (no MMR/rank confound).
		const query = 'rotate the signing key before the scheduled deploy';
		const noiseLesson = 'rotate the signing documents before lunch';
		const seed = async (withTrigger: boolean) => {
			rmSync(kp, { force: true });
			for (let i = 0; i < 3; i++) {
				await appendKnowledge(
					kp,
					makeEntry({ id: `noise-${i}`, lesson: `${noiseLesson} ${i}` }),
				);
			}
			await appendKnowledge(
				kp,
				makeEntry({
					id: 'target',
					lesson: 'an entry whose lesson text shares no words with the request',
					triggers: withTrigger ? ['rotate the signing key'] : undefined,
				}),
			);
			const { results } = await searchKnowledge({
				directory: dir,
				config,
				query,
				mode: 'manual',
				tier: 'swarm',
				maxResults: 10,
				applyScopeFilter: false,
				applyRoleScope: false,
				emitEvent: false,
			});
			const score = (id: string) =>
				results.find((r) => r.id === id)?.finalScore ?? 0;
			return { target: score('target'), noise: score('noise-0') };
		};
		const control = await seed(false);
		// Without the trigger, the text-overlapping noise genuinely out-scores the
		// target — proving the noise really is higher-text-score.
		expect(control.noise).toBeGreaterThan(control.target);
		const boosted = await seed(true);
		// The trigger-recall boost lifts the target above that higher-text-score
		// noise — the boost is load-bearing, not incidental.
		expect(boosted.target).toBeGreaterThan(boosted.noise);
	});

	it('does not boost when the trigger phrase is absent from the query', async () => {
		const lesson = 'note text that is unrelated to the user query phrase';
		const present = await scoreFor(
			makeEntry({ id: 'e', lesson, triggers: ['force push to main'] }),
			'someone tried to force push to main again',
		);
		const absent = await scoreFor(
			makeEntry({ id: 'e', lesson, triggers: ['force push to main'] }),
			'a completely different topic about caching layers',
		);
		expect(present).toBeGreaterThan(absent);
	});
});
