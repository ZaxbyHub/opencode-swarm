/**
 * Cold-start exploration bonus (Change 5 / Task 6.2).
 *
 * A never-applied, still-young entry receives a small ranking lift so fresh
 * directives get a chance to surface. The bonus disappears once the entry has
 * been applied OR has aged past `cold_start_max_age_phases` confirming phases.
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
import {
	_internals,
	searchKnowledge,
} from '../../../src/hooks/search-knowledge';

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

describe('entryAgePhases', () => {
	it('counts distinct confirming phases, 0 for none', () => {
		expect(_internals.entryAgePhases({})).toBe(0);
		expect(_internals.entryAgePhases({ confirmed_by: [] })).toBe(0);
		expect(
			_internals.entryAgePhases({
				confirmed_by: [{ phase_number: 1 }, { phase_number: 1 }],
			}),
		).toBe(1);
		expect(
			_internals.entryAgePhases({
				confirmed_by: [{ phase_number: 1 }, { phase_number: 2 }],
			}),
		).toBe(2);
	});
});

describe('cold-start exploration bonus (Task 6.2)', () => {
	let dir: string;
	let kp: string;
	let prevXdg: string | undefined;
	const query = 'run full test suite before phase complete';
	const base = {
		id: 'entry',
		lesson: 'run the full test suite before declaring a phase complete',
	};
	const call = () =>
		searchKnowledge({
			directory: dir,
			config,
			query,
			mode: 'manual' as const,
			tier: 'swarm' as const,
			applyScopeFilter: false,
			applyRoleScope: false,
			emitEvent: false,
		});

	beforeEach(() => {
		dir = join(tmpdir(), `swarm-cold-${Date.now()}-${Math.random()}`);
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

	async function scoreFor(entry: SwarmKnowledgeEntry): Promise<number> {
		rmSync(kp, { force: true });
		await appendKnowledge(kp, entry);
		const { results } = await call();
		const s = results.find((r) => r.id === 'entry')?.finalScore;
		expect(s).toBeDefined();
		return s as number;
	}

	it('lifts a never-applied young entry above an applied one', async () => {
		const cold = await scoreFor(makeEntry({ ...base }));
		const applied = await scoreFor(
			makeEntry({
				...base,
				retrieval_outcomes: {
					applied_count: 4,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
			}),
		);
		expect(cold).toBeGreaterThan(applied);
		expect(cold - applied).toBeCloseTo(0.08, 5);
	});

	it('withholds the bonus once the entry has aged past the phase window', async () => {
		const cold = await scoreFor(makeEntry({ ...base }));
		const aged = await scoreFor(
			makeEntry({
				...base,
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2024-01-01T00:00:00.000Z',
						project_name: 'test',
					},
					{
						phase_number: 2,
						confirmed_at: '2024-01-02T00:00:00.000Z',
						project_name: 'test',
					},
					{
						phase_number: 3,
						confirmed_at: '2024-01-03T00:00:00.000Z',
						project_name: 'test',
					},
				],
			}),
		);
		expect(cold).toBeGreaterThan(aged);
		// confirmed_by count does not feed the metadata score, so the gap is the
		// cold-start bonus alone.
		expect(cold - aged).toBeCloseTo(0.08, 5);
	});
});
