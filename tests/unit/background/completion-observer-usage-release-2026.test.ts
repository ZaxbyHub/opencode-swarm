/**
 * PR 3922 closeout: a native-async child's usage-bridge total is released at its
 * verified terminal for every outcome (completed, error, cancelled). The check
 * drives the real completion observer, so it pins the wiring and not only the
 * bridge helper: without the observer call the child's next step is still
 * aggregated onto the old total (cost 2 instead of 1).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import { recordPendingDelegation } from '../../../src/background/pending-delegations';
import {
	clearV2StepUsage,
	ingestV2StepUsage,
} from '../../../src/host/v2/usage-bridge';
import { resetSwarmState } from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';

function makeTempProject(): string {
	const dir = canonicalMkdtemp('swarm-usage-release-');
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(real, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(real, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ review_routing: { enforce_receipts: false } }),
	);
	return real;
}

function usageStep(sessionID: string, eventId: string) {
	return {
		swarmV2UsageStep: true,
		sessionID,
		swarmV2EventId: eventId,
		cost: 1,
		tokens: {
			input: 1,
			output: 1,
			reasoning: 0,
			cache: { read: 0, write: 0 },
		},
	};
}

function trustedTerminal(sessionID: string, state: string) {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					text: `<task id="${sessionID}" state="${state}">\n<task_result>done</task_result>\n</task>`,
					synthetic: true,
					sessionID: 'parent_session',
				},
			},
		},
	};
}

describe('native-async usage release at the verified terminal (PR 3922 closeout)', () => {
	let dir: string;
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

	beforeEach(() => {
		isolatedEnv = createIsolatedTestEnv();
		resetSwarmState();
		clearV2StepUsage();
		dir = makeTempProject();
	});

	afterEach(() => {
		clearV2StepUsage();
		resetSwarmState();
		fs.rmSync(dir, { recursive: true, force: true });
		isolatedEnv?.cleanup();
		isolatedEnv = undefined;
	});

	for (const state of ['completed', 'error', 'cancelled'] as const) {
		it(`releases the child usage total at a verified ${state} terminal`, async () => {
			const child = `ses_usage_${state}`;
			await recordPendingDelegation(dir, {
				correlationId: child,
				jobId: `job_${state}`,
				subagentSessionId: child,
				parentSessionId: 'parent_session',
				callID: `call_${state}`,
				normalizedAgent: 'explorer',
				swarmPrefixedAgent: 'explorer',
				planTaskId: null,
				evidenceTaskId: null,
				batchId: 'batch-1',
				laneId: 'lane-1',
			});

			expect(ingestV2StepUsage(usageStep(child, 'step-1'))?.cost).toBe(1);

			const obs = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory: dir,
			});
			await obs.event(trustedTerminal(child, state));

			// Released: the child's next step starts a fresh total, not 1 + 1.
			expect(ingestV2StepUsage(usageStep(child, 'step-2'))?.cost).toBe(1);
		});
	}
});
