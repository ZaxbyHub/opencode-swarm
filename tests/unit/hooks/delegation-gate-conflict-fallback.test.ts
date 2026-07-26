/**
 * #1674 v8 gate-level automatic-fallback tests.
 *
 * Verifies that `buildParallelExecutionGuidance` and the gate's
 * `parallelModeActive` computation enforce SERIAL when the active phase's
 * pending tasks are NOT provably file-disjoint (overlapping or unknown scopes),
 * and PERMIT parallel only when they ARE disjoint. This is acceptance
 * criterion 4 ("overlapping/unknown scopes → serial by default") — enforced by
 * the harness, not advisory.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _internals } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { writeDisjointScopes } from './_delegation-gate-helpers';

const { buildParallelExecutionGuidance } = _internals;

let tempDir: string;
let swarmDir: string;

beforeEach(() => {
	resetSwarmState();
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'v8-conflict-fallback-')),
	);
	swarmDir = path.join(tempDir, '.swarm');
	fs.mkdirSync(swarmDir, { recursive: true });
});

afterEach(() => {
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
	resetSwarmState();
});

function writePlan(opts: {
	parallelizationEnabled?: boolean;
	maxConcurrent?: number;
	tasks: Array<{ id: string; status?: string }>;
}): void {
	const plan = {
		schema_version: '1.0.0',
		title: 'Conflict Fallback Plan',
		swarm: 'test',
		current_phase: 1,
		execution_profile: {
			parallelization_enabled: opts.parallelizationEnabled ?? true,
			max_concurrent_tasks: opts.maxConcurrent ?? 4,
		},
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: opts.tasks.map((t) => ({
					id: t.id,
					phase: 1,
					status: t.status ?? 'pending',
					size: 'small',
					description: `Task ${t.id}`,
					depends: [],
					files_touched: [],
				})),
			},
		],
	};
	fs.writeFileSync(
		path.join(swarmDir, 'plan.json'),
		JSON.stringify(plan),
		'utf-8',
	);
}

function writeOverlappingScopes(ids: string[]): void {
	// Give every task the SAME file so they all path-conflict.
	const scopesDir = path.join(swarmDir, 'scopes');
	fs.mkdirSync(scopesDir, { recursive: true });
	for (const id of ids) {
		fs.writeFileSync(
			path.join(scopesDir, `scope-${id}.json`),
			JSON.stringify({
				taskId: id,
				files: ['src/shared.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			}),
			'utf-8',
		);
	}
}

function sessionId(): string {
	const id = `v8-fallback-${Math.random().toString(36).slice(2, 8)}`;
	ensureAgentSession(id);
	return id;
}

describe('buildParallelExecutionGuidance — v8 automatic serial fallback', () => {
	it('emits SERIAL-fallback message when pending tasks have overlapping scopes', async () => {
		const sid = sessionId();
		writePlan({ tasks: [{ id: '1.1' }, { id: '1.2' }] });
		writeOverlappingScopes(['1.1', '1.2']);

		const result = await buildParallelExecutionGuidance(
			tempDir,
			sid,
			swarmState.agentSessions.get(sid)!,
		);

		expect(result).toContain('SERIAL fallback active');
		expect(result).toContain('plan_conflict_check');
		expect(result).not.toContain('Eligible now');
	});

	it('emits SERIAL-fallback message when a pending task has no declared scope (unknown)', async () => {
		const sid = sessionId();
		writePlan({ tasks: [{ id: '1.1' }, { id: '1.2' }] });
		// Write a scope for 1.1 only — 1.2 is unknown.
		writeDisjointScopes(tempDir, ['1.1']);

		const result = await buildParallelExecutionGuidance(
			tempDir,
			sid,
			swarmState.agentSessions.get(sid)!,
		);

		expect(result).toContain('SERIAL fallback active');
	});

	it('emits SERIAL-fallback message when only one pending task exists (nothing to parallelize)', async () => {
		const sid = sessionId();
		writePlan({ tasks: [{ id: '1.1' }] });
		writeDisjointScopes(tempDir, ['1.1']);

		const result = await buildParallelExecutionGuidance(
			tempDir,
			sid,
			swarmState.agentSessions.get(sid)!,
		);

		expect(result).toContain('SERIAL fallback active');
	});

	it('emits parallel guidance when ≥2 pending tasks are disjoint', async () => {
		const sid = sessionId();
		writePlan({ tasks: [{ id: '1.1' }, { id: '1.2' }] });
		writeDisjointScopes(tempDir, ['1.1', '1.2']);

		const result = await buildParallelExecutionGuidance(
			tempDir,
			sid,
			swarmState.agentSessions.get(sid)!,
		);

		expect(result).toContain('PARALLEL EXECUTION PROFILE');
		expect(result).toContain('Eligible now: 1.1, 1.2');
		expect(result).not.toContain('SERIAL fallback active');
	});

	it('emits serial guidance (null) when parallelization_enabled is false', async () => {
		const sid = sessionId();
		writePlan({
			parallelizationEnabled: false,
			tasks: [{ id: '1.1' }, { id: '1.2' }],
		});
		writeDisjointScopes(tempDir, ['1.1', '1.2']);

		const result = await buildParallelExecutionGuidance(
			tempDir,
			sid,
			swarmState.agentSessions.get(sid)!,
		);

		// Flag-gated to off → returns null (no parallel guidance at all).
		expect(result).toBeNull();
	});

	it('fail-safe: returns serial-fallback when scope computation cannot proceed (no plan on disk)', async () => {
		const sid = sessionId();
		// No plan.json written at all → loadPlanJsonOnly returns null →
		// buildParallelExecutionGuidance returns null (no guidance), which is
		// the existing fail-open-serial behavior.
		const result = await buildParallelExecutionGuidance(
			tempDir,
			sid,
			swarmState.agentSessions.get(sid)!,
		);
		expect(result).toBeNull();
	});
});
