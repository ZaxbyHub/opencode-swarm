/**
 * Issue #3380: a reviewer/test_engineer dispatch whose route-receipt
 * PERSISTENCE fails must not silently skip the dispatch-time gates below the
 * routing block (ACCEPTANCE for coder/reviewer, TASK_GATE_AGENTS).
 *
 * Persist failures are forced deterministically:
 *  - reviewer legs: the fixture's `.swarm` is a plain FILE, so
 *    persistReviewRouteReceipt's mkdir throws ENOTDIR before
 *    routeDispatchStarted is set;
 *  - test_engineer legs: `.swarm/pr-review` is a plain FILE (plan.json stays
 *    readable), same throw site.
 *
 * Stage-B advancement stays fail-closed on the missing receipt under the
 * default `review_routing.enforce_receipts: true` — that is the routing
 * block's documented design and is what makes failing LOCALLY (routing
 * bookkeeping) safe. With `enforce_receipts: false` the fall-through is
 * unconditionally correct: the dispatch-time gates still run and there is no
 * receipt requirement to fail closed on (config-rollback surface; no code
 * path changes, so it is documented here rather than separately tested).
 *
 * Env isolation: createIsolatedTestEnv redirects the hive/app-data roots the
 * route-receipt MAC secret lives under (LOCALAPPDATA / XDG data) so the
 * tests neither read nor write the developer's real app-data.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function makeConfig(): PluginConfig {
	return {
		hooks: { delegation_gate: true },
	} as unknown as PluginConfig;
}

function writePlan(dir: string): void {
	const plan = {
		schema_version: '1.0.0',
		title: 'Route persist failure fixture',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Exercise the gates',
						depends: [],
						files_touched: ['src/foo.ts'],
					},
				],
			},
		],
	};
	fs.writeFileSync(path.join(dir, '.swarm', 'plan.json'), JSON.stringify(plan));
}

/** Reviewer fixture: `.swarm` as a plain FILE breaks the FIRST persist. */
function reviewerDir(persistFails: boolean): string {
	const dir = canonicalMkdtemp('route-persist-3495-');
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	if (persistFails) {
		fs.writeFileSync(path.join(dir, '.swarm'), 'not a directory');
	} else {
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	}
	return dir;
}

/** test_engineer fixture: `.swarm/pr-review` as a plain FILE keeps plan.json
 *  readable while breaking the receipt parent mkdir. */
function testEngineerDir(persistFails: boolean): string {
	const dir = canonicalMkdtemp('route-persist-3495-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	writePlan(dir);
	if (persistFails) {
		fs.writeFileSync(path.join(dir, '.swarm', 'pr-review'), 'not a directory');
	}
	return dir;
}

describe('review/test_engineer route-receipt persist failure (#3380)', () => {
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;
	const dirs: string[] = [];

	beforeEach(() => {
		isolatedEnv = createIsolatedTestEnv();
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
		for (const dir of dirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		isolatedEnv?.cleanup();
		isolatedEnv = undefined;
	});

	function dispatch(
		dir: string,
		sessionID: string,
		args: { subagent_type: string; prompt: string },
	): Promise<unknown> {
		const hooks = createDelegationGateHook(makeConfig(), dir);
		ensureAgentSession(sessionID, 'architect');
		return hooks.toolBefore(
			{ tool: 'Task', sessionID, callID: 'call-1' },
			{ args },
		);
	}

	it('reviewer without ACCEPTANCE is still rejected when receipt persistence fails', async () => {
		const dir = reviewerDir(true);
		dirs.push(dir);
		await expect(
			dispatch(dir, 'sess-rf-reviewer', {
				subagent_type: 'reviewer',
				prompt: 'TASK: review it',
			}),
		).rejects.toThrow('ACCEPTANCE_FIELD_REQUIRED');
	});

	it('reviewer with ACCEPTANCE resolves even when receipt persistence fails (gates ran, none reject)', async () => {
		const dir = reviewerDir(true);
		dirs.push(dir);
		await expect(
			dispatch(dir, 'sess-rf-reviewer-ok', {
				subagent_type: 'reviewer',
				prompt:
					'TASK: review it\nACCEPTANCE: FR-001 the diff satisfies the requirement',
			}),
		).resolves.toBeUndefined();
	});

	it('reviewer without ACCEPTANCE rejects on the writable control fixture (persist OK)', async () => {
		const dir = reviewerDir(false);
		dirs.push(dir);
		await expect(
			dispatch(dir, 'sess-rf-ctl', {
				subagent_type: 'reviewer',
				prompt: 'TASK: review it',
			}),
		).rejects.toThrow('ACCEPTANCE_FIELD_REQUIRED');
	});

	it('reviewer with ACCEPTANCE resolves on the writable control fixture', async () => {
		const dir = reviewerDir(false);
		dirs.push(dir);
		await expect(
			dispatch(dir, 'sess-rf-ctl-ok', {
				subagent_type: 'reviewer',
				prompt:
					'TASK: review it\nACCEPTANCE: FR-001 the diff satisfies the requirement',
			}),
		).resolves.toBeUndefined();
	});

	it('test_engineer under a plan workflow is still TASK-gate refused when persistence fails', async () => {
		const dir = testEngineerDir(true);
		dirs.push(dir);
		await expect(
			dispatch(dir, 'sess-rf-te', {
				subagent_type: 'test_engineer',
				prompt: 'TASK: 1.1 verify the change',
			}),
		).rejects.toThrow('TASK_WORKFLOW_');
	});

	it('test_engineer control (persist OK) refuses with the same TASK gate class', async () => {
		const dir = testEngineerDir(false);
		dirs.push(dir);
		await expect(
			dispatch(dir, 'sess-rf-te-ctl', {
				subagent_type: 'test_engineer',
				prompt: 'TASK: 1.1 verify the change',
			}),
		).rejects.toThrow('TASK_WORKFLOW_');
	});
});
