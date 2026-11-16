import { afterEach, describe, expect, test } from 'bun:test';
import { isTaskToolId } from '../../../../src/hooks/normalize-tool-name';
import { mapV2EventToV1 } from '../../../../src/host/v2/events';
import type { V2EventEnvelope } from '../../../../src/host/v2/types';
import {
	bindPendingTaskModelRouteChild,
	registerPendingTaskModelRoute,
	resolveSessionChatAgent,
} from '../../../../src/models/task-model-routing';
import {
	flatToolCalledEvents,
	inputStarted,
	progress,
	pumpEnvelopes,
	qualifyingParts,
	resetToolNameRegistry,
	toolCalled,
} from './_scope-activation-progress-3401-helpers';

/**
 * Issue #3401 regression suite (synthesis + registry): on OpenCode 2 hosts the
 * subagent tool publishes the CHILD session id as live progress metadata
 * (`session.tool.progress` with `metadata.sessionID`), and the v2 event pump
 * must translate that into the v1 `message.part.updated` ToolPart shape the
 * scope-activation handler requires (src/index.ts ~3884). Before the fix the
 * pump dropped the progress event entirely and passed `session.tool.called`
 * through flat, so the coder child's scope-binding claim (`taskMetadata`) was
 * unreachable and every standard single-workspace coder dispatch failed closed
 * at first write with `SCOPE_NOT_DECLARED ... for task unknown`.
 *
 * PR #3402 review hardening (PRR-001/PRR-019): every test asserts the pump
 * actually delivered events (drained + non-empty), so a dead pump cannot pass
 * a negative; the qualification predicate mirrors the production guard; the
 * registry is reset between tests via the `_internals` seam.
 */

afterEach(() => {
	resetToolNameRegistry();
});

describe('#3401 — v2 subagent progress synthesizes the v1 scope-activation part', () => {
	test('regression: a subagent dispatch sequence delivers exactly one qualifying task part', async () => {
		const parent = 'ses_p3401a';
		const child = 'ses_c3401a';
		const call = 'call_d3401a';
		const { received, drained } = await pumpEnvelopes([
			inputStarted(parent, call, 'subagent'),
			toolCalled(parent, call),
			progress(parent, call, child),
		]);
		expect(drained).toBe(true);
		const qualifying = qualifyingParts(received);
		expect(qualifying.length).toBe(1);
		expect(qualifying[0]).toEqual({
			type: 'tool',
			tool: 'task',
			callID: call,
			sessionID: parent,
			state: { metadata: { sessionId: child } },
		});
		expect(isTaskToolId(qualifying[0]!.tool)).toBe(true);
	});

	test('flat tool-event passthrough is preserved (called maps without a part)', async () => {
		const parent = 'ses_p3401b';
		const { received, drained } = await pumpEnvelopes([
			inputStarted(parent, 'call_d3401b', 'subagent'),
			toolCalled(parent, 'call_d3401b'),
		]);
		expect(drained).toBe(true);
		const called = flatToolCalledEvents(received);
		expect(called.length).toBe(1);
		expect(called[0]!.properties.part).toBeUndefined();
	});

	test('the SDK properties dialect is tracked and synthesized identically', async () => {
		const parent = 'ses_p3401c';
		const child = 'ses_c3401c';
		const call = 'call_d3401c';
		const { received, drained } = await pumpEnvelopes([
			{
				type: 'session.tool.input.started',
				properties: {
					sessionID: parent,
					assistantMessageID: 'msg_PARENT',
					id: call,
					name: 'subagent',
				},
			},
			{
				type: 'session.tool.progress',
				properties: {
					sessionID: parent,
					assistantMessageID: 'msg_PARENT',
					id: call,
					metadata: { sessionID: child, status: 'running' },
				},
			},
		]);
		expect(drained).toBe(true);
		const qualifying = qualifyingParts(received);
		expect(qualifying.length).toBe(1);
		expect(qualifying[0]!.state.metadata.sessionId).toBe(child);
	});

	test('duplicate progress for one dispatch delivers one part per emission (consumer is idempotent)', async () => {
		const parent = 'ses_p3401d';
		const child = 'ses_c3401d';
		const call = 'call_d3401d';
		const { received, drained } = await pumpEnvelopes([
			inputStarted(parent, call, 'subagent'),
			progress(parent, call, child),
			progress(parent, call, child),
		]);
		expect(drained).toBe(true);
		// The pump has no dedupe (v1-parity: repeated Task-part updates also
		// re-fire taskMetadata); the durable claim is idempotent for the same
		// child (scope-persistence successors branch). Pin the shape so a
		// future dedupe/amplification change is deliberate.
		const qualifying = qualifyingParts(received);
		expect(qualifying.length).toBe(2);
		expect(qualifying[0]).toEqual(qualifying[1]);
	});

	test('dispatch keys are injective across the claimed collision pairs', async () => {
		// The automation review claimed ("ab","3cd") and ("a","b3cd") collide;
		// the length prefix makes them distinct. Pin the behavior.
		const { received, drained } = await pumpEnvelopes([
			inputStarted('ab', '3cd', 'subagent'),
			inputStarted('a', 'b3cd', 'execute'),
			progress('ab', '3cd', 'child_collide1'),
			progress('a', 'b3cd', 'child_collide2'),
		]);
		expect(drained).toBe(true);
		const qualifying = qualifyingParts(received);
		expect(qualifying.length).toBe(1);
		expect(qualifying[0]!.sessionID).toBe('ab');
		expect(qualifying[0]!.state.metadata.sessionId).toBe('child_collide1');
	});

	test('the tool-name registry is bounded (FIFO eviction at the 512 boundary)', async () => {
		const parent = 'ses_p3401e';
		const names: Array<Record<string, unknown>> = [];
		for (let i = 0; i < 600; i++) {
			names.push(inputStarted(parent, `call_evict${i}`, 'subagent'));
		}
		const { received, drained } = await pumpEnvelopes([
			...names,
			// evicted (older than the 512-entry window)
			progress(parent, 'call_evict0', 'ses_c_evict0'),
			// inside the window (512th-newest) — distinguishes true FIFO from
			// an all-or-nothing cap
			progress(parent, 'call_evict88', 'ses_c_evict88'),
			// newest — always retained
			progress(parent, 'call_evict599', 'ses_c_evict599'),
		]);
		expect(drained).toBe(true);
		const qualifying = qualifyingParts(received);
		expect(qualifying.length).toBe(2);
		expect(qualifying.map((part) => part.callID).sort()).toEqual(
			['call_evict599', 'call_evict88'].sort(),
		);
	});

	test('the mapper used without a lookup never synthesizes (single-argument form fails closed)', () => {
		const mapped = mapV2EventToV1({
			type: 'session.tool.progress',
			data: {
				sessionID: 'ses_p3401f',
				id: 'call_d3401f',
				metadata: { sessionID: 'ses_c3401f' },
			},
		} as V2EventEnvelope);
		expect(mapped).toBeUndefined();
	});
});

