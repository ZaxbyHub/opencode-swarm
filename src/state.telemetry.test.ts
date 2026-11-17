import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { canonicalMkdtemp } from '../tests/helpers/tmpdir.js';
import { advanceTaskState, ensureAgentSession, resetSwarmState } from './state';
import {
	addTelemetryListener,
	initTelemetry,
	resetTelemetryForTesting,
} from './telemetry';

describe('state telemetry', () => {
	// telemetry.jsonl goes under <dir>/.swarm — a temp root, never the checkout.
	let projectDir: string;

	beforeEach(() => {
		resetSwarmState();
		resetTelemetryForTesting();
		projectDir = canonicalMkdtemp('state-telemetry-');
		initTelemetry(projectDir);
	});

	afterEach(() => {
		resetSwarmState();
		resetTelemetryForTesting();
		rmSync(projectDir, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 100,
		});
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
