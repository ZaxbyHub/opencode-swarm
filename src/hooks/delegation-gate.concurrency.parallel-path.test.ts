/**
 * v8 parallel-path guidance tests extracted from delegation-gate.concurrency
 * (#2532): these drive `buildParallelExecutionGuidance` against a REAL
 * plan.json plus v2 scope declarations (no loadPlanJsonOnly mock — the
 * guidance and the verdict read the same seeded plan), keeping the original
 * over-cap file from growing (FR-006).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir';
import { type Plan, PlanSchema } from '../config/plan-schema';
import { ensureAgentSession, resetSwarmState, swarmState } from '../state';
import { executeDeclareScope } from '../tools/declare-scope';
import { _internals } from './delegation-gate';

const { buildParallelExecutionGuidance } = _internals;

const PARALLEL_PLAN_IDS = ['1.1', '1.2', '1.3', '1.4'];

let realDir: string;

/**
 * Seed a REAL plan.json plus v2 scope declarations (through the registered
 * declare_scope tool) so the guidance reaches the PARALLEL path — the verdict
 * resolves the authoritative binding store against this exact plan identity
 * (#2532). The legacy v1 scope-<taskId>.json projection is never written.
 */
async function seedParallelPlan(
	dir: string,
	profile: { max_concurrent_tasks: number },
	taskSpecs?: Array<{ id: string; status: string; blocked_reason?: string }>,
): Promise<void> {
	const specs =
		taskSpecs ??
		PARALLEL_PLAN_IDS.map((id) => ({ id, status: 'pending' as const }));
	const parsed = PlanSchema.parse({
		schema_version: '1.0.0',
		title: 'Test Project',
		swarm: 'mega',
		current_phase: 1,
		migration_status: 'native',
		execution_profile: {
			parallelization_enabled: true,
			max_concurrent_tasks: profile.max_concurrent_tasks,
		},
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: specs.map((spec) => ({
					id: spec.id,
					phase: 1,
					status: spec.status,
					size: 'small',
					description: `Task ${spec.id}`,
					depends: [],
					...(spec.blocked_reason
						? { blocked_reason: spec.blocked_reason }
						: {}),
				})),
			},
		],
	});
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(parsed),
		'utf-8',
	);
	for (const spec of specs) {
		if (spec.status !== 'pending') continue; // verdict covers pending tasks only
		const declared = await executeDeclareScope(
			{
				taskId: spec.id,
				files: [`src/task-${spec.id.replace(/\./g, '-')}.ts`],
				working_directory: dir,
			},
			dir,
			{ sessionID: 'concurrency-test-architect', messageID: `m-${spec.id}` },
		);
		if (!declared.success) {
			throw new Error(
				`declare_scope failed for ${spec.id}: ${declared.message}`,
			);
		}
	}
}

function sessionId(): string {
	const id = `parallel-path-${Math.random().toString(36).slice(2, 8)}`;
	ensureAgentSession(id);
	return id;
}

async function guidanceFor(
	sid: string,
	overrides?: Record<string, unknown>,
): Promise<string | null> {
	const session = swarmState.agentSessions.get(sid)!;
	Object.assign(session, overrides);
	return buildParallelExecutionGuidance(realDir, sid, session);
}

beforeEach(() => {
	resetSwarmState();
	realDir = canonicalMkdtemp('concurrency-parallel-path-');
});

afterEach(() => {
	resetSwarmState();
	try {
		fs.rmSync(realDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('buildParallelExecutionGuidance — parallel path with v2 scopes (#2532)', () => {
	it('session override takes precedence over plan baseline max_concurrent_tasks', async () => {
		await seedParallelPlan(realDir, { max_concurrent_tasks: 2 });
		const result = await guidanceFor(sessionId(), {
			maxConcurrencyOverride: 5,
		});
		expect(result).toContain('Eligible now:');
		expect(result).toContain('max_concurrent_tasks=5');
		expect(result).not.toContain('max_concurrent_tasks=2');
	});

	it('plan baseline is used when no session override is set', async () => {
		await seedParallelPlan(realDir, { max_concurrent_tasks: 2 });
		const result = await guidanceFor(sessionId());
		expect(result).toContain('Eligible now:');
		expect(result).toContain('max_concurrent_tasks=2');
	});

	it('override value higher than plan is reflected in the profile line', async () => {
		await seedParallelPlan(realDir, { max_concurrent_tasks: 3 });
		const result = await guidanceFor(sessionId(), {
			maxConcurrencyOverride: 4,
		});
		expect(result).toContain('PARALLEL EXECUTION PROFILE');
		expect(result).toContain('Eligible now:');
		expect(result).toContain('max_concurrent_tasks=4');
		expect(result).not.toContain('max_concurrent_tasks=3');
	});

	it('override value lower than plan is used when set', async () => {
		await seedParallelPlan(realDir, { max_concurrent_tasks: 8 });
		const result = await guidanceFor(sessionId(), {
			maxConcurrencyOverride: 2,
		});
		expect(result).toContain('Eligible now:');
		expect(result).toContain('max_concurrent_tasks=2');
		expect(result).not.toContain('max_concurrent_tasks=8');
	});

	it('adaptive backoff reduces concurrency when >20% of tasks are blocked', async () => {
		await seedParallelPlan(realDir, { max_concurrent_tasks: 10 }, [
			{ id: '1.1', status: 'pending' },
			{
				id: '1.2',
				status: 'blocked',
				blocked_reason: 'Failed during execution',
			},
			{
				id: '1.3',
				status: 'blocked',
				blocked_reason: 'Failed during execution',
			},
			{ id: '1.4', status: 'pending' },
			{ id: '1.5', status: 'pending' },
		]);
		const sid = sessionId();
		const session = swarmState.agentSessions.get(sid)!;
		expect(session.maxConcurrencyOverride).toBeUndefined();
		const result = await buildParallelExecutionGuidance(realDir, sid, session);
		// 2 blocked of 5 tasks = 40% failure rate > 20% threshold → halved (10 → 5).
		expect(session.maxConcurrencyOverride).toBe(5);
		expect(result).toContain('blocked task(s) detected');
		expect(result).toContain('max_concurrent_tasks=5');
	});
});