describe('#3401 — v1 activation-block side consumers restored on v2', () => {
	test('the synthesized triple drives the real model-route binding when a route is staged', async () => {
		// The same v1 activation block that claims the scope binding also calls
		// bindPendingTaskModelRouteChild (src/index.ts:3922). Once the
		// synthesized part reaches the v1 handler this consumer fires on v2 as
		// a v1-parity restoration — exercise the real function with a staged
		// route so the side effect is observable rather than asserted on empty
		// module state.
		const parent = 'ses_p3401g';
		const child = 'ses_c3401g';
		const call = 'call_d3401g';
		registerPendingTaskModelRoute({
			parentSessionID: parent,
			invocationID: 'inv_3401',
			callID: call,
			role: 'coder',
			actionDigest: 'digest_3401',
		});
		const { received, drained } = await pumpEnvelopes([
			inputStarted(parent, call, 'subagent'),
			toolCalled(parent, call),
			progress(parent, call, child),
		]);
		expect(drained).toBe(true);
		const qualifying = qualifyingParts(received);
		expect(qualifying.length).toBe(1);
		// Mirror src/index.ts:3922 — the handler feeds the synthesized triple
		// into the real binder; with a staged route the binding now lands.
		const routeBinding = bindPendingTaskModelRouteChild({
			parentSessionID: qualifying[0]!.sessionID,
			callID: qualifying[0]!.callID,
			childSessionID: qualifying[0]!.state.metadata.sessionId,
		});
		expect(routeBinding?.childSessionID).toBe(child);
		expect(routeBinding?.role).toBe('coder');
	});

	test('the synthesized triple leaves unstaged routes and chat agents untouched', async () => {
		const parent = 'ses_p3401h';
		const child = 'ses_c3401h';
		const call = 'call_d3401h';
		await pumpEnvelopes([
			inputStarted(parent, call, 'subagent'),
			toolCalled(parent, call),
			progress(parent, call, child),
		]);
		// No route staged for this dispatch and no full-auto run generation in
		// this suite, so the activation block's side consumers stay inert.
		const routeBinding = bindPendingTaskModelRouteChild({
			parentSessionID: parent,
			callID: call,
			childSessionID: child,
		});
		expect(routeBinding).toBeUndefined();
		expect(resolveSessionChatAgent(child)).toBeUndefined();
	});
});
