import { afterEach, describe, expect, test } from 'bun:test';
import {
	deliveredParts,
	expectDropsVsControl,
	flatToolCalledEvents,
	inputStarted,
	progress,
	pumpEnvelopes,
	qualifyingParts,
	resetToolNameRegistry,
	toolCalled,
} from './_scope-activation-progress-3401-helpers';

/**
 * Issue #3401 fail-closed gating suite (PR #3402 review PRR-001 / repo
 * Directive 2): every branch of the new `session.tool.progress` gate in
 * src/host/v2/events.ts must be executed by a test, and every negative is
 * asserted DIFFERENTIALLY against a positive control in the same harness —
 * a lone "nothing synthesized" assertion passes vacuously when the pump
 * delivers nothing at all (the defect this suite layout fixes).
 */

afterEach(() => {
	resetToolNameRegistry();
});

const PARENT = 'ses_g3401';

describe('#3401 — non-subagent and untracked tool names fail closed', () => {
	test('a non-subagent tool name never synthesizes a task part', async () => {
		const call = 'call_g_nonagent';
		await expectDropsVsControl(
			[
				inputStarted(PARENT, call, 'execute'),
				toolCalled(PARENT, call),
				progress(PARENT, call, 'ses_c_nonagent'),
			],
			[
				inputStarted(PARENT, call, 'subagent'),
				toolCalled(PARENT, call),
				progress(PARENT, call, 'ses_c_nonagent'),
			],
		);
	});

	test('an untracked tool name (no input.started observed) fails closed', async () => {
		const call = 'call_g_untracked';
		await expectDropsVsControl(
			[toolCalled(PARENT, call), progress(PARENT, call, 'ses_c_untracked')],
			[
				inputStarted(PARENT, call, 'subagent'),
				toolCalled(PARENT, call),
				progress(PARENT, call, 'ses_c_untracked'),
			],
		);
	});

	test('a self-referencing child id (child === parent) is rejected', async () => {
		const call = 'call_g_selfref';
		await expectDropsVsControl(
			[inputStarted(PARENT, call, 'subagent'), progress(PARENT, call, PARENT)],
			[
				inputStarted(PARENT, call, 'subagent'),
				progress(PARENT, call, 'ses_c_selfref'),
			],
		);
	});

	test('a namespaced/dotted subagent tool id is recognized (v1 name-mapping parity)', async () => {
		// isV2SubagentToolId accepts `tool.<seg>.subagent` — the documented
		// #2529/#3169 name-mapping policy; pin that the gate honors it.
		const call = 'call_g_dotted';
		const { received, drained } = await pumpEnvelopes([
			inputStarted(PARENT, call, 'tool.plugin.subagent'),
			progress(PARENT, call, 'ses_c_dotted'),
		]);
		expect(drained).toBe(true);
		expect(qualifyingParts(received).length).toBe(1);
	});
});

describe('#3401 — malformed progress payloads fail closed', () => {
	const cases: Array<{
		name: string;
		call: string;
		envelope: Record<string, unknown>;
	}> = [
		{
			name: 'missing call id',
			call: 'call_g_mal0',
			envelope: {
				type: 'session.tool.progress',
				data: { sessionID: PARENT, metadata: { sessionID: 'ses_c_mal0' } },
			},
		},
		{
			name: 'empty child id',
			call: 'call_g_mal1',
			envelope: {
				type: 'session.tool.progress',
				data: {
					sessionID: PARENT,
					id: 'call_g_mal1',
					metadata: { sessionID: '' },
				},
			},
		},
		{
			name: 'non-string child id',
			call: 'call_g_mal2',
			envelope: {
				type: 'session.tool.progress',
				data: {
					sessionID: PARENT,
					id: 'call_g_mal2',
					metadata: { sessionID: 42 },
				},
			},
		},
		{
			name: 'array metadata (isPlainObject gate)',
			call: 'call_g_mal3',
			envelope: {
				type: 'session.tool.progress',
				data: { sessionID: PARENT, id: 'call_g_mal3', metadata: ['ses_c_arr'] },
			},
		},
		{
			name: 'null metadata',
			call: 'call_g_mal4',
			envelope: {
				type: 'session.tool.progress',
				data: { sessionID: PARENT, id: 'call_g_mal4', metadata: null },
			},
		},
		{
			name: 'non-string parent session id',
			call: 'call_g_mal5',
			envelope: {
				type: 'session.tool.progress',
				data: {
					sessionID: 7,
					id: 'call_g_mal5',
					metadata: { sessionID: 'ses_c_mal5' },
				},
			},
		},
		{
			name: 'over-long child id (bounded-id cap)',
			call: 'call_g_mal6',
			envelope: {
				type: 'session.tool.progress',
				data: {
					sessionID: PARENT,
					id: 'call_g_mal6',
					metadata: { sessionID: 'x'.repeat(257) },
				},
			},
		},
		// (the bounded tool-NAME cap is exercised by its own test below — it
		// needs a long name registered on input.started, not a progress
		// envelope)
	];

	for (const testCase of cases) {
		test(`${testCase.name} drops the progress event`, async () => {
			await expectDropsVsControl(
				[inputStarted(PARENT, testCase.call, 'subagent'), testCase.envelope],
				[
					inputStarted(PARENT, testCase.call, 'subagent'),
					progress(PARENT, testCase.call, 'ses_c_control'),
				],
			);
		});
	}

	test('an over-long tool name is never recorded (name cap, control qualifies)', async () => {
		const call = 'call_g_longname';
		// A VALID subagent id (dotted form passes isV2SubagentToolId) whose only
		// disqualifying property is length — isolates the 256-char name cap.
		const longName = `tool.${'x'.repeat(300)}.subagent`;
		const boundedName = `tool.${'y'.repeat(50)}.subagent`;
		const { received, drained } = await pumpEnvelopes([
			inputStarted(PARENT, call, longName),
			progress(PARENT, call, 'ses_c_longname'),
		]);
		expect(drained).toBe(true);
		expect(deliveredParts(received).length).toBe(0);
		// The same call with a bounded (still dotted) name qualifies — the drop
		// was the name cap, not a dead harness.
		await resetToolNameRegistry();
		const control = await pumpEnvelopes([
			inputStarted(PARENT, call, boundedName),
			progress(PARENT, call, 'ses_c_longname'),
		]);
		expect(deliveredParts(control.received).length).toBe(1);
	});

	test('an array metadata with an attached sessionID is rejected by the isPlainObject gate', async () => {
		// An array with a `sessionID` property attached reads through a bare
		// `typeof === 'object'` check; only isPlainObject rejects it.
		const call = 'call_g_arrprop';
		const arrayMetadata = ['ses_c_arr'];
		(arrayMetadata as unknown as Record<string, unknown>).sessionID =
			'ses_c_arrprop';
		const { received, drained } = await pumpEnvelopes([
			inputStarted(PARENT, call, 'subagent'),
			{
				type: 'session.tool.progress',
				data: { sessionID: PARENT, id: call, metadata: arrayMetadata },
			},
		]);
		expect(drained).toBe(true);
		expect(deliveredParts(received).length).toBe(0);
		await resetToolNameRegistry();
		const control = await pumpEnvelopes([
			inputStarted(PARENT, call, 'subagent'),
			progress(PARENT, call, 'ses_c_arrprop'),
		]);
		expect(deliveredParts(control.received).length).toBe(1);
	});
});

