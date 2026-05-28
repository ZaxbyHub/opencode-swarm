import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendKnowledgeEvent } from '../../../src/hooks/knowledge-events';
import {
	appendKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import {
	checkKnowledgeHealth,
	computeKnowledgeDebug,
} from '../../../src/services/knowledge-diagnostics';

function makeEntry(
	id: string,
	status: SwarmKnowledgeEntry['status'] = 'candidate',
): SwarmKnowledgeEntry {
	return {
		id,
		tier: 'swarm',
		lesson: `Lesson ${id} with enough characters to count`,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.5,
		status,
		confirmed_by: [],
		project_name: 'test',
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
			shown_count: 0,
			applied_explicit_count: 0,
			ignored_count: 0,
		},
		schema_version: 2,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	};
}

describe('knowledge-diagnostics', () => {
	let dir: string;
	let kp: string;
	let prevXdgData: string | undefined;
	beforeEach(() => {
		dir = join(
			tmpdir(),
			`swarm-diag-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(dir, { recursive: true });
		kp = resolveSwarmKnowledgePath(dir);
		// Isolate the global hive path to an empty temp location so the status
		// breakdown is deterministic.
		prevXdgData = process.env.XDG_DATA_HOME;
		process.env.XDG_DATA_HOME = join(dir, 'xdg-data');
	});
	afterEach(() => {
		if (prevXdgData === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = prevXdgData;
		rmSync(dir, { recursive: true, force: true });
	});

	it('reports resolved paths and a status breakdown', async () => {
		await appendKnowledge(kp, makeEntry('a', 'candidate'));
		await appendKnowledge(kp, makeEntry('b', 'archived'));
		await appendKnowledge(kp, makeEntry('c', 'quarantined'));

		const debug = await computeKnowledgeDebug(dir);
		expect(debug.swarm_path).toBe(kp);
		expect(debug.events_path).toContain('knowledge-events.jsonl');
		expect(debug.plugin_version).toBeTruthy();
		expect(debug.status_breakdown.active).toBe(1);
		expect(debug.status_breakdown.archived).toBe(1);
		expect(debug.status_breakdown.quarantined).toBe(1);
		expect(debug.schema_versions['2']).toBe(3);
	});

	it('counts events and retrievals in the last 7 days', async () => {
		await appendKnowledgeEvent(dir, {
			type: 'retrieved',
			trace_id: 't',
			session_id: 's',
			agent: 'architect',
			query: 'q',
			retrieval_mode: 'manual',
			result_ids: [],
			ranks: {},
			scores: {},
		});
		// An old retrieval (>7d) should not count toward retrieval_events_7d.
		await appendKnowledgeEvent(dir, {
			type: 'retrieved',
			trace_id: 't2',
			timestamp: '2000-01-01T00:00:00.000Z',
			session_id: 's',
			agent: 'architect',
			query: 'q',
			retrieval_mode: 'manual',
			result_ids: [],
			ranks: {},
			scores: {},
		});
		const debug = await computeKnowledgeDebug(dir);
		expect(debug.event_count).toBe(2);
		expect(debug.retrieval_events_7d).toBe(1);
	});

	it('flags corrupt lines as a raw-vs-normalized mismatch', async () => {
		await appendKnowledge(kp, makeEntry('a'));
		writeFileSync(kp, `${'{ not json'}\n`, { flag: 'a' });
		const debug = await computeKnowledgeDebug(dir);
		expect(debug.corrupt_line_count).toBe(1);
		expect(debug.raw_entry_count).toBe(1);

		const health = await checkKnowledgeHealth(dir);
		expect(health.status).toBe('⚠️');
		expect(health.detail).toContain('corrupt');
	});

	it('flags entries missing v2 counters', async () => {
		// A legacy entry whose on-disk retrieval_outcomes lacks v2 counters.
		const legacy = {
			id: 'legacy',
			tier: 'swarm',
			lesson: 'legacy lesson with enough characters here',
			category: 'process',
			tags: [],
			scope: 'global',
			confidence: 0.5,
			status: 'candidate',
			confirmed_by: [],
			project_name: 'p',
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};
		mkdirSync(join(dir, '.swarm'), { recursive: true });
		writeFileSync(kp, `${JSON.stringify(legacy)}\n`, 'utf-8');
		const debug = await computeKnowledgeDebug(dir);
		expect(debug.entries_missing_v2_counters).toBe(1);
		const health = await checkKnowledgeHealth(dir);
		expect(health.status).toBe('⚠️');
		expect(health.detail).toContain('v2 counters');
	});

	it('reports healthy when the store is clean', async () => {
		await appendKnowledge(kp, makeEntry('a'));
		const health = await checkKnowledgeHealth(dir);
		expect(health.status).toBe('✅');
		expect(health.name).toBe('Knowledge health');
	});
});
