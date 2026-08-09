/**
 * Hot-path safety and end-to-end retrieval (issue #1821, Workstream B, Task 5).
 *
 * `realtimeAdmissionAfter` is awaited on EVERY tool call, so the non-`Task`
 * path must cost a single string comparison: no knowledge-store read, no write,
 * and above all no directory-lock acquisition. The integration test at the
 * bottom proves the other half — that a lesson admitted mid-session is actually
 * retrievable by the very next delegate.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KnowledgeConfigSchema } from '../../../src/config/schema.js';
import {
	bumpKnowledgeGeneration,
	getKnowledgeGeneration,
	injectForDelegate,
} from '../../../src/hooks/knowledge-injector.js';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store.js';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types.js';
import type { InsightCandidate } from '../../../src/hooks/micro-reflector.js';
import { isTaskTool } from '../../../src/hooks/micro-reflector.js';
import {
	admitCandidate,
	realtimeAdmissionAfter,
} from '../../../src/learning/admission.js';
import {
	enqueueCandidate,
	getQueueDepth,
	resetSessionQueue,
} from '../../../src/learning/candidate-queue.js';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const knowledgeConfig = KnowledgeConfigSchema.parse({});

function admissionConfig(overrides: Record<string, unknown> = {}) {
	return {
		enabled: true,
		max_queue_size: 50,
		min_drain: 1,
		max_drain: 10,
		drain_depth_factor: 0.5,
		drain_velocity_factor: 0.25,
		max_llm_calls_per_session: 20,
		max_tokens_per_session: 50_000,
		max_concurrent_admissions: 2,
		max_retries_per_candidate: 1,
		per_candidate_llm_timeout_ms: 60_000,
		max_drain_wall_time_ms: 10_000,
		supersede_nudge: true,
		...overrides,
	};
}

function candidate(lesson: string): InsightCandidate {
	return {
		lesson,
		category: 'testing',
		tags: [],
		applies_to_agents: ['coder'],
		required_actions: ['run the failing test before finishing'],
		source: {
			kind: 'micro_reflection',
			task_id: 't-1',
			agent: 'coder',
			outcome: 'failure_test',
			trajectory_steps: 3,
		},
		created_at: '2026-01-01T00:00:00.000Z',
	};
}

let dir: string;
let envCleanup: () => void;

beforeEach(() => {
	// `injectForDelegate` retrieves `tier: 'all'`, which includes the HIVE tier
	// resolved from the platform config dir. Without this redirect the test would
	// read the developer's real hive knowledge and be non-hermetic.
	envCleanup = createIsolatedTestEnv().cleanup;
	dir = canonicalMkdtemp('admission-hot-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	resetSessionQueue();
});

afterEach(() => {
	resetSessionQueue();
	fs.rmSync(dir, { recursive: true, force: true });
	envCleanup();
});

/** Every filesystem entry created under `.swarm/`, including lock directories. */
function swarmDirListing(): string[] {
	const root = path.join(dir, '.swarm');
	if (!fs.existsSync(root)) return [];
	return fs.readdirSync(root).sort();
}

describe('isTaskTool — the shared self-gate predicate', () => {
	it('matches both casings and nothing else', () => {
		expect(isTaskTool('Task')).toBe(true);
		expect(isTaskTool('task')).toBe(true);
		expect(isTaskTool('bash')).toBe(false);
		expect(isTaskTool('edit')).toBe(false);
		expect(isTaskTool(undefined)).toBe(false);
		expect(isTaskTool(null)).toBe(false);
		expect(isTaskTool(42)).toBe(false);
	});
});

