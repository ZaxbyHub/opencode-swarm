/**
 * Corrupt-evidence fail-closed tests for the two delegation-gate guard sites
 * (issue #2470 / #2199).
 *
 * Contract:
 *  - Corrupt/unparseable evidence for the task being dispatched fails closed
 *    with TASK_EVIDENCE_UNREADABLE naming the evidence file.
 *  - Corrupt evidence for an UNRELATED task must NOT block dispatch (the
 *    loop keeps idle handling for other tasks; one corrupt file cannot lock
 *    out dispatch for all tasks).
 *  - MISSING evidence keeps the intended fail-open behavior (no new throw).
 *  - Version-skew evidence (valid JSON, unknown workflow.state) is treated as
 *    corrupt at both guard sites.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { writeApprovedPlan } from '../../helpers/approved-plan';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const config = {
	hooks: { delegation_gate: true },
} as unknown as PluginConfig;

let testDir = '';

beforeEach(async () => {
	resetSwarmState();
	testDir = canonicalMkdtemp('dg-tri-state-');
	await writeApprovedPlan(testDir, [
		{ id: '1.1', files: ['src/index.ts'] },
		{ id: '3.1', files: ['src/other.ts'] },
	]);
});

afterEach(() => {
	resetSwarmState();
	fs.rmSync(testDir, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 50,
	});
});

function writeCorruptEvidence(taskId: string, content: string): void {
	fs.mkdirSync(path.join(testDir, '.swarm', 'evidence'), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(testDir, '.swarm', 'evidence', `${taskId}.json`),
		content,
		'utf-8',
	);
}

const MALFORMED_JSON = '{not json';

/** Valid JSON whose workflow.state only a NEWER build recognises (#2199 skew). */
const VERSION_SKEW_JSON = JSON.stringify({
	taskId: '1.1',
	required_gates: [],
	gates: {},
	turbo: {},
	requirements_state: 'unspecified',
	test_engineer_exempt: false,
	workflow: {
		schema: 'exact-task-v1',
		generation: 1,
		state: 'future_state_v9',
		retryCount: 0,
		retryHistory: [],
		retryEpoch: 0,
		updatedAt: '2026-01-01T00:00:00Z',
	},
	repair_provenance: [],
});

async function dispatchCoder(
	hooks: ReturnType<typeof createDelegationGateHook>,
	sessionId: string,
	callID: string,
	taskId: string,
): Promise<unknown> {
	return hooks.toolBefore(
		{ tool: 'Task', sessionID: sessionId, callID },
		{
			args: {
				subagent_type: 'coder',
				task_id: taskId,
				prompt: `TASK: ${taskId}\nACCEPTANCE: implement the task and cover it with tests`,
			},
		},
	);
}

describe('delegation gate corrupt-evidence tri-state (issue #2470/#2199)', () => {
	test('corrupt evidence for the dispatched task fails closed naming the file', async () => {
		const hooks = createDelegationGateHook(config, testDir);
		const sessionId = 'session-tri-state-1';
		ensureAgentSession(sessionId, 'architect', testDir);

		writeCorruptEvidence('1.1', MALFORMED_JSON);

		await expect(
			dispatchCoder(hooks, sessionId, 'call-corrupt-self', '1.1'),
		).rejects.toThrow(/TASK_EVIDENCE_UNREADABLE/);
	});

	test('the typed diagnostic names the unreadable evidence file', async () => {
		const hooks = createDelegationGateHook(config, testDir);
		const sessionId = 'session-tri-state-1b';
		ensureAgentSession(sessionId, 'architect', testDir);

		writeCorruptEvidence('1.1', MALFORMED_JSON);

		try {
			await dispatchCoder(hooks, sessionId, 'call-corrupt-path', '1.1');
			expect.unreachable('expected TASK_EVIDENCE_UNREADABLE');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toContain('TASK_EVIDENCE_UNREADABLE');
			expect(message).toContain('1.1.json');
		}
	});

	test('version-skew evidence (valid JSON, unknown state) fails closed too', async () => {
		const hooks = createDelegationGateHook(config, testDir);
		const sessionId = 'session-tri-state-2';
		ensureAgentSession(sessionId, 'architect', testDir);

		writeCorruptEvidence('1.1', VERSION_SKEW_JSON);

		await expect(
			dispatchCoder(hooks, sessionId, 'call-skew-self', '1.1'),
		).rejects.toThrow(/TASK_EVIDENCE_UNREADABLE/);
	});

	test('corrupt evidence for an UNRELATED task does not block dispatch', async () => {
		const hooks = createDelegationGateHook(config, testDir);
		const sessionId = 'session-tri-state-3';
		ensureAgentSession(sessionId, 'architect', testDir);

		// 3.1 is corrupt; the dispatch targets 1.1 whose evidence is missing.
		writeCorruptEvidence('3.1', MALFORMED_JSON);

		// Must NOT throw: one corrupt file cannot lock out unrelated tasks.
		await dispatchCoder(hooks, sessionId, 'call-corrupt-other', '1.1');
	});

	test('version-skew evidence for an unrelated task does not block dispatch', async () => {
		const hooks = createDelegationGateHook(config, testDir);
		const sessionId = 'session-tri-state-4';
		ensureAgentSession(sessionId, 'architect', testDir);

		writeCorruptEvidence('3.1', VERSION_SKEW_JSON);

		await dispatchCoder(hooks, sessionId, 'call-skew-other', '1.1');
	});

	test('missing evidence keeps the intended fail-open behavior (no throw)', async () => {
		const hooks = createDelegationGateHook(config, testDir);
		const sessionId = 'session-tri-state-5';
		ensureAgentSession(sessionId, 'architect', testDir);

		// No evidence files at all — first delegation of 1.1 stays allowed.
		await dispatchCoder(hooks, sessionId, 'call-missing', '1.1');
	});
});
