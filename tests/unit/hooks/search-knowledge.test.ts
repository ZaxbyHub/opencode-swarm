import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeConfigSchema } from '../../../src/config/schema';
import {
	appendKnowledgeEvent,
	type RetrievedEvent,
	readKnowledgeEvents,
} from '../../../src/hooks/knowledge-events';
import {
	appendKnowledge,
	resolveHiveKnowledgePath,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store';
import type {
	HiveKnowledgeEntry,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types';
import { searchKnowledge } from '../../../src/hooks/search-knowledge';

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
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		...overrides,
	};
}

const config = KnowledgeConfigSchema.parse({});

describe('searchKnowledge (unified retrieval)', () => {
	let dir: string;
	let kp: string;
	let prevXdg: string | undefined;
	let prevLocalAppData: string | undefined;
	beforeEach(() => {
		dir = join(
			tmpdir(),
			`swarm-search-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(dir, { recursive: true });
		kp = resolveSwarmKnowledgePath(dir);
		prevXdg = process.env.XDG_DATA_HOME;
		prevLocalAppData = process.env.LOCALAPPDATA;
		process.env.XDG_DATA_HOME = join(dir, 'xdg');
		process.env.LOCALAPPDATA = join(dir, 'localappdata');
	});
	afterEach(() => {
		if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = prevXdg;
		if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
		else process.env.LOCALAPPDATA = prevLocalAppData;
		rmSync(dir, { recursive: true, force: true });
	});

	it('ranks text-relevant entries first and emits a manual retrieved event with trace_id', async () => {
		await appendKnowledge(
			kp,
			makeEntry({
				id: 'k1',
				lesson: 'Always validate user input before processing requests',
			}),
		);
		await appendKnowledge(
			kp,
			makeEntry({ id: 'k2', lesson: 'Use CSS grid for complex layouts' }),
		);

		const { trace_id, results } = await searchKnowledge({
			directory: dir,
			config,
			query: 'validate user input',
			mode: 'manual',
			agent: 'architect',
			sessionId: 's1',
			tier: 'swarm',
		});
		expect(trace_id.length).toBeGreaterThan(0);
		expect(results[0].id).toBe('k1');

		const retrieved = (await readKnowledgeEvents(dir)).filter(
			(e): e is RetrievedEvent => e.type === 'retrieved',
		);
		expect(retrieved).toHaveLength(1);
		expect(retrieved[0].retrieval_mode).toBe('manual');
		expect(retrieved[0].result_ids[0]).toBe('k1');
		expect(retrieved[0].ranks.k1).toBe(1);
	});

	it('boosts entries with a positive track record over contradicted ones', async () => {
		// Same entry + same query: only the event-sourced outcome history differs,
		// isolating the outcome ranking term.
		const base = {
			id: 'tracked',
			lesson: 'run the full test suite before declaring a phase complete',
		};
		const query = 'run full test suite before phase complete';
		const call = () =>
			searchKnowledge({
				directory: dir,
				config,
				query,
				mode: 'manual' as const,
				tier: 'swarm' as const,
				applyScopeFilter: false,
				emitEvent: false,
			});

		await appendKnowledge(
			kp,
			makeEntry({
				...base,
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
					applied_explicit_count: 8,
					succeeded_after_shown_count: 6,
				},
			}),
		);
		const positive = await call();
		const positiveScore = positive.results.find(
			(r) => r.id === 'tracked',
		)?.finalScore;

		// Reseed the identical entry with a negative track record.
		rmSync(kp, { force: true });
		await appendKnowledge(
			kp,
			makeEntry({
				...base,
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
					ignored_count: 5,
					contradicted_count: 4,
					failed_after_shown_count: 3,
				},
			}),
		);
		const negative = await call();
		const negativeScore = negative.results.find(
			(r) => r.id === 'tracked',
		)?.finalScore;

		expect(positiveScore).toBeDefined();
		expect(negativeScore).toBeDefined();
		expect(positiveScore as number).toBeGreaterThan(negativeScore as number);
	});

	it('uses event-derived receipt counters instead of stale stored counters when ranking', async () => {
		await appendKnowledge(
			kp,
			makeEntry({
				id: 'positive',
				lesson:
					'focused regression tests validate knowledge receipt feedback before closure',
				confidence: 0.9,
				created_at: '2024-01-01T00:00:00.000Z',
				updated_at: '2024-01-01T00:00:00.000Z',
			}),
		);
		await appendKnowledge(
			kp,
			makeEntry({
				id: 'negative',
				lesson:
					'knowledge bug closure should run focused regression suites before handoff',
				confidence: 0.9,
				created_at: '2024-02-01T00:00:00.000Z',
				updated_at: '2024-02-01T00:00:00.000Z',
			}),
		);

		for (let i = 0; i < 8; i++) {
			await appendKnowledgeEvent(dir, {
				type: 'applied',
				trace_id: `tp-${i}`,
				knowledge_id: 'positive',
				session_id: 's',
				agent: 'architect',
			});
		}
		for (let i = 0; i < 7; i++) {
			await appendKnowledgeEvent(dir, {
				type: 'ignored',
				trace_id: `tn-${i}`,
				knowledge_id: 'negative',
				session_id: 's',
				agent: 'architect',
			});
		}

		const { results } = await searchKnowledge({
			directory: dir,
			config,
			query: 'focused regression tests knowledge bugs',
			mode: 'manual',
			tier: 'swarm',
			maxResults: 2,
			applyScopeFilter: false,
			applyRoleScope: false,
			emitEvent: false,
		});

		expect(results.map((r) => r.id).slice(0, 2)).toEqual([
			'positive',
			'negative',
		]);
		expect(
			results.find((r) => r.id === 'positive')?.retrieval_outcomes
				.applied_explicit_count,
		).toBe(8);
	});

	it('does not treat explicit applications with zero legacy applied_count as cold start', async () => {
		await appendKnowledge(
			kp,
			makeEntry({
				id: 'explicitly-applied',
				lesson: 'explicitly applied retry guidance for flaky tests',
				confidence: 0.55,
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
					applied_explicit_count: 3,
				},
			}),
		);

		const { results } = await searchKnowledge({
			directory: dir,
			config,
			query: 'retry guidance for flaky tests',
			mode: 'manual',
			tier: 'swarm',
			applyScopeFilter: false,
			applyRoleScope: false,
			emitEvent: false,
		});

		const result = results.find((r) => r.id === 'explicitly-applied');
		expect(result).toBeDefined();
		expect(result!.coldStartBoost).toBe(0);
	});

	it('filters archived and quarantined entries', async () => {
		await appendKnowledge(
			kp,
			makeEntry({ id: 'live', lesson: 'live testing lesson about retries' }),
		);
		await appendKnowledge(
			kp,
			makeEntry({
				id: 'arch',
				lesson: 'archived testing lesson about retries',
				status: 'archived',
			}),
		);
		await appendKnowledge(
			kp,
			makeEntry({
				id: 'quar',
				lesson: 'quarantined testing lesson about retries',
				status: 'quarantined',
			}),
		);

		const { results } = await searchKnowledge({
			directory: dir,
			config,
			query: 'testing lesson retries',
			mode: 'manual',
			tier: 'swarm',
			emitEvent: false,
		});
		const ids = results.map((r) => r.id);
		expect(ids).toContain('live');
		expect(ids).not.toContain('arch');
		expect(ids).not.toContain('quar');
	});

	it('applies agent-role scoping for entries that declare applies_to_agents', async () => {
		await appendKnowledge(
			kp,
			makeEntry({
				id: 'coder-only',
				lesson: 'coder specific guidance about imports here',
				applies_to_agents: ['coder'],
			}),
		);
		await appendKnowledge(
			kp,
			makeEntry({
				id: 'general',
				lesson: 'general guidance about imports here',
			}),
		);

		const reviewer = await searchKnowledge({
			directory: dir,
			config,
			query: 'guidance about imports',
			mode: 'review_context',
			agent: 'reviewer',
			tier: 'swarm',
			emitEvent: false,
		});
		const reviewerIds = reviewer.results.map((r) => r.id);
		expect(reviewerIds).toContain('general');
		expect(reviewerIds).not.toContain('coder-only');

		// The architect orchestrates everything and sees role-scoped entries.
		const architect = await searchKnowledge({
			directory: dir,
			config,
			query: 'guidance about imports',
			mode: 'auto_injection',
			agent: 'architect',
			tier: 'swarm',
			emitEvent: false,
		});
		expect(architect.results.map((r) => r.id)).toContain('coder-only');
	});

	it('force-includes a critical directive that matches the context', async () => {
		// Fill with higher-text-score noise so the critical entry would otherwise
		// rank below the result cutoff on text alone.
		for (let i = 0; i < 6; i++) {
			await appendKnowledge(
				kp,
				makeEntry({
					id: `noise-${i}`,
					lesson: `subprocess timeout handling note number ${i}`,
				}),
			);
		}
		await appendKnowledge(
			kp,
			makeEntry({
				id: 'critical',
				lesson: 'unrelated lesson text that will not match the query well',
				directive_priority: 'critical',
				triggers: ['deleting files'],
			}),
		);

		const { results } = await searchKnowledge({
			directory: dir,
			config,
			query: 'subprocess timeout handling note',
			context: {
				currentAction: 'deleting files from the repo',
				currentPhase: 'Phase 1',
			},
			mode: 'auto_injection',
			agent: 'architect',
			tier: 'swarm',
			maxResults: 5,
			emitEvent: false,
		});
		expect(results.map((r) => r.id)).toContain('critical');
	});

	it('does not emit an event when emitEvent is false', async () => {
		await appendKnowledge(
			kp,
			makeEntry({ id: 'k', lesson: 'a lesson here ok' }),
		);
		await searchKnowledge({
			directory: dir,
			config,
			query: 'lesson here',
			mode: 'manual',
			tier: 'swarm',
			emitEvent: false,
		});
		expect(await readKnowledgeEvents(dir)).toHaveLength(0);
	});

	// ----- regression fixes surfaced by independent review -----

	it('applyScopeFilter:false surfaces non-global-scoped entries (recall regression fix)', async () => {
		await appendKnowledge(
			kp,
			makeEntry({
				id: 'stack',
				lesson: 'stack scoped lesson about migrations here',
				scope: 'stack:postgres',
			}),
		);
		// Default (scope-filtered) drops the stack-scoped entry.
		const filtered = await searchKnowledge({
			directory: dir,
			config,
			query: 'scoped lesson about migrations',
			mode: 'auto_injection',
			tier: 'swarm',
			emitEvent: false,
		});
		expect(filtered.results.map((r) => r.id)).not.toContain('stack');
		// Manual recall opts out and surfaces it.
		const open = await searchKnowledge({
			directory: dir,
			config,
			query: 'scoped lesson about migrations',
			mode: 'manual',
			tier: 'swarm',
			applyScopeFilter: false,
			emitEvent: false,
		});
		expect(open.results.map((r) => r.id)).toContain('stack');
	});

	it('forceReadHive:true reads hive even when config.hive_enabled is false (recall regression fix)', async () => {
		const hivePath = resolveHiveKnowledgePath();
		const hiveEntry: HiveKnowledgeEntry = {
			id: 'hive1',
			tier: 'hive',
			lesson: 'hive lesson about caching strategies here',
			category: 'performance',
			tags: [],
			scope: 'global',
			confidence: 0.7,
			status: 'promoted',
			confirmed_by: [],
			source_project: 'other',
			encounter_score: 1,
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: 2,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};
		await appendKnowledge(hivePath, hiveEntry);
		const hiveDisabled = { ...config, hive_enabled: false };

		// With hive_enabled:false and no force, hive is hidden.
		const hidden = await searchKnowledge({
			directory: dir,
			config: hiveDisabled,
			query: 'lesson about caching',
			mode: 'auto_injection',
			tier: 'all',
			emitEvent: false,
		});
		expect(hidden.results.map((r) => r.id)).not.toContain('hive1');

		// Manual recall forces the hive read.
		const forced = await searchKnowledge({
			directory: dir,
			config: hiveDisabled,
			query: 'lesson about caching',
			mode: 'manual',
			tier: 'all',
			forceReadHive: true,
			applyScopeFilter: false,
			applyRoleScope: false,
			emitEvent: false,
		});
		expect(forced.results.map((r) => r.id)).toContain('hive1');
	});

	it('applyRoleScope:false does not role-gate role-scoped entries (recall regression fix)', async () => {
		await appendKnowledge(
			kp,
			makeEntry({
				id: 'coder-only',
				lesson: 'coder guidance about imports and modules',
				applies_to_agents: ['coder'],
			}),
		);
		// A reviewer with role scoping ON would not see it.
		const scoped = await searchKnowledge({
			directory: dir,
			config,
			query: 'guidance about imports',
			mode: 'review_context',
			agent: 'reviewer',
			tier: 'swarm',
			emitEvent: false,
		});
		expect(scoped.results.map((r) => r.id)).not.toContain('coder-only');
		// Manual recall opts out → returns it regardless of caller role.
		const open = await searchKnowledge({
			directory: dir,
			config,
			query: 'guidance about imports',
			mode: 'manual',
			agent: 'reviewer',
			tier: 'swarm',
			applyRoleScope: false,
			emitEvent: false,
		});
		expect(open.results.map((r) => r.id)).toContain('coder-only');
	});

	it('manual recall blends confidence into ranking (intended hybrid behavior, not pure Jaccard)', async () => {
		// Two entries with near-equal text relevance to the query but very
		// different confidence. The unified hybrid score adds 0.4*metaScore (which
		// includes confidence), so the high-confidence entry ranks first — whereas
		// the pre-unification pure-Jaccard recall would have treated them as ~tied.
		// This test locks the deliberate post-unification ranking behavior.
		await appendKnowledge(
			kp,
			makeEntry({
				id: 'lowconf',
				lesson: 'database migration safety checklist for releases',
				confidence: 0.3,
			}),
		);
		await appendKnowledge(
			kp,
			makeEntry({
				id: 'highconf',
				lesson: 'database migration safety guidelines for rollbacks',
				confidence: 0.95,
			}),
		);
		const { results } = await searchKnowledge({
			directory: dir,
			config,
			query: 'database migration safety',
			mode: 'manual',
			tier: 'swarm',
			applyScopeFilter: false,
			applyRoleScope: false,
			emitEvent: false,
		});
		expect(results.map((r) => r.id)).toEqual(['highconf', 'lowconf']);
	});

	it('survives a malformed entry mixed with valid ones (no drop-all)', async () => {
		await appendKnowledge(
			kp,
			makeEntry({ id: 'valid', lesson: 'valid lesson about testing retries' }),
		);
		// Write a malformed entry directly (numeric lesson, missing tags).
		const { writeFileSync } = await import('node:fs');
		writeFileSync(
			kp,
			`${JSON.stringify({
				id: 'bad',
				tier: 'swarm',
				lesson: 999,
				scope: 'global',
				confidence: 0.5,
				status: 'candidate',
				confirmed_by: [],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
				project_name: 'p',
			})}\n`,
			{ flag: 'a' },
		);
		const { results } = await searchKnowledge({
			directory: dir,
			config,
			query: 'valid lesson about testing',
			mode: 'manual',
			tier: 'swarm',
			applyScopeFilter: false,
			emitEvent: false,
		});
		// The valid entry must survive the malformed neighbor.
		expect(results.map((r) => r.id)).toContain('valid');
	});
});
