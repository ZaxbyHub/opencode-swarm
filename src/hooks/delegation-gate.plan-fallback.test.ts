/**
 * Tests for getEvidenceTaskId plan.json fallback behavior.
 * Verifies durable task ID recovery from .swarm/plan.json when in-memory state is empty.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	ensureAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../state';
import { createDelegationGateHook } from './delegation-gate';

// Minimal plugin config
const testConfig = {
	hooks: { delegation_gate: true },
} as unknown as Parameters<typeof createDelegationGateHook>[0];

let tmpDir: string;

beforeEach(() => {
	resetSwarmState();
	tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dg-plan-fallback-'));
	// Create .swarm directory structure
	mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	resetSwarmState();
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

describe('getEvidenceTaskId plan.json fallback', () => {
	it('falls back to first in_progress task from plan.json when all in-memory sources are null', async () => {
		// Create a plan.json with an in_progress task
		const planContent = {
			phases: [
				{
					id: 1,
					name: 'Test Phase',
					tasks: [
						{ id: '1.1', status: 'pending' },
						{ id: '1.2', status: 'in_progress' },
						{ id: '1.3', status: 'pending' },
					],
				},
			],
		};
		writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify(planContent),
		);

		// Start session with all null sources
		startAgentSession('sess-plan-1', 'architect');
		const session = ensureAgentSession('sess-plan-1');
		session.currentTaskId = null;
		session.lastCoderDelegationTaskId = null;
		session.taskWorkflowStates = new Map(); // Empty

		// Fire toolAfter - it should derive task ID from plan.json
		const hook = createDelegationGateHook(testConfig, tmpDir);
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-plan-1',
				callID: 'call-1',
				args: { subagent_type: 'reviewer' },
			},
			{},
		);

		// Check that evidence was written for task 1.2 (first in_progress)
		const { readTaskEvidence } = await import('../gate-evidence');
		const evidence = await readTaskEvidence(tmpDir, '1.2');
		expect(evidence).not.toBeNull();
		expect(evidence!.gates.reviewer).toBeDefined();
	});

	it('returns null when plan.json does not exist (does not throw)', async () => {
		// No plan.json file in .swarm directory - this should not throw
		const hook = createDelegationGateHook(testConfig, tmpDir);

		// This should NOT throw - should return null gracefully
		let threw = false;
		try {
			await hook.toolAfter(
				{
					tool: 'Task',
					sessionID: 'sess-missing-plan',
					callID: 'call-1',
					args: { subagent_type: 'reviewer' },
				},
				{},
			);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
	});

	it('returns null when plan.json is malformed JSON (does not throw)', async () => {
		// Write invalid JSON to plan.json
		writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), '{ invalid json }');

		const hook = createDelegationGateHook(testConfig, tmpDir);

		// This should NOT throw - should handle malformed JSON gracefully
		let threw = false;
		try {
			await hook.toolAfter(
				{
					tool: 'Task',
					sessionID: 'sess-malformed',
					callID: 'call-1',
					args: { subagent_type: 'reviewer' },
				},
				{},
			);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
	});

	it('returns null when plan.json has no phases array', async () => {
		const planContent = {
			title: 'Test Plan',
			// Missing phases array
		};
		writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify(planContent),
		);

		const hook = createDelegationGateHook(testConfig, tmpDir);

		// Should handle missing phases gracefully
		let threw = false;
		try {
			await hook.toolAfter(
				{
					tool: 'Task',
					sessionID: 'sess-no-phases',
					callID: 'call-1',
					args: { subagent_type: 'reviewer' },
				},
				{},
			);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
	});

	it('returns null when plan.json has no in_progress tasks', async () => {
		const planContent = {
			phases: [
				{
					id: 1,
					tasks: [
						{ id: '1.1', status: 'pending' },
						{ id: '1.2', status: 'completed' },
					],
				},
			],
		};
		writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify(planContent),
		);

		// Start session with all null sources
		startAgentSession('sess-no-progress', 'architect');
		const session = ensureAgentSession('sess-no-progress');
		session.currentTaskId = null;
		session.lastCoderDelegationTaskId = null;
		session.taskWorkflowStates = new Map();

		const hook = createDelegationGateHook(testConfig, tmpDir);
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-no-progress',
				callID: 'call-1',
				args: { subagent_type: 'reviewer' },
			},
			{},
		);

		// No evidence should be written because no task ID could be determined
		const { readTaskEvidence } = await import('../gate-evidence');
		// Try to read evidence for any of the tasks - none should exist
		const evidence1 = await readTaskEvidence(tmpDir, '1.1');
		const evidence2 = await readTaskEvidence(tmpDir, '1.2');
		expect(evidence1).toBeNull();
		expect(evidence2).toBeNull();
	});

	it('returns null when plan.json has in_progress task with non-string id', async () => {
		const planContent = {
			phases: [
				{
					id: 1,
					tasks: [{ id: 123, status: 'in_progress' }],
				},
			],
		};
		writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify(planContent),
		);

		startAgentSession('sess-invalid-id-type', 'architect');
		const session = ensureAgentSession('sess-invalid-id-type');
		session.currentTaskId = null;
		session.lastCoderDelegationTaskId = null;
		session.taskWorkflowStates = new Map();

		const hook = createDelegationGateHook(testConfig, tmpDir);
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-invalid-id-type',
				callID: 'call-1',
				args: { subagent_type: 'reviewer' },
			},
			{},
		);

		const { readTaskEvidence } = await import('../gate-evidence');
		expect(await readTaskEvidence(tmpDir, '123')).toBeNull();
	});

	it('finds in_progress task in later phase when earlier phases have none', async () => {
		const planContent = {
			phases: [
				{
					id: 1,
					tasks: [
						{ id: '1.1', status: 'completed' },
						{ id: '1.2', status: 'completed' },
					],
				},
				{
					id: 2,
					tasks: [{ id: '2.1', status: 'in_progress' }],
				},
			],
		};
		writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify(planContent),
		);

		startAgentSession('sess-later-phase', 'architect');
		const session = ensureAgentSession('sess-later-phase');
		session.currentTaskId = null;
		session.lastCoderDelegationTaskId = null;
		session.taskWorkflowStates = new Map();

		const hook = createDelegationGateHook(testConfig, tmpDir);
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-later-phase',
				callID: 'call-1',
				args: { subagent_type: 'reviewer' },
			},
			{},
		);

		// Should find 2.1 as the first in_progress
		const { readTaskEvidence } = await import('../gate-evidence');
		const evidence = await readTaskEvidence(tmpDir, '2.1');
		expect(evidence).not.toBeNull();
		expect(evidence!.gates.reviewer).toBeDefined();
	});

	it('prefers currentTaskId over plan.json fallback', async () => {
		const planContent = {
			phases: [
				{
					id: 1,
					tasks: [{ id: '1.1', status: 'in_progress' }],
				},
			],
		};
		writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify(planContent),
		);

		// Set currentTaskId - this should be preferred
		startAgentSession('sess-priority', 'architect');
		const session = ensureAgentSession('sess-priority');
		session.currentTaskId = '3.5'; // Different from plan.json
		session.lastCoderDelegationTaskId = null;
		session.taskWorkflowStates = new Map();

		const hook = createDelegationGateHook(testConfig, tmpDir);
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-priority',
				callID: 'call-1',
				args: { subagent_type: 'reviewer' },
			},
			{},
		);

		// Should use currentTaskId, not plan.json
		const { readTaskEvidence } = await import('../gate-evidence');
		const evidence = await readTaskEvidence(tmpDir, '3.5');
		expect(evidence).not.toBeNull();
		// Verify plan.json task was NOT used
		const planEvidence = await readTaskEvidence(tmpDir, '1.1');
		expect(planEvidence).toBeNull();
	});

	it('prefers taskWorkflowStates over plan.json fallback', async () => {
		const planContent = {
			phases: [
				{
					id: 1,
					tasks: [{ id: '1.1', status: 'in_progress' }],
				},
			],
		};
		writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify(planContent),
		);

		// Set taskWorkflowStates - this should be preferred over plan.json
		startAgentSession('sess-states-priority', 'architect');
		const session = ensureAgentSession('sess-states-priority');
		session.currentTaskId = null;
		session.lastCoderDelegationTaskId = null;
		session.taskWorkflowStates = new Map([['4.3', 'coder_delegated']]);

		const hook = createDelegationGateHook(testConfig, tmpDir);
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-states-priority',
				callID: 'call-1',
				args: { subagent_type: 'reviewer' },
			},
			{},
		);

		// Should use taskWorkflowStates, not plan.json
		const { readTaskEvidence } = await import('../gate-evidence');
		const evidence = await readTaskEvidence(tmpDir, '4.3');
		expect(evidence).not.toBeNull();
		// Verify plan.json task was NOT used
		const planEvidence = await readTaskEvidence(tmpDir, '1.1');
		expect(planEvidence).toBeNull();
	});

	it('handles path traversal attempt by returning null', async () => {
		// Try to access a path outside the working directory
		const maliciousDir = path.join(tmpDir, 'subdir');
		const hook = createDelegationGateHook(testConfig, maliciousDir);

		// Should not throw, should handle safely
		let threw = false;
		try {
			await hook.toolAfter(
				{
					tool: 'Task',
					sessionID: 'sess-security',
					callID: 'call-1',
					args: { subagent_type: 'reviewer' },
				},
				{},
			);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
	});

	it('returns null for empty directory string', async () => {
		// Pass empty string as directory
		const hook = createDelegationGateHook(testConfig, '');

		startAgentSession('sess-empty-dir', 'architect');
		const session = ensureAgentSession('sess-empty-dir');
		session.currentTaskId = null;
		session.lastCoderDelegationTaskId = null;
		session.taskWorkflowStates = new Map();

		// Should not throw
		let threw = false;
		try {
			await hook.toolAfter(
				{
					tool: 'Task',
					sessionID: 'sess-empty-dir',
					callID: 'call-1',
					args: { subagent_type: 'reviewer' },
				},
				{},
			);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
	});
});