describe('#3401 — hostile payload shapes cannot kill the pump', () => {
	test('a throwing metadata accessor is contained and the pump keeps dispatching', async () => {
		const call = 'call_g_thr';
		const hostile = {
			type: 'session.tool.progress',
			data: {
				sessionID: PARENT,
				id: call,
				metadata: {
					get sessionID(): string {
						throw new Error('boom');
					},
				},
			},
		};
		const { received, drained } = await pumpEnvelopes([
			inputStarted(PARENT, call, 'subagent'),
			hostile,
			toolCalled(PARENT, 'call_g_after'),
		]);
		expect(drained).toBe(true);
		expect(deliveredParts(received).length).toBe(0);
		// The pump survived the hostile envelope and kept dispatching.
		expect(flatToolCalledEvents(received).length).toBe(1);
	});

	test('a throwing metadata PROPERTY accessor is contained and the pump keeps dispatching', async () => {
		// The `data.metadata` read itself is inside the guarded helper's try —
		// a throwing getter on the property must not escape into the pump loop.
		const call = 'call_g_thrmeta';
		const hostile = {
			type: 'session.tool.progress',
			data: {
				sessionID: PARENT,
				id: call,
				get metadata(): Record<string, unknown> {
					throw new Error('boom');
				},
			},
		};
		const { received, drained } = await pumpEnvelopes([
			inputStarted(PARENT, call, 'subagent'),
			hostile,
			toolCalled(PARENT, 'call_g_after'),
		]);
		expect(drained).toBe(true);
		expect(deliveredParts(received).length).toBe(0);
		expect(flatToolCalledEvents(received).length).toBe(1);
	});

	test('whitespace-only ids never synthesize (end-to-end fail-closed)', async () => {
		// End-to-end property: no part is delivered for whitespace parent/call/
		// child ids. Layer attribution: the CHILD case isolates the progress
		// gate's own trim check (nothing else sees metadata.sessionID); the
		// PARENT and CALL cases are also rejected at store time
		// (rememberToolNameFromEnvelope bounds the registry key), so those two
		// assert the composed behavior rather than one layer.
		const variants: Array<{ call: string; envelope: Record<string, unknown> }> =
			[
				{
					call: 'call_g_wsparent',
					envelope: {
						type: 'session.tool.progress',
						data: {
							sessionID: '   ',
							id: 'call_g_wsparent',
							metadata: { sessionID: 'ses_c_wsp' },
						},
					},
				},
				{
					call: 'call_g_wscall',
					envelope: {
						type: 'session.tool.progress',
						data: {
							sessionID: PARENT,
							id: '  ',
							metadata: { sessionID: 'ses_c_wsc' },
						},
					},
				},
				{
					call: 'call_g_wschild',
					envelope: {
						type: 'session.tool.progress',
						data: {
							sessionID: PARENT,
							id: 'call_g_wschild',
							metadata: { sessionID: ' \t ' },
						},
					},
				},
			];
		for (const variant of variants) {
			await resetToolNameRegistry();
			await expectDropsVsControl(
				[inputStarted(PARENT, variant.call, 'subagent'), variant.envelope],
				[
					inputStarted(PARENT, variant.call, 'subagent'),
					progress(PARENT, variant.call, 'ses_c_control'),
				],
			);
		}
	});
});
