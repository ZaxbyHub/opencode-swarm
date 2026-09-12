/**
 * #1674 v8 gate-level automatic-fallback tests.
 *
 * Verifies that `buildParallelExecutionGuidance` and the gate's
 * `parallelModeActive` computation enforce SERIAL when the active phase's
 * pending tasks are NOT provably file-disjoint (overlapping or unknown scopes),
 * and PERMIT parallel only when they ARE disjoint. This is acceptance
 * criterion 4 ("overlapping/unknown scopes → serial by default") — enforced by
 * the harness, not advisory.
 *
 * #2532: scopes are declared through the REGISTERED declare_scope tool (the
 * authoritative v2 binding store); the fallback message carries the exact
 * reason (which tasks lack a declaration, or which pair overlaps on what).
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
import { executeDeclareScope } from '../../../src/tools/declare-scope';

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

/** Declare scopes through the registered v2 authority (#2532). */
async function declareScopes(
	entries: Array<{ id: string; files: string[] }>,
): Promise<void> {
	for (const entry of entries) {
		const result = await executeDeclareScope(
			{ taskId: entry.id, files: entry.files, working_directory: tempDir },
			tempDir,
			{ sessionID: 'v8-fallback-architect', messageID: `m-${entry.id}` },
		);
		expect(result.success).toBe(true);
	}
}

function sessionId(): string {
	const id = `v8-fallback-${Math.random().toString(36).slice(2, 8)}`;
	ensureAgentSession(id);
	return id;
}

describe('buildParallelExecutionGuidance — v8 automatic serial fallback', () => {
	it('emits SERIAL-fallback with overlap evidence when declared scopes conflict', async () => {
		const sid = sessionId();
		writePlan({ tasks: [{ id: '1.1' }, { id: '1.2' }] });
		// Give every task the SAME file so they path-conflict.
		await declareScopes([
			{ id: '1.1', files: ['src/shared.ts'] },
			{ id: '1.2', files: ['src/shared.ts'] },
		]);

		const result = await buildParallelExecutionGuidance(
			tempDir,
			sid,
			swarmState.agentSessions.get(sid)!,
		);

		expect(result).toContain('SERIAL fallback active');
		// #2532 AC7: the exact reason names the conflicting pair and the path.
		expect(result).toContain('exact reason: declared scopes overlap');
		expect(result).toContain('1.1');
		expect(result).toContain('1.2');
		expect(result).toContain('src/shared.ts');
		expect(result).toContain('plan_conflict_check');
		expect(result).not.toContain('Eligible now');
	});

	it('emits SERIAL-fallback naming the undeclared task when a scope is missing (unknown)', async () => {
		const sid = sessionId();
		writePlan({ tasks: [{ id: '1.1' }, { id: '1.2' }] });
		// Declare 1.1 only — 1.2 is unknown.
		await declareScopes([{ id: '1.1', files: ['src/a.ts'] }]);

		const result = await buildParallelExecutionGuidance(
			tempDir,
			sid,
			swarmState.agentSessions.get(sid)!,
		);

		expect(result).toContain('SERIAL fallback active');
		// #2532 AC7: the exact reason distinguishes UNKNOWN from overlap.
		expect(result).toContain('no live declared scope');
		expect(result).toContain('1.2');
		expect(result).not.toContain('declared scopes overlap');
	});

	it('emits SERIAL-fallback when only one pending task exists (nothing to parallelize)', async () => {
		const sid = sessionId();
		writePlan({ tasks: [{ id: '1.1' }] });
		await declareScopes([{ id: '1.1', files: ['src/a.ts'] }]);

		const result = await buildParallelExecutionGuidance(
			tempDir,
			sid,
			swarmState.agentSessions.get(sid)!,
		);

		expect(result).toContain('SERIAL fallback active');
		expect(result).toContain('nothing to parallelize');
	});

	it('emits parallel guidance when ≥2 pending tasks are disjoint', async () => {
		const sid = sessionId();
		writePlan({ tasks: [{ id: '1.1' }, { id: '1.2' }] });
		await declareScopes([
			{ id: '1.1', files: ['src/a.ts'] },
			{ id: '1.2', files: ['src/b.ts'] },
		]);

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
		await declareScopes([
			{ id: '1.1', files: ['src/a.ts'] },
			{ id: '1.2', files: ['src/b.ts'] },
		]);

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
