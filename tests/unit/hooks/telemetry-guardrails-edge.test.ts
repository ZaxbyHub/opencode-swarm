import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	beginInvocation,
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import {
	addTelemetryListener,
	initTelemetry,
	resetTelemetryForTesting,
} from '../../../src/telemetry';

let sharedTempDir: string;

function makeGuardrailsConfig(
	overrides: Partial<GuardrailsConfig> = {},
): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 30,
		max_duration_minutes: 30,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.8,
		idle_timeout_minutes: 60,
		no_op_warning_threshold: 15,
		max_coder_revisions: 5,
		...overrides,
	} as GuardrailsConfig;
}

describe('telemetry-guardrails edge cases', () => {
	beforeEach(() => {
		resetTelemetryForTesting();
		resetSwarmState();
		sharedTempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-telemetry-edge-')),
		);
		initTelemetry(sharedTempDir);
	});

	afterEach(() => {
		resetTelemetryForTesting();
		resetSwarmState();
		if (sharedTempDir && fs.existsSync(sharedTempDir)) {
			fs.rmSync(sharedTempDir, { recursive: true, force: true });
		}
	});

	test('disabled guardrails do not emit hard-limit telemetry', async () => {
		const received: Array<{ event: string; data: Record<string, unknown> }> =
			[];
		addTelemetryListener((event, data) => received.push({ event, data }));

		const sessionId = 'session-gr-disabled';
		const coderAgentName = 'coder';

		ensureAgentSession(sessionId, coderAgentName);
		swarmState.activeAgent.set(sessionId, coderAgentName);
		beginInvocation(sessionId, coderAgentName);

		const hooks = createGuardrailsHooks(sharedTempDir, {
			...makeGuardrailsConfig(),
			enabled: false,
			max_tool_calls: 0,
			max_duration_minutes: 0,
		});

		await hooks.toolBefore(
			{ tool: 'bash', sessionID: sessionId, callID: 'call-disabled' },
			{ args: { command: 'echo test' } },
		);

		expect(
			received.find((entry) => entry.event === 'hard_limit_hit'),
		).toBeUndefined();
	});

	test('architect sessions are exempt from hard-limit telemetry', async () => {
		const received: Array<{ event: string; data: Record<string, unknown> }> =
			[];
		addTelemetryListener((event, data) => received.push({ event, data }));

		const sessionId = 'session-gr-arch';
		const architectAgentName = 'architect';

		ensureAgentSession(sessionId, architectAgentName);
		swarmState.activeAgent.set(sessionId, architectAgentName);

		const hooks = createGuardrailsHooks(
			sharedTempDir,
			makeGuardrailsConfig({ max_tool_calls: 30 }),
		);

		await hooks.toolBefore(
			{ tool: 'bash', sessionID: sessionId, callID: 'call-arch' },
			{ args: { command: 'echo architect test' } },
		);

		expect(
			received.find((entry) => entry.event === 'hard_limit_hit'),
		).toBeUndefined();
	});
});
