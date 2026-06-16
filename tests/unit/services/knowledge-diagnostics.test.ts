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
import { rebuildSynonymMap } from '../../../src/services/synonym-map';

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
	let prevLocalAppData: string | undefined;
	let prevHome: string | undefined;
	let prevXdgCache: string | undefined;
	beforeEach(() => {
		dir = join(
			tmpdir(),
			`swarm-diag-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(dir, { recursive: true });
		kp = resolveSwarmKnowledgePath(dir);
		// Isolate the global hive path to an empty temp location so the status
		// breakdown is deterministic across platforms. resolveHiveKnowledgePath
		// reads XDG_DATA_HOME (linux), LOCALAPPDATA (win32), and HOME (darwin) —
		// override all three so the test passes on every host.
		prevXdgData = process.env.XDG_DATA_HOME;
		prevLocalAppData = process.env.LOCALAPPDATA;
		prevHome = process.env.HOME;
		// Isolate the version-check cache too. checkKnowledgeHealth's cacheStatus()
		// reads readVersionCache() from XDG_CACHE_HOME (or ~/.cache), which is
		// machine-global state unrelated to this temp knowledge store. On a host
		// whose real cache reports a newer npmLatest than package.json#version, the
		// stale-cache branch would flip a genuinely clean store's health to ⚠️.
		// Point it at an empty temp dir so the cache resolves to null → 'unknown'
		// (not 'stale'), making the "clean store" check deterministic everywhere.
		// Note: os.homedir() does not honor a process.env.HOME override under Bun,
		// so overriding HOME alone is not sufficient to isolate the cache path.
		prevXdgCache = process.env.XDG_CACHE_HOME;
		const isolatedHome = join(dir, 'home');
		mkdirSync(isolatedHome, { recursive: true });
		process.env.XDG_DATA_HOME = join(dir, 'xdg-data');
		process.env.LOCALAPPDATA = join(dir, 'localappdata');
		process.env.HOME = isolatedHome;
		process.env.XDG_CACHE_HOME = join(dir, 'xdg-cache');
	});
	afterEach(() => {
		if (prevXdgData === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = prevXdgData;
		if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
		else process.env.LOCALAPPDATA = prevLocalAppData;
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = prevXdgCache;
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

	it('surfaces learning-loop telemetry (enforcement, queues, synonyms, events)', async () => {
		await appendKnowledge(kp, {
			...makeEntry('enf', 'established'),
			enforcement_mode: 'enforce',
		});
		await appendKnowledge(kp, {
			...makeEntry('esc', 'established'),
			escalation_history: [
				{
					from: 'medium',
					to: 'high',
					reason: 'repeat_violation',
					at: new Date().toISOString(),
				},
			],
		});
		// Curation queues + a learned synonym map + a typed event.
		mkdirSync(join(dir, '.swarm'), { recursive: true });
		writeFileSync(
			join(dir, '.swarm', 'knowledge-unactionable.jsonl'),
			'{"a":1}\n{"b":2}\n',
		);
		writeFileSync(join(dir, '.swarm', 'insight-candidates.jsonl'), '{"c":3}\n');
		await rebuildSynonymMap(dir, [
			{ tags: ['x', 'y'] },
			{ tags: ['x', 'y'] },
			{ tags: ['x', 'y'] },
		]);
		await appendKnowledgeEvent(dir, {
			type: 'applied',
			trace_id: 't',
			knowledge_id: 'enf',
			session_id: 's',
			agent: 'coder',
		});

		const debug = await computeKnowledgeDebug(dir);
		expect(debug.learning.enforced_directives).toBe(1);
		expect(debug.learning.escalated_directives).toBe(1);
		expect(debug.learning.unactionable_queue_depth).toBe(2);
		expect(debug.learning.insight_candidates_pending).toBe(1);
		expect(debug.learning.synonym_pairs).toBe(1);
		expect(debug.learning.events_by_type.applied).toBe(1);

		// A small backlog does NOT flip a healthy store to a warning.
		const health = await checkKnowledgeHealth(dir);
		expect(health.status).toBe('✅');
		expect(health.detail).toContain('enforce=1');
	});

	it('warns when a curation queue backs up (curator not draining)', async () => {
		await appendKnowledge(kp, makeEntry('a', 'established'));
		mkdirSync(join(dir, '.swarm'), { recursive: true });
		const lines = `${Array.from({ length: 101 }, (_, i) =>
			JSON.stringify({ id: i }),
		).join('\n')}\n`;
		writeFileSync(join(dir, '.swarm', 'knowledge-unactionable.jsonl'), lines);

		const health = await checkKnowledgeHealth(dir);
		expect(health.status).toBe('⚠️');
		expect(health.detail).toContain('unactionable queue');
	});
});