describe('realtimeAdmissionAfter — non-Task calls perform NO store or lock access', () => {
	it('touches nothing for a non-Task tool even with a full queue', async () => {
		// A loaded queue makes this a real test: if the gate were ordered wrong,
		// the drain would fire and write.
		for (let i = 0; i < 5; i++) {
			enqueueCandidate(
				's1',
				candidate(`Lesson ${i} about verifying build output`),
				{
					maxQueueSize: 50,
				},
			);
		}
		const before = swarmDirListing();

		for (const tool of ['bash', 'edit', 'read', 'grep', 'webfetch']) {
			const result = await realtimeAdmissionAfter(
				dir,
				{ tool, sessionID: 's1' },
				admissionConfig(),
				() => {
					throw new Error(
						'resolveDeps must not run on the non-Task path — it loads the plan',
					);
				},
			);
			expect(result).toBeUndefined();
		}

		// No knowledge.jsonl, and no `.lock` directory left behind by
		// proper-lockfile, which is the observable signature of lock acquisition.
		expect(swarmDirListing()).toEqual(before);
		expect(fs.existsSync(resolveSwarmKnowledgePath(dir))).toBe(false);
		// The candidates are untouched, not silently consumed.
		expect(getQueueDepth('s1')).toBe(5);
	});

	it('returns immediately for a Task call with an EMPTY queue (O(1) probe)', async () => {
		const result = await realtimeAdmissionAfter(
			dir,
			{ tool: 'Task', sessionID: 's1' },
			admissionConfig(),
			() => {
				throw new Error('resolveDeps must not run when the queue is empty');
			},
		);
		expect(result).toBeUndefined();
		expect(fs.existsSync(resolveSwarmKnowledgePath(dir))).toBe(false);
	});

	it('returns immediately when the feature is disabled', async () => {
		enqueueCandidate(
			's1',
			candidate('Re-run the failing test before finishing a fix'),
			{
				maxQueueSize: 50,
			},
		);
		const result = await realtimeAdmissionAfter(
			dir,
			{ tool: 'Task', sessionID: 's1' },
			admissionConfig({ enabled: false }),
			() => {
				throw new Error('resolveDeps must not run when admission is disabled');
			},
		);
		expect(result).toBeUndefined();
		expect(getQueueDepth('s1')).toBe(1);
	});

	it('returns immediately when config is absent entirely', async () => {
		enqueueCandidate(
			's1',
			candidate('Re-run the failing test before finishing a fix'),
			{
				maxQueueSize: 50,
			},
		);
		expect(
			await realtimeAdmissionAfter(
				dir,
				{ tool: 'Task', sessionID: 's1' },
				undefined,
				() => {
					throw new Error('resolveDeps must not run without config');
				},
			),
		).toBeUndefined();
	});

	it('returns immediately for a Task call with no usable session id', async () => {
		// Contract assertion, NOT gate isolation: the session-id check is a
		// type-narrowing guard whose behavioural effect coincides with the
		// depth probe (`getQueueDepth` returns 0 for any non-string key, and
		// `enqueueCandidate` refuses an empty session id, so no queue can exist
		// under one). What IS worth pinning is the observable contract below —
		// a bogus session id must not drain another session's queue or write.
		enqueueCandidate(
			'some-other-session',
			candidate('Re-run the failing test before finishing a fix'),
			{ maxQueueSize: 50 },
		);
		for (const sessionID of [undefined, '', 42, null, {}]) {
			expect(
				await realtimeAdmissionAfter(
					dir,
					{ tool: 'Task', sessionID },
					admissionConfig(),
					() => {
						throw new Error('resolveDeps must not run without a session id');
					},
				),
			).toBeUndefined();
		}
		// Nothing was drained or written under the bogus session ids.
		expect(getQueueDepth('some-other-session')).toBe(1);
		expect(fs.existsSync(resolveSwarmKnowledgePath(dir))).toBe(false);
	});

	it('DOES drain for a Task call with a non-empty queue (gate is not vacuous)', async () => {
		enqueueCandidate(
			's1',
			candidate('Re-run the failing test before finishing a fix'),
			{
				maxQueueSize: 50,
			},
		);
		const summary = await realtimeAdmissionAfter(
			dir,
			{ tool: 'Task', sessionID: 's1' },
			admissionConfig(),
			() => ({ knowledgeConfig, projectName: 'proj', phaseNumber: 1 }),
		);
		expect(summary?.admitted).toBe(1);
		expect(fs.existsSync(resolveSwarmKnowledgePath(dir))).toBe(true);
	});
});

describe('knowledge generation counter', () => {
	it('advances monotonically so the architect injection memo invalidates', () => {
		const before = getKnowledgeGeneration();
		const after = bumpKnowledgeGeneration();
		expect(after).toBe(before + 1);
		expect(getKnowledgeGeneration()).toBe(after);
	});

	it('is bumped by an admission that actually changed the store', async () => {
		const before = getKnowledgeGeneration();
		let bumps = 0;
		await admitCandidate(
			dir,
			candidate('Re-run the failing test before declaring a fix complete'),
			{
				knowledgeConfig,
				projectName: 'proj',
				phaseNumber: 1,
				onKnowledgeChanged: () => {
					bumps++;
					bumpKnowledgeGeneration();
				},
			},
		);
		expect(bumps).toBe(1);
		expect(getKnowledgeGeneration()).toBe(before + 1);
	});

	it('is NOT bumped by a rejected admission', async () => {
		let bumps = 0;
		const result = await admitCandidate(
			dir,
			{
				...candidate('A plain prose lesson with no predicate and no scope'),
				applies_to_agents: undefined,
				required_actions: undefined,
			},
			{
				knowledgeConfig,
				projectName: 'proj',
				phaseNumber: 1,
				onKnowledgeChanged: () => {
					bumps++;
				},
			},
		);
		expect(result.outcome).toBe('rejected');
		expect(bumps).toBe(0);
	});
});

describe('integration — admit → delegate → inject', () => {
	it('surfaces a mid-session admitted lesson to the very next delegate', async () => {
		const LESSON =
			'Re-run the failing test file before declaring a fix complete';

		// Nothing to retrieve before admission.
		const before = await injectForDelegate({
			directory: dir,
			agent: 'coder',
			taskTitle: 'fix the failing test',
			sessionId: 's1',
			config: knowledgeConfig,
		});
		expect(before.entries).toHaveLength(0);

		// Real-time admission mid-session.
		enqueueCandidate('s1', candidate(LESSON), { maxQueueSize: 50 });
		const summary = await realtimeAdmissionAfter(
			dir,
			{ tool: 'Task', sessionID: 's1' },
			admissionConfig(),
			() => ({
				knowledgeConfig,
				projectName: 'proj',
				phaseNumber: 1,
				onKnowledgeChanged: bumpKnowledgeGeneration,
			}),
		);
		expect(summary?.admitted).toBe(1);

		const stored =
			(await readKnowledge<SwarmKnowledgeEntry>(
				resolveSwarmKnowledgePath(dir),
			)) ?? [];
		expect(stored).toHaveLength(1);

		// The delegate retrieval path is uncached and `readKnowledge`'s parse cache
		// is invalidated by the atomic write, so the new lesson must be visible
		// immediately — no phase boundary, no process restart.
		const after = await injectForDelegate({
			directory: dir,
			agent: 'coder',
			taskTitle: 'fix the failing test',
			sessionId: 's1',
			config: knowledgeConfig,
		});
		expect(after.entries.length).toBeGreaterThan(0);
		expect(after.entries.map((e) => e.lesson)).toContain(LESSON);
	});
});
