/**
 * Epic v2 C3 (X1) — background non-coder completions reach the Epic residue
 * seam in the completion observer: gated synchronously on the epic sentinel
 * (no open epic ⇒ the residue function is never called), and called with the
 * delegation's plan task id and its child (subagent) session when an epic is
 * open. Coders never reach it (their worktree landing commits their work).
 * `_internals` DI only (AGENTS.md #7).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	createBackgroundCompletionObserver,
	_internals as observerInternals,
} from '../../../src/background/completion-observer';
import { recordPendingDelegation } from '../../../src/background/pending-delegations';
import type { EpicResidueRequest } from '../../../src/epic/residue-commit';
import { resetSwarmState } from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const realInternals = { ...observerInternals };
let dir: string;
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;
let calls: Array<{ agent: string; taskIds: string[]; children: unknown[] }>;

async function complete(agent: string, id: string): Promise<void> {
	await recordPendingDelegation(dir, {
		correlationId: id,
		jobId: `job_${id}`,
		subagentSessionId: id,
		parentSessionId: 'parent_session',
		callID: `call_${id}`,
		normalizedAgent: agent,
		swarmPrefixedAgent: agent,
		planTaskId: '1.1',
		evidenceTaskId: '1.1',
		batchId: 'batch-1',
		laneId: `lane-${id}`,
	});
	const obs = createBackgroundCompletionObserver({
		config: { enabled: true },
		directory: dir,
	});
	await obs.event({
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					text: `<task id="${id}" state="completed">\n<task_result>done</task_result>\n</task>`,
					synthetic: true,
					sessionID: 'parent_session',
				},
			},
		},
	});
}

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
	dir = canonicalMkdtemp('swarm-bgobs-epic-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ review_routing: { enforce_receipts: false } }),
	);
	calls = [];
	observerInternals.commitEpicResidueAfterDelegation = async (
		request: EpicResidueRequest,
	) => {
		calls.push({
			agent: request.agent,
			taskIds: await request.resolveTaskIds(),
			children: await request.childSessionIds(),
		});
	};
});

afterEach(() => {
	Object.assign(observerInternals, realInternals);
	resetSwarmState();
	fs.rmSync(dir, { recursive: true, force: true });
	isolatedEnv?.cleanup();
	isolatedEnv = undefined;
});

describe('background completion → Epic residue seam', () => {
	it('no open epic: one sentinel check, the residue function is never called', async () => {
		let probes = 0;
		observerInternals.epicSentinelExists = () => {
			probes += 1;
			return false;
		};
		await complete('explorer', 'ses_off');
		expect(probes).toBe(1);
		expect(calls).toEqual([]);
	});

	it('open epic: called with the plan task id and the child session', async () => {
		observerInternals.epicSentinelExists = () => true;
		await complete('explorer', 'ses_on');
		expect(calls).toEqual([
			{ agent: 'explorer', taskIds: ['1.1'], children: ['ses_on'] },
		]);
	});
});
