import { describe, expect, test } from 'bun:test';
import {
	mapV2EventToV1,
	seedSessionIdentityFromEnvelope,
} from '../../../../src/host/v2/events';
import { resolveSessionChatAgent } from '../../../../src/models/task-model-routing';

/**
 * Issue #3022 — v2 event dialect mapping + identity seeding.
 *
 * Live capture (d3/run1.log, @opencode/cli 2.0.21): the plugin stream emits
 * `{type, data}` envelopes with `session.execution.failed` as the error name.
 * The @opencode-ai/sdk SSE/REST dialect names it `session.error` with the
 * payload under `properties`. Both must map to the v1 `session.error` arm with
 * the sessionID preserved. `session.status` maps TYPE-PRESERVING (never into
 * the `session.idle` arm) so live busy/retry transitions cannot terminalize a
 * running session through the v1 handler's unconditional idle path.
 */
describe('#3022 v2 event mapping', () => {
	test('session.error (SDK dialect, properties payload) maps to v1 session.error with sessionID', () => {
		const mapped = mapV2EventToV1({
			type: 'session.error',
			properties: { sessionID: 's1', error: 'Model unavailable: opencode/x' },
		});
		expect(mapped?.type).toBe('session.error');
		expect(mapped?.properties.sessionID).toBe('s1');
	});

	test('session.error (live dialect, data payload) maps with the error payload intact', () => {
		const mapped = mapV2EventToV1({
			type: 'session.error',
			data: {
				sessionID: 's2',
				error: {
					type: 'provider.no-route',
					message: 'Model unavailable: opencode/minimax-m2.5-free',
				},
			},
		});
		expect(mapped?.type).toBe('session.error');
		expect(mapped?.properties.sessionID).toBe('s2');
		const error = mapped?.properties.error as { message?: string };
		expect(error.message).toContain('Model unavailable');
	});

	test('session.execution.failed (live name) still maps to v1 session.error', () => {
		const mapped = mapV2EventToV1({
			type: 'session.execution.failed',
			data: {
				sessionID: 's3',
				error: { message: 'Model unavailable: opencode/gpt-5-nano' },
			},
		});
		expect(mapped?.type).toBe('session.error');
		expect(mapped?.properties.sessionID).toBe('s3');
	});

	test('session.status maps TYPE-PRESERVING to v1 session.status (never session.idle)', () => {
		for (const status of [
			{ type: 'busy' },
			{ type: 'retry' },
			{ type: 'idle' },
		]) {
			const mapped = mapV2EventToV1({
				type: 'session.status',
				data: { sessionID: 's4', status },
			});
			// The v1 handler treats session.status as terminal ONLY when
			// status.type is idle|error (src/index.ts isTerminalSessionEvent);
			// mapping into session.idle would terminalize busy/retry unconditionally.
			expect(mapped?.type).toBe('session.status');
			expect(mapped?.properties.status).toEqual(status);
		}
	});

	// Type-preserving since the PR 3922 native-async work: the legacy name no
	// longer terminalizes through session.idle (busy/retry must not run terminal
	// cleanup). No captured or vendored host emits session.status.updated.
	test('legacy session.status.updated maps type-preserving to session.status', () => {
		const mapped = mapV2EventToV1({
			type: 'session.status.updated',
			data: { sessionID: 's5' },
		});
		expect(mapped?.type).toBe('session.status');
	});

	test('unknown event types remain unmapped', () => {
		expect(
			mapV2EventToV1({ type: 'session.agent.selected', data: {} }),
		).toBeUndefined();
		expect(
			mapV2EventToV1({ type: 'totally.unknown', data: {} }),
		).toBeUndefined();
		expect(mapV2EventToV1({})).toBeUndefined();
	});
});

describe('#3022 pump-side identity seeding', () => {
	test('session.created with data.agent seeds the session-chat-agent map', () => {
		seedSessionIdentityFromEnvelope({
			type: 'session.created',
			data: { sessionID: 'seed-1', agent: 'local_coder' },
		});
		expect(resolveSessionChatAgent('seed-1')).toBe('local_coder');
	});

	test('session.agent.selected with properties payload seeds too', () => {
		seedSessionIdentityFromEnvelope({
			type: 'session.agent.selected',
			properties: { sessionID: 'seed-2', agent: 'coder' },
		});
		expect(resolveSessionChatAgent('seed-2')).toBe('coder');
	});

	test('other event types and malformed payloads do not seed', () => {
		seedSessionIdentityFromEnvelope({
			type: 'session.idle',
			data: { sessionID: 'seed-3', agent: 'should-not-seed' },
		});
		seedSessionIdentityFromEnvelope({
			type: 'session.created',
			data: { sessionID: 42, agent: 'coder' },
		});
		seedSessionIdentityFromEnvelope({ type: 'session.created', data: {} });
		expect(resolveSessionChatAgent('seed-3')).toBeUndefined();
	});
});
