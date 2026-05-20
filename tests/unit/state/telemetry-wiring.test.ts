import { beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { recordGateEvidence } from '../../../src/gate-evidence';
import {
	advanceTaskState,
	beginInvocation,
	ensureAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';
import {
	addTelemetryListener,
	initTelemetry,
	resetTelemetryForTesting,
} from '../../../src/telemetry';

describe('telemetry wiring in state.ts', () => {
	let sharedTempDir: string;
	let capturedEvents: Array<{
		event: string;
		data: Record<string, unknown>;
	}>;

	beforeEach(() => {
		// Create temp directory for telemetry init
		sharedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-telemetry-'));

		// Reset telemetry and state
		resetTelemetryForTesting();
		resetSwarmState();
		initTelemetry(sharedTempDir);

		// Capture events
		capturedEvents = [];
		addTelemetryListener((event, data) => {
			capturedEvents.push({ event, data });
		});
	});

	describe('1. startAgentSession emits session_started', () => {
		test('emits session_started with correct sessionId and agentName', () => {
			const sessionId = 'test-session-123';
			const agentName = 'coder';

			startAgentSession(sessionId, agentName);

			expect(capturedEvents).toHaveLength(1);
			expect(capturedEvents[0].event).toBe('session_started');
			expect(capturedEvents[0].data).toEqual({
				sessionId,
				agentName,
			});
		});

		test('emits session_started with different agent names', () => {
			startAgentSession('session-1', 'reviewer');
			startAgentSession('session-2', 'test_engineer');

			expect(capturedEvents).toHaveLength(2);
			expect(capturedEvents[0].data.agentName).toBe('reviewer');
			expect(capturedEvents[1].data.agentName).toBe('test_engineer');
		});
	});

	describe('2. ensureAgentSession rename emits agent_activated', () => {
		test('emits agent_activated when agentName changes', () => {
			const sessionId = 'session-rename-test';
			const originalName = 'coder';
			const newName = 'reviewer';

			// Create session with original agent
			startAgentSession(sessionId, originalName);
			capturedEvents.length = 0; // Clear session_started event

			// Rename via ensureAgentSession
			ensureAgentSession(sessionId, newName);

			expect(capturedEvents).toHaveLength(1);
			expect(capturedEvents[0].event).toBe('agent_activated');
			expect(capturedEvents[0].data).toEqual({
				sessionId,
				agentName: newName,
				oldName: originalName,
			});
		});

		test('does NOT emit agent_activated when agentName is same', () => {
			const sessionId = 'session-same-test';
			startAgentSession(sessionId, 'coder');
			capturedEvents.length = 0;

			// Call ensureAgentSession with same name
			ensureAgentSession(sessionId, 'coder');

			const agentActivatedEvents = capturedEvents.filter(
				(e) => e.event === 'agent_activated',
			);
			expect(agentActivatedEvents).toHaveLength(0);
		});

		test('creates new session when ensureAgentSession is called for non-existent session', () => {
			const sessionId = 'new-session';
			ensureAgentSession(sessionId, 'architect');

			const sessionStartedEvents = capturedEvents.filter(
				(e) => e.event === 'session_started',
			);
			expect(sessionStartedEvents).toHaveLength(1);
			expect(sessionStartedEvents[0].data.agentName).toBe('architect');
		});
	});

	describe('3. beginInvocation emits delegation_begin', () => {
		test('emits delegation_begin with correct agentName and taskId', () => {
			const sessionId = 'invocation-test';
			const agentName = 'swarm_coder'; // Uses underscore separator which is recognized

			// Create session
			startAgentSession(sessionId, 'architect');
			capturedEvents.length = 0;

			// Set current task
			const session = ensureAgentSession(sessionId, 'architect');
			session.currentTaskId = '1.2';
			capturedEvents.length = 0;

			// Begin invocation
			beginInvocation(sessionId, agentName);

			expect(capturedEvents).toHaveLength(1);
			expect(capturedEvents[0].event).toBe('delegation_begin');
			expect(capturedEvents[0].data).toEqual({
				sessionId,
				agentName: 'coder', // stripped of swarm prefix
				taskId: '1.2',
			});
		});

		test('emits delegation_begin with unknown when currentTaskId is null', () => {
			const sessionId = 'invocation-no-task';
			startAgentSession(sessionId, 'architect');
			capturedEvents.length = 0;

			beginInvocation(sessionId, 'coder');

			expect(capturedEvents).toHaveLength(1);
			expect(capturedEvents[0].data.taskId).toBe('unknown');
		});

		test('throws error when session does not exist', () => {
			expect(() => beginInvocation('non-existent-session', 'coder')).toThrow(
				'Cannot begin invocation: session non-existent-session does not exist',
			);
		});
	});

	describe('4. advanceTaskState emits task_state_changed', () => {
		test('emits task_state_changed with taskId, newState, and oldState', () => {
			const sessionId = 'task-state-test';
			startAgentSession(sessionId, 'architect');
			const session = ensureAgentSession(sessionId, 'architect');
			capturedEvents.length = 0;

			advanceTaskState(session, '1.1', 'coder_delegated');

			expect(capturedEvents).toHaveLength(1);
			expect(capturedEvents[0].event).toBe('task_state_changed');
			// Note: The correlation key per FR-019 is session.agentName
			expect(capturedEvents[0].data).toEqual({
				sessionId: 'architect', // correlation key = session.agentName
				taskId: '1.1',
				newState: 'coder_delegated',
				oldState: 'idle',
			});
		});

		test('emits task_state_changed with correct state transition', () => {
			const sessionId = 'task-transition-test';
			startAgentSession(sessionId, 'architect');
			const session = ensureAgentSession(sessionId, 'architect');
			capturedEvents.length = 0;

			advanceTaskState(session, '2.1', 'coder_delegated');
			capturedEvents.length = 0;

			advanceTaskState(session, '2.1', 'pre_check_passed');

			expect(capturedEvents).toHaveLength(1);
			expect(capturedEvents[0].data).toEqual({
				sessionId: 'architect',
				taskId: '2.1',
				newState: 'pre_check_passed',
				oldState: 'coder_delegated',
			});
		});

		test('throws on backward state transition', () => {
			const sessionId = 'backward-transition-test';
			startAgentSession(sessionId, 'architect');
			const session = ensureAgentSession(sessionId, 'architect');

			advanceTaskState(session, '3.1', 'coder_delegated');
			capturedEvents.length = 0;

			expect(() => advanceTaskState(session, '3.1', 'idle')).toThrow(
				'INVALID_TASK_STATE_TRANSITION: 3.1 coder_delegated → idle',
			);
			expect(capturedEvents).toHaveLength(0);
		});

		test('does not emit when taskId is invalid (null)', () => {
			const sessionId = 'null-taskid-test';
			startAgentSession(sessionId, 'architect');
			const session = ensureAgentSession(sessionId, 'architect');
			capturedEvents.length = 0;

			// @ts-ignore - Testing invalid input
			advanceTaskState(session, null, 'coder_delegated');

			expect(capturedEvents).toHaveLength(0);
		});

		test('does not emit when taskId is invalid (empty string)', () => {
			const sessionId = 'empty-taskid-test';
			startAgentSession(sessionId, 'architect');
			const session = ensureAgentSession(sessionId, 'architect');
			capturedEvents.length = 0;

			advanceTaskState(session, '', 'coder_delegated');

			expect(capturedEvents).toHaveLength(0);
		});
	});

	describe('5. recordGateEvidence emits gate_passed', () => {
		test('emits gate_passed with correct sessionId, gate, and taskId', async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-evidence-'));
			const sessionId = 'test-session-123';
			const gate = 'reviewer';
			const taskId = '3.1';

			await recordGateEvidence(tempDir, taskId, gate, sessionId);

			const gateEvents = capturedEvents.filter(
				(e) => e.event === 'gate_passed',
			);
			expect(gateEvents).toHaveLength(1);
			expect(gateEvents[0].event).toBe('gate_passed');
			expect(gateEvents[0].data).toEqual({
				sessionId,
				gate,
				taskId,
			});
		});

		test('emits gate_passed with different gate names', async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-evidence-'));

			await recordGateEvidence(tempDir, '1.1', 'test_engineer', 'session-1');
			await recordGateEvidence(tempDir, '1.2', 'lint', 'session-2');
			await recordGateEvidence(tempDir, '1.3', 'reviewer', 'session-3');

			const gateEvents = capturedEvents.filter(
				(e) => e.event === 'gate_passed',
			);
			expect(gateEvents).toHaveLength(3);
			expect(gateEvents[0].data.gate).toBe('test_engineer');
			expect(gateEvents[1].data.gate).toBe('lint');
			expect(gateEvents[2].data.gate).toBe('reviewer');
		});

		test('does not throw when telemetry is not initialized', async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-evidence-'));

			// Reset telemetry and state to simulate uninitialized state
			resetTelemetryForTesting();
			resetSwarmState();

			// Should not throw even though telemetry is not initialized
			// The emit() function has try/catch that prevents throwing
			await recordGateEvidence(tempDir, '2.1', 'reviewer', 'session-x');
		});

		test('creates evidence file with correct content', async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-evidence-'));
			const sessionId = 'evidence-session';
			const gate = 'reviewer';
			const taskId = '4.2';

			await recordGateEvidence(tempDir, taskId, gate, sessionId);

			const evidencePath = path.join(
				tempDir,
				'.swarm',
				'evidence',
				`${taskId}.json`,
			);
			expect(fs.existsSync(evidencePath)).toBe(true);

			const content = JSON.parse(fs.readFileSync(evidencePath, 'utf-8'));
			expect(content.taskId).toBe(taskId);
			expect(content.gates[gate]).toBeDefined();
			expect(content.gates[gate].sessionId).toBe(sessionId);
		});
	});
});
