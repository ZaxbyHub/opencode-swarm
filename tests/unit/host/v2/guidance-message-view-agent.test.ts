/**
 * Issue #3320 AC4 — v1 message views must carry the native agent identity.
 *
 * `onV2ContextEvent` seeds identity from `event.agent` (an Agent.Info object,
 * e.g. `{ id: 'plan' }`), but `toV1MessageView` (src/host/v2/guidance.ts)
 * builds views whose `info` carries ONLY `{ id, role, sessionID }` — the
 * `agent` field is dropped. Downstream v1-chain stages key exclusively on
 * `info.agent` (pipeline-tracker.ts, delegation-gate.ts messagesTransform),
 * so on v2 a `plan`/`build` session is indistinguishable from the architect
 * main session and receives architect-only injections every step.
 *
 * Expected behavior: the translated USER view's `info` includes
 * `agent: '<Agent.Info.id>'` when the event carries an agent; a view for an
 * agent-less event carries NO agent stamp (selective stamping — the main
 * session must keep its identity-absent semantics). ASSISTANT views carry NO
 * agent stamp: the v1 SDK shape carries `agent` on UserMessage only, and an
 * assistant-side stamp made the role-unfiltered consumers
 * (delegation-sanitizer, knowledge-application-gate, skill-propagation-gate)
 * match the session agent's own assistant output (PR #3376 review, PRR-011).
 *
 * RED at base, GREEN after the fix: the first test fails at base because
 * `info.agent` is undefined. The second and third tests (negative controls)
 * pass at base and must KEEP passing after the fix.
 *
 * CHECK_WRONG AMEND history (PR #3376 review round): the file originally
 * pinned assistant-view stamping as well; the review proved that stamp harmful
 * (v1 SDK schema fidelity + role-unfiltered scanner self-matching), so the
 * third test now pins assistant-view ABSENCE. AC4's normative text binds
 * USER-role views only, so the discriminating signature (user view
 * `Received: undefined` at base) is unchanged.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { onV2ContextEvent } from '../../../../src/host/v2/guidance';
import type {
	V1HooksSubset,
	V2SessionContextEvent,
} from '../../../../src/host/v2/types';
import { resetSwarmState } from '../../../../src/state';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

/** The v1 view shape the messages chain receives (see toV1MessageView). */
interface CapturedView {
	info: {
		id?: string;
		role?: string;
		sessionID?: string;
		agent?: string;
		[key: string]: unknown;
	};
	parts: Array<{ type: string; text?: string }>;
}

/**
 * Stub hooks whose messages transform CAPTURES the views array it receives
 * without mutating it (the in-place mutation contract only binds producers
 * that rewrite content — capture-only observers may leave output untouched).
 */
function captureViewsHooks(views: CapturedView[]): V1HooksSubset {
	return {
		'experimental.chat.messages.transform': async (
			_input: unknown,
			output: { messages?: CapturedView[] },
		) => {
			views.push(...(output.messages ?? []));
		},
	} as unknown as V1HooksSubset;
}

function contextEvent(
	agent: V2SessionContextEvent['agent'],
	sessionID: string,
): V2SessionContextEvent {
	return {
		sessionID,
		agent,
		system: [],
		messages: [
			{
				id: 'm-user',
				role: 'user',
				content: [{ type: 'text', text: 'continue' }],
			},
			{
				id: 'm-assistant',
				role: 'assistant',
				content: [{ type: 'text', text: 'ack' }],
			},
		],
		options: {},
		tools: {},
	};
}

afterEach(() => {
	resetSwarmState();
});

describe('issue #3320 AC4 — v1 message views carry the native agent identity', () => {
	test('RED at base, GREEN after the fix — the USER view info is stamped with agent "plan" from event.agent.id', async () => {
		const views: CapturedView[] = [];
		const directory = canonicalMkdtemp('swarm-3320-view-agent-');
		const event = contextEvent({ id: 'plan' }, 'view-agent-plan-session');

		await onV2ContextEvent(
			event as never,
			captureViewsHooks(views) as never,
			directory,
		);

		expect(views.length).toBe(2);
		const userView = views.find((view) => view.info.role === 'user');
		expect(userView).toBeDefined();
		// Base defect: toV1MessageView builds info with only
		// { id, role, sessionID } — agent is dropped, so the v1 chain treats
		// this plan turn as the architect main session.
		expect(userView?.info.agent).toBe('plan');
	});

	test('negative control (passes at base AND after the fix) — an agent-less event produces a view with NO agent stamp', async () => {
		const views: CapturedView[] = [];
		const directory = canonicalMkdtemp('swarm-3320-view-noagent-');
		const event = contextEvent(undefined, 'view-agent-none-session');

		await onV2ContextEvent(
			event as never,
			captureViewsHooks(views) as never,
			directory,
		);

		expect(views.length).toBe(2);
		const userView = views.find((view) => view.info.role === 'user');
		expect(userView).toBeDefined();
		// The stamp must be SELECTIVE: an event with no agent (the v2 main
		// session) must not receive a fabricated agent identity — the
		// identity-absent semantics of the main session must be preserved.
		expect(userView?.info.agent).toBeUndefined();
	});

	test('AMENDED (CHECK_WRONG, PR #3376 review PRR-011) — the ASSISTANT view carries NO agent stamp (v1 SDK schema fidelity: agent is UserMessage-only)', async () => {
		const views: CapturedView[] = [];
		const directory = canonicalMkdtemp('swarm-3320-view-assistant-');
		const event = contextEvent({ id: 'build' }, 'view-agent-build-session');

		await onV2ContextEvent(
			event as never,
			captureViewsHooks(views) as never,
			directory,
		);

		const assistantView = views.find((view) => view.info.role === 'assistant');
		expect(assistantView).toBeDefined();
		// GREEN at base and at head: only USER views carry the session agent.
		// The prior version of this test pinned the OPPOSITE (assistant views
		// stamped with 'build'), which let role-unfiltered consumers match the
		// session agent's own assistant output on v2.
		expect(assistantView?.info.agent).toBeUndefined();
	});
});
