import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { advanceTaskState, ensureAgentSession, resetSwarmState } from './state';
import {
	addTelemetryListener,
	initTelemetry,
	resetTelemetryForTesting,
} from './telemetry';

describe('state telemetry', () => {
	beforeEach(() => {
		resetSwarmState();
		resetTelemetryForTesting();
		initTelemetry(process.cwd());
	});

	afterEach(() => {
		resetSwarmState();
		resetTelemetryForTesting();
	});

	test('advanceTaskState emits task_state_changed with provided telemetry session id', () => {
		const events: Array<{ event: string; data: Record<string, unknown> }> = [];
		addTelemetryListener((event, data) => {
			events.push({ event, data });
		});

		const session = ensureAgentSession('real-session', 'reviewer');
		advanceTaskState(session, '1.1', 'coder_delegated', {
			telemetrySessionId: 'architect-session',
		});

		const stateEvent = events.find(
			(entry) => entry.event === 'task_state_changed',
		);
		expect(stateEvent?.data.sessionId).toBe('architect-session');
	});

	test('advanceTaskState can suppress telemetry for mirrored state transitions', () => {
		const events: Array<{ event: string; data: Record<string, unknown> }> = [];
		addTelemetryListener((event, data) => {
			events.push({ event, data });
		});

		const session = ensureAgentSession('mirror-session', 'reviewer');
		advanceTaskState(session, '1.1', 'coder_delegated', {
			emitTelemetry: false,
		});

		expect(events.some((entry) => entry.event === 'task_state_changed')).toBe(
			false,
		);
	});
});
