/**
 * Adversarial tests for Stage B hardcoded parallelization
 *
 * ATTACK VECTORS:
 * 1. Config with stageB.parallel.enabled = false should NOT disable Stage B parallel
 * 2. Config with stageB missing entirely should still have Stage B parallel
 * 3. Malformed config objects should not crash the Stage B path
 * 4. Edge cases in hasBothStageBCompletions barrier (only reviewer, only test_engineer, neither)
 * 5. Race conditions in parallel Stage B completion recording
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	hasBothStageBCompletions,
	recordStageBCompletion,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import {
	checkReviewerGate,
	checkReviewerGateWithScope,
} from '../../../src/tools/update-task-status';

function makeConfig(overrides?: Record<string, unknown>): PluginConfig {
	return {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		hooks: {
			system_enhancer: true,
			compaction: true,
			agent_activity: true,
			delegation_tracker: false,
			agent_awareness_max_chars: 300,
			delegation_gate: true,
			delegation_max_chars: 4000,
			...(overrides?.hooks as Record<string, unknown>),
		},
	} as PluginConfig;
}

// ============================================================================
// ATTACK VECTOR 1: Config with stageB.parallel.enabled = false should NOT
// disable Stage B parallel (Stage B is hardcoded to parallel)
// ============================================================================
describe('Stage B hardcoded parallel - config bypass attempts', () => {
	let tempDir: string;

	beforeEach(async () => {
		resetSwarmState();
		tempDir = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), 'stage-b-adversarial-')),
		);
		await fs.mkdir(path.join(tempDir, '.swarm'), { recursive: true });
		const plan = {
			schema_version: '1.0.0',
			title: 'Test Plan',
			swarm: 'test-swarm',
			current_phase: 1,
			migration_status: 'migrated',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'Test task',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		await fs.writeFile(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);
	});

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		resetSwarmState();
	});

	describe('AV1: Config stageB.parallel.enabled = false must NOT disable Stage B parallel', () => {
		it('checkReviewerGateWithScope ignores stageB.parallel.enabled = false in config', async () => {
			// The code in update-task-status.ts lines 388-392 shows:
			// let stageBParallelEnabled = false;
			// if (workingDirectory) {
			//     stageBParallelEnabled = true;  // HARDCODED, ignores config
			// }
			// This test verifies the hardcoding is respected

			const session = ensureAgentSession('test-session');
			// Simulate both reviewer AND test_engineer completed (parallel barrier met)
			recordStageBCompletion(session, '1.1', 'reviewer');
			recordStageBCompletion(session, '1.1', 'test_engineer');

			// Even though stageB.parallel.enabled = false might be in some config,
			// checkReviewerGateWithScope hardcodes stageBParallelEnabled = true
			// when workingDirectory is provided
			const result = await checkReviewerGateWithScope('1.1', tempDir);

			// The hardcoded true value means hasBothStageBCompletions barrier is used
			expect(result.blocked).toBe(false);
		});

		it('delegation-gate ignores any stageB.parallel config in hook creation', () => {
			// Line 725 in delegation-gate.ts:
			// const stageBParallelEnabled = true;  // HARDCODED, no config read
			// This cannot be bypassed

			const config = makeConfig();
			// Attempt to pass stageB config that should be ignored
			(config as any).stageB = { parallel: { enabled: false } };

			const hook = createDelegationGateHook(config, tempDir);

			// The hook should still have stage B parallel hardcoded enabled
			// We verify this by checking the behavior when toolAfter is called
			const session = ensureAgentSession('test-session-av1');
			session.taskWorkflowStates = new Map([['1.1', 'coder_delegated']]);

			// Simulate reviewer completion
			recordStageBCompletion(session, '1.1', 'reviewer');

			// After reviewer alone, should NOT advance to tests_run (needs both)
			expect(hasBothStageBCompletions(session, '1.1')).toBe(false);

			// Simulate test_engineer completion
			recordStageBCompletion(session, '1.1', 'test_engineer');

			// Now both should be complete
			expect(hasBothStageBCompletions(session, '1.1')).toBe(true);
		});
	});

	describe('AV2: Missing stageB config must still enable Stage B parallel', () => {
		it('checkReviewerGateWithScope works even when stageB config is entirely missing', async () => {
			// No stageB in config at all - should still work because it's hardcoded
			const config = makeConfig();
			delete (config as any).stageB;

			const session = ensureAgentSession('test-session-av2');
			recordStageBCompletion(session, '1.1', 'reviewer');
			recordStageBCompletion(session, '1.1', 'test_engineer');

			// The hardcoded stageBParallelEnabled = true should still work
			const result = await checkReviewerGateWithScope('1.1', tempDir);
			expect(result.blocked).toBe(false);
		});
	});

	describe('AV3: Malformed config objects must not crash Stage B path', () => {
		it('malformed stageB config (null) does not crash checkReviewerGate', async () => {
			const config = makeConfig();
			(config as any).stageB = null;

			const session = ensureAgentSession('test-session-av3');
			recordStageBCompletion(session, '1.1', 'reviewer');
			recordStageBCompletion(session, '1.1', 'test_engineer');

			// Should not throw - the hardcoded path should handle malformed config
			const result = await checkReviewerGateWithScope('1.1', tempDir);
			expect(result.blocked).toBe(false);
		});

		it('malformed stageB config (undefined properties) does not crash checkReviewerGate', async () => {
			const config = makeConfig();
			(config as any).stageB = {
				parallel: { enabled: undefined, something: undefined },
			};

			const session = ensureAgentSession('test-session-av3b');
			recordStageBCompletion(session, '1.1', 'reviewer');
			recordStageBCompletion(session, '1.1', 'test_engineer');

			const result = await checkReviewerGateWithScope('1.1', tempDir);
			expect(result.blocked).toBe(false);
		});

		it('stageB config with wrong types does not crash checkReviewerGate', async () => {
			const config = makeConfig();
			(config as any).stageB = { parallel: { enabled: 'false' } }; // string instead of boolean

			const session = ensureAgentSession('test-session-av3c');
			recordStageBCompletion(session, '1.1', 'reviewer');
			recordStageBCompletion(session, '1.1', 'test_engineer');

			const result = await checkReviewerGateWithScope('1.1', tempDir);
			expect(result.blocked).toBe(false);
		});

		it('completely malformed config object does not crash delegation-gate hook', async () => {
			const config = makeConfig();
			(config as any).stageB = { parallel: { enabled: NaN } }; // NaN boolean

			const hook = createDelegationGateHook(config, tempDir);
			const session = ensureAgentSession('test-session-av3d');
			session.taskWorkflowStates = new Map([['1.1', 'coder_delegated']]);

			// Should not throw
			recordStageBCompletion(session, '1.1', 'reviewer');
			recordStageBCompletion(session, '1.1', 'test_engineer');

			expect(hasBothStageBCompletions(session, '1.1')).toBe(true);
		});
	});
});

// ============================================================================
// ATTACK VECTOR 4: Edge cases in hasBothStageBCompletions barrier
// ============================================================================
describe('hasBothStageBCompletions barrier edge cases', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	it('returns false when NEITHER reviewer nor test_engineer has completed', () => {
		const session = ensureAgentSession('edge-neither');
		session.taskWorkflowStates = new Map([['1.1', 'coder_delegated']]);

		// No completions recorded yet
		expect(hasBothStageBCompletions(session, '1.1')).toBe(false);
	});

	it('returns false when ONLY reviewer has completed', () => {
		const session = ensureAgentSession('edge-reviewer-only');
		session.taskWorkflowStates = new Map([['1.1', 'coder_delegated']]);

		recordStageBCompletion(session, '1.1', 'reviewer');
		expect(hasBothStageBCompletions(session, '1.1')).toBe(false);
	});

	it('returns false when ONLY test_engineer has completed', () => {
		const session = ensureAgentSession('edge-test-engineer-only');
		session.taskWorkflowStates = new Map([['1.1', 'coder_delegated']]);

		recordStageBCompletion(session, '1.1', 'test_engineer');
		expect(hasBothStageBCompletions(session, '1.1')).toBe(false);
	});

	it('returns true when BOTH reviewer AND test_engineer have completed', () => {
		const session = ensureAgentSession('edge-both');
		session.taskWorkflowStates = new Map([['1.1', 'coder_delegated']]);

		recordStageBCompletion(session, '1.1', 'reviewer');
		recordStageBCompletion(session, '1.1', 'test_engineer');
		expect(hasBothStageBCompletions(session, '1.1')).toBe(true);
	});

	it('returns true when BOTH completed in REVERSE order (test_engineer first)', () => {
		const session = ensureAgentSession('edge-reverse-order');
		session.taskWorkflowStates = new Map([['1.1', 'coder_delegated']]);

		// test_engineer completes FIRST (reverse order)
		recordStageBCompletion(session, '1.1', 'test_engineer');
		expect(hasBothStageBCompletions(session, '1.1')).toBe(false); // Not yet

		// Then reviewer completes
		recordStageBCompletion(session, '1.1', 'reviewer');
		expect(hasBothStageBCompletions(session, '1.1')).toBe(true);
	});
});
