/**
 * Shared harness for the issue #3401 v2 scope-activation suites
 * (PR #3402). Lives beside the two test files that consume it:
 *   - scope-activation-progress-3401.test.ts       (synthesis + registry)
 *   - scope-activation-progress-gating-3401.test.ts (fail-closed negatives)
 *
 * Fixtures mirror the live capture (host 2.0.29; shapes identical at the
 * v2.0.32 tag — see the 3401 trace's 02-reproduction.md). No mocks: the real
 * pump and real modules.
 */

import { isTaskToolId } from '../../../../src/hooks/normalize-tool-name';
import {
	_internals,
	startDeferredEventPump,
} from '../../../../src/host/v2/events';

export interface DeliveredEvent {
	type: string;
	properties: Record<string, unknown>;
}

export interface QualifyingPart {
	type: 'tool';
	tool: string;
	callID: string;
	sessionID: string;
	state: { metadata: { sessionId: string } };
}

/** Isolate the module-level tool-name registry between tests (AGENTS.md
 * invariant 7/8; PR #3402 review PRR-019). */
export function resetToolNameRegistry(): void {
	_internals.clearToolNameRegistry();
}

export function inputStarted(sessionID: string, callID: string, name: string) {
	return {
		type: 'session.tool.input.started',
		data: { sessionID, assistantMessageID: 'msg_PARENT', id: callID, name },
	};
}

export function toolCalled(sessionID: string, callID: string) {
	return {
		type: 'session.tool.called',
		data: {
			sessionID,
			assistantMessageID: 'msg_PARENT',
			id: callID,
			input: { agent: 'coder', description: 'task 2.1', prompt: 'FILE: x' },
			executed: false,
		},
	};
}

export function progress(
	sessionID: string,
	callID: string,
	childSessionID: string,
) {
	return {
		type: 'session.tool.progress',
		data: {
			sessionID,
			assistantMessageID: 'msg_PARENT',
			id: callID,
			metadata: { sessionID: childSessionID, status: 'running' },
		},
	};
}

/** Drives the real detached pump over a finite envelope list and collects
 * everything it delivered to the (fake) v1 event handler. `drained` proves the
 * generator finished, so an empty result is a real negative rather than a
 * starved pump. */
export async function pumpEnvelopes(
	envelopes: Array<Record<string, unknown>>,
): Promise<{ received: DeliveredEvent[]; drained: boolean }> {
	const received: DeliveredEvent[] = [];
	const hooks = {
		event: async (input: { event: DeliveredEvent }): Promise<void> => {
			received.push(input.event);
		},
	};
	let drained = false;
	async function* gen(): AsyncGenerator<Record<string, unknown>> {
		for (const envelope of envelopes) yield envelope;
		drained = true;
	}
	const ctx = { event: { subscribe: async () => gen() } };
	const stop = startDeferredEventPump(
		ctx as never,
		hooks as unknown as Parameters<typeof startDeferredEventPump>[1],
	);
	const deadline = performance.now() + 5_000;
	while (performance.now() < deadline && !drained) {
		await Bun.sleep(25);
	}
	// The pump awaits each dispatch sequentially; let the last one settle.
	await Bun.sleep(150);
	stop();
	return { received, drained };
}

/** Every RAW tool part the pump delivered (no production-guard filtering).
 * Negative assertions use this so a guard deletion shows up as a delivered
 * part rather than being masked by the test's own predicate copy. */
export function deliveredParts(
	events: DeliveredEvent[],
): Array<Record<string, unknown>> {
	const parts: Array<Record<string, unknown>> = [];
	for (const event of events) {
		if (event.type !== 'message.part.updated') continue;
		const part = event.properties.part as Record<string, unknown> | undefined;
		if (part) parts.push(part);
	}
	return parts;
}

/** Delivered events carrying a qualifying task part, evaluated with the
 * production guard's predicate (src/index.ts ~3898-3916: part.type,
 * isTaskToolId, callID/sessionID/metadata.sessionId with trim checks,
 * parent ≠ child). */
export function qualifyingParts(events: DeliveredEvent[]): QualifyingPart[] {
	const qualifying: QualifyingPart[] = [];
	for (const event of events) {
		if (event.type !== 'message.part.updated') continue;
		const part = event.properties.part as Record<string, unknown> | undefined;
		if (!part || part.type !== 'tool' || typeof part.tool !== 'string') {
			continue;
		}
		if (!isTaskToolId(part.tool)) continue;
		const metadata = (part.state as Record<string, unknown> | undefined)
			?.metadata as Record<string, unknown> | undefined;
		if (
			typeof part.callID !== 'string' ||
			part.callID.trim() === '' ||
			typeof part.sessionID !== 'string' ||
			part.sessionID.trim() === '' ||
			typeof metadata?.sessionId !== 'string' ||
			metadata.sessionId.trim() === ''
		) {
			continue;
		}
		if (part.sessionID === metadata.sessionId) continue;
		qualifying.push({
			type: 'tool',
			tool: part.tool,
			callID: part.callID,
			sessionID: part.sessionID,
			state: { metadata: { sessionId: metadata.sessionId } },
		});
	}
	return qualifying;
}

/** Delivered `message.part.updated` events whose payload is the flat
 * tool-called passthrough (carries `input`, no `part`). */
export function flatToolCalledEvents(
	events: DeliveredEvent[],
): DeliveredEvent[] {
	return events.filter(
		(event) =>
			event.type === 'message.part.updated' &&
			(event.properties as { input?: unknown }).input !== undefined,
	);
}

/**
 * Differential negative helper (PR #3402 review PRR-001): a lone "nothing
 * synthesized" assertion passes vacuously when the pump delivers nothing at
 * all. Run the NEGATIVE sequence and a POSITIVE control through the same
 * harness and require the control to deliver exactly one qualifying part —
 * proving the harness, registry and gate are all live — while the negative
 * delivers none.
 */
export async function expectDropsVsControl(
	negative: Array<Record<string, unknown>>,
	control: Array<Record<string, unknown>>,
): Promise<void> {
	const negativeRun = await pumpEnvelopes(negative);
	expect(negativeRun.drained).toBe(true);
	const controlRun = await pumpEnvelopes(control);
	expect(controlRun.drained).toBe(true);
	expect(qualifyingParts(controlRun.received).length).toBe(1);
	// Raw-part assertion (not predicate-filtered): a deleted production guard
	// delivers a part the predicate copy would still reject, which would mask
	// the mutation.
	expect(deliveredParts(negativeRun.received).length).toBe(0);
	expect(qualifyingParts(negativeRun.received).length).toBe(0);
}
