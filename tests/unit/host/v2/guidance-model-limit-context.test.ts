/**
 * V2 guidance must relay the host's live model limits into the v1
 * `experimental.chat.system.transform` input — same contract as the v1 host
 * (`model.limit.context` drives context-budget denominator resolution).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { onV2ContextEvent } from '../../../../src/host/v2/guidance';
import type {
	V1HooksSubset,
	V2SessionContextEvent,
} from '../../../../src/host/v2/types';
import { readModelContextLimit } from '../../../../src/config/context-window';
import { resetSwarmState } from '../../../../src/state';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

interface CapturedSystemInput {
	sessionID?: string;
	model?: unknown;
}

function captureSystemTransformHooks(
	captured: CapturedSystemInput[],
): V1HooksSubset {
	return {
		'experimental.chat.system.transform': async (input) => {
			captured.push(input as CapturedSystemInput);
		},
	} as unknown as V1HooksSubset;
}

function minimalContextEvent(
	model: V2SessionContextEvent['model'],
): V2SessionContextEvent {
	return {
		sessionID: 'v2-model-limit-session',
		agent: undefined,
		model,
		system: [],
		messages: [],
		options: {},
		tools: {},
	};
}

afterEach(() => {
	resetSwarmState();
});

describe('v2 guidance — toV1ModelInput relays model.limit.context', () => {
	test('forwards limit.context to experimental.chat.system.transform', async () => {
		const captured: CapturedSystemInput[] = [];
		const directory = canonicalMkdtemp('swarm-v2-model-limit-');
		const event = minimalContextEvent({
			id: 'claude-sonnet-4.5',
			providerID: 'github-copilot',
			limit: { context: 200_000, output: 32_000 },
		});

		await onV2ContextEvent(
			event,
			captureSystemTransformHooks(captured),
			directory,
		);

		expect(captured.length).toBe(1);
		expect(captured[0]?.sessionID).toBe('v2-model-limit-session');
		expect(readModelContextLimit(captured[0]?.model)).toBe(200_000);
	});

	test('omits limit when the v2 event carries no limit object', async () => {
		const captured: CapturedSystemInput[] = [];
		const directory = canonicalMkdtemp('swarm-v2-model-nolimit-');
		const event = minimalContextEvent({
			id: 'claude-sonnet-4.5',
			providerID: 'anthropic',
		});

		await onV2ContextEvent(
			event,
			captureSystemTransformHooks(captured),
			directory,
		);

		expect(captured.length).toBe(1);
		const model = captured[0]?.model as { limit?: unknown } | undefined;
		expect(model?.limit).toBeUndefined();
		expect(readModelContextLimit(captured[0]?.model)).toBeUndefined();
	});

	test('reads model.modelID when id is absent (OpenCode v2 ref shape)', async () => {
		const captured: CapturedSystemInput[] = [];
		const directory = canonicalMkdtemp('swarm-v2-model-modelid-');
		const event = minimalContextEvent({
			modelID: 'MiniMax-M3',
			providerID: 'minimax',
		});

		await onV2ContextEvent(
			event,
			captureSystemTransformHooks(captured),
			directory,
		);

		expect(captured.length).toBe(1);
		const model = captured[0]?.model as {
			id?: string;
			modelID?: string;
			providerID?: string;
		};
		expect(model?.modelID).toBe('MiniMax-M3');
		expect(model?.id).toBe('MiniMax-M3');
		expect(model?.providerID).toBe('minimax');
		expect(model).not.toHaveProperty('modelID', 'unknown');
	});

	test('omits identity fields when the v2 event has no model ref', async () => {
		const captured: CapturedSystemInput[] = [];
		const directory = canonicalMkdtemp('swarm-v2-model-missing-');
		const event = minimalContextEvent(undefined);

		await onV2ContextEvent(
			event,
			captureSystemTransformHooks(captured),
			directory,
		);

		expect(captured.length).toBe(1);
		const model = captured[0]?.model as Record<string, unknown> | undefined;
		expect(model?.modelID).toBeUndefined();
		expect(model?.providerID).toBeUndefined();
		expect(model?.id).toBeUndefined();
	});
});
